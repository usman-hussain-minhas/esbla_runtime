import type { HrServiceControl } from "@esbla/contracts/hr-service-control-api";
import { describe, expect, it } from "vitest";
import {
  decodeWorkforceServiceControlApiResponse,
  decodeWorkforceServiceControlTransport,
  validateWorkforceServiceControlAction,
  WorkforceServiceControlUiError,
  workforceServiceControlStateForError,
} from "./hr-workforce-service-control-core";

const idempotencyKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const control: HrServiceControl = {
  activationState: "active",
  activationVersion: 2,
  serviceKey: "workforce_profile",
  settings: {
    employeeNumberRequired: false,
    managerVisibility: "minimized",
    unlinkedWorkerCreationAllowed: true,
  },
  settingsVersion: 3,
  updatedAt: "2026-07-22T09:00:00.000Z",
  version: 4,
};

function response(
  body: unknown,
  status = 200,
  contentType = "application/json",
  replay: string | null = null,
) {
  const headers = new Headers({ "content-type": contentType });
  if (replay !== null) headers.set("idempotent-replayed", replay);
  return new Response(JSON.stringify(body), { headers, status });
}

function problem(code: string, status: number) {
  return {
    code,
    detail: "Private upstream detail must never reach the rendered state.",
    instance: "/v1/hr/workforce-profiles/service-control",
    requestId: "request-1",
    status,
    title: status === 403 ? "Forbidden" : "Failure",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

describe("Workforce Profile rendered service-control core", () => {
  it("accepts only exact, bounded lifecycle and full-replacement settings actions", () => {
    expect(
      validateWorkforceServiceControlAction({
        expectedVersion: null,
        idempotencyKey,
        operation: "activate",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateWorkforceServiceControlAction({
        expectedVersion: 2,
        idempotencyKey,
        operation: "deactivate",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateWorkforceServiceControlAction({
        employeeNumberRequired: true,
        expectedSettingsVersion: 3,
        idempotencyKey,
        managerVisibility: "none",
        operation: "configure",
        unlinkedWorkerCreationAllowed: false,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        body: {
          expectedSettingsVersion: 3,
          settings: {
            employeeNumberRequired: true,
            managerVisibility: "none",
            unlinkedWorkerCreationAllowed: false,
          },
        },
      },
    });

    for (const invalid of [
      null,
      { expectedVersion: 0, idempotencyKey, operation: "activate" },
      { expectedVersion: 2, extra: true, idempotencyKey, operation: "deactivate" },
      {
        employeeNumberRequired: true,
        expectedSettingsVersion: 2_147_483_648,
        idempotencyKey,
        managerVisibility: "none",
        operation: "configure",
        unlinkedWorkerCreationAllowed: true,
      },
      {
        employeeNumberRequired: true,
        expectedSettingsVersion: 3,
        idempotencyKey,
        managerVisibility: "full",
        operation: "configure",
        unlinkedWorkerCreationAllowed: true,
      },
    ]) {
      expect(validateWorkforceServiceControlAction(invalid)).toMatchObject({ ok: false });
    }
  });

  it("strictly decodes the current tenant-admin control and fixed problem states", async () => {
    await expect(
      decodeWorkforceServiceControlApiResponse(Promise.resolve(response(control)), {
        operation: "view",
      }),
    ).resolves.toEqual(control);

    for (const [code, status, kind] of [
      ["POLICY_DENIED", 403, "denied"],
      ["WORKFORCE_SERVICE_CONTROL_NOT_FOUND", 404, "not_found"],
      ["ACTIVATION_DEPENDENCY_BLOCKED", 503, "dependency_unavailable"],
      ["WORKFORCE_SERVICE_INACTIVE", 503, "inactive"],
    ] as const) {
      const error = await decodeWorkforceServiceControlApiResponse(
        Promise.resolve(response(problem(code, status), status, "application/problem+json")),
        { operation: "view" },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(workforceServiceControlStateForError(error).message).not.toContain("Private");
    }

    for (const invalid of [
      response(control, 200, "text/plain"),
      response(control, 200, "application/json", "false"),
      response({ ...control, serviceKey: "attendance", settings: {} }),
      response(problem("POLICY_DENIED", 503), 503, "application/problem+json"),
    ]) {
      await expect(
        decodeWorkforceServiceControlApiResponse(Promise.resolve(invalid), { operation: "view" }),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
  });

  it("binds successful settings and lifecycle responses to the exact prior control", async () => {
    const configure = validateWorkforceServiceControlAction({
      employeeNumberRequired: true,
      expectedSettingsVersion: 3,
      idempotencyKey,
      managerVisibility: "none",
      operation: "configure",
      unlinkedWorkerCreationAllowed: false,
    });
    expect(configure.ok).toBe(true);
    if (!configure.ok || configure.value.operation !== "configure") return;
    const configured: HrServiceControl = {
      ...control,
      settings: configure.value.body.settings,
      settingsVersion: 4,
      updatedAt: "2026-07-22T09:01:00.000Z",
      version: 5,
    };
    await expect(
      decodeWorkforceServiceControlApiResponse(
        Promise.resolve(response(configured, 200, "application/json", "true")),
        { action: configure.value, before: configured, operation: "mutate" },
      ),
    ).resolves.toEqual(configured);

    const deactivate = validateWorkforceServiceControlAction({
      expectedVersion: 2,
      idempotencyKey,
      operation: "deactivate",
    });
    expect(deactivate.ok).toBe(true);
    if (!deactivate.ok) return;
    const deactivated: HrServiceControl = {
      ...control,
      activationState: "inactive",
      activationVersion: 3,
      updatedAt: "2026-07-22T09:02:00.000Z",
      version: 5,
    };
    await expect(
      decodeWorkforceServiceControlApiResponse(
        Promise.resolve(response(deactivated, 200, "application/json", "true")),
        { action: deactivate.value, before: deactivated, operation: "mutate" },
      ),
    ).resolves.toEqual(deactivated);

    await expect(
      decodeWorkforceServiceControlApiResponse(
        Promise.resolve(response(deactivated, 200, "application/json", "false")),
        { action: deactivate.value, before: deactivated, operation: "mutate" },
      ),
    ).rejects.toMatchObject({ kind: "operational_error" });

    const firstActivation = validateWorkforceServiceControlAction({
      expectedVersion: null,
      idempotencyKey,
      operation: "activate",
    });
    expect(firstActivation.ok).toBe(true);
    if (!firstActivation.ok) return;
    const firstControl: HrServiceControl = {
      activationState: "active",
      activationVersion: 1,
      serviceKey: "workforce_profile",
      settings: {
        employeeNumberRequired: false,
        managerVisibility: "minimized",
        unlinkedWorkerCreationAllowed: true,
      },
      settingsVersion: 1,
      updatedAt: "2026-07-22T09:03:00.000Z",
      version: 1,
    };
    await expect(
      decodeWorkforceServiceControlApiResponse(
        Promise.resolve(response(firstControl, 200, "application/json", "true")),
        { action: firstActivation.value, before: firstControl, operation: "mutate" },
      ),
    ).resolves.toEqual(firstControl);
  });

  it("strictly decodes the same-origin route envelope", async () => {
    const action = validateWorkforceServiceControlAction({
      expectedVersion: 2,
      idempotencyKey,
      operation: "deactivate",
    });
    expect(action.ok).toBe(true);
    if (!action.ok) return;
    const deactivated = {
      ...control,
      activationState: "inactive" as const,
      activationVersion: 3,
      updatedAt: "2026-07-22T09:02:00.000Z",
      version: 5,
    };
    await expect(
      decodeWorkforceServiceControlTransport(
        Promise.resolve(response({ control: deactivated, ok: true })),
        control,
        action.value,
      ),
    ).resolves.toEqual({ control: deactivated, ok: true });

    const denied = workforceServiceControlStateForError(
      new WorkforceServiceControlUiError("denied", 403),
    );
    await expect(
      decodeWorkforceServiceControlTransport(
        Promise.resolve(response({ ok: false, state: denied }, 403)),
        control,
        action.value,
      ),
    ).resolves.toEqual({ ok: false, state: denied });
    await expect(
      decodeWorkforceServiceControlTransport(
        Promise.resolve(response({ ok: false, state: denied }, 200)),
        control,
        action.value,
      ),
    ).resolves.toMatchObject({ ok: false, state: { kind: "operational_error" } });
  });
});
