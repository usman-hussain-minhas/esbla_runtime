import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeWorkforceAction } = vi.hoisted(() => ({ executeWorkforceAction: vi.fn() }));
vi.mock("./hr-workforce-profile", () => ({ executeWorkforceAction }));

import { POST } from "../app/workspace/hr/profile/admin/action/route";
import {
  decodeWorkforceApiResponse,
  parseWorkforceOnboardingSnapshot,
  validateWorkforceAction,
  workforceFormStateForError,
  workforceOnboardingSnapshot,
} from "./hr-workforce-profile-core";

const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const principalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workerProfileId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const keys = {
  activate: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
  create: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  link: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;
const profile = {
  employeeNumber: " W-001 ",
  principalLinked: false,
  version: 1,
  workerProfileId,
  workforceStatus: "draft",
} as const;
const createExpectation = { employeeNumber: profile.employeeNumber, operation: "create" } as const;

function response(
  body: unknown,
  status: number,
  contentType = status >= 400 ? "application/problem+json" : "application/json",
  replay?: boolean,
) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": contentType,
      ...(replay === undefined ? {} : { "idempotent-replayed": String(replay) }),
    },
    status,
  });
}

function problem(code: string, status: number, detail = "sensitive database detail") {
  return {
    code,
    detail,
    instance: "/v1/hr/workforce-profiles",
    requestId: "request-id",
    status,
    title: "Request failed",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

function routeRequest(
  body: unknown,
  origin = "http://127.0.0.1:3000",
  contentType = "application/json",
) {
  return new Request("http://127.0.0.1:3000/workspace/hr/profile/admin/action", {
    body: JSON.stringify(body),
    headers: {
      "content-type": contentType,
      origin,
      "sec-fetch-site": origin.includes("127.0.0.1") ? "same-origin" : "cross-site",
    },
    method: "POST",
  });
}

describe("Workforce Profile rendered transport core", () => {
  beforeEach(() => executeWorkforceAction.mockReset());

  it("validates the exact three operations and preserves opaque employee-number bytes", () => {
    expect(
      validateWorkforceAction({ employeeNumber: " W-001 ", idempotencyKey, operation: "create" }),
    ).toEqual({
      ok: true,
      value: { body: { employeeNumber: " W-001 " }, idempotencyKey, operation: "create" },
    });
    expect(
      validateWorkforceAction({ employeeNumber: "", idempotencyKey, operation: "create" }),
    ).toEqual({ ok: true, value: { body: {}, idempotencyKey, operation: "create" } });
    expect(
      validateWorkforceAction({
        expectedVersion: 1,
        idempotencyKey,
        operation: "link",
        principalId,
        workerProfileId,
      }),
    ).toMatchObject({ ok: true, value: { body: { expectedVersion: 1, principalId } } });
    expect(
      validateWorkforceAction({
        expectedVersion: 2,
        idempotencyKey,
        operation: "activate",
        workerProfileId,
      }),
    ).toMatchObject({
      ok: true,
      value: { body: { expectedVersion: 2, status: "active" } },
    });
  });

  it("rejects extra identity, arbitrary status, blank identifiers, and malformed control values", () => {
    for (const value of [
      { employeeNumber: "   ", idempotencyKey, operation: "create" },
      { employeeNumber: "W-1", idempotencyKey, operation: "create", tenantId: principalId },
      { employeeNumber: "W-1", idempotencyKey: "bad", operation: "create" },
      {
        expectedVersion: 2,
        idempotencyKey,
        operation: "activate",
        status: "terminated",
        workerProfileId,
      },
    ]) {
      expect(validateWorkforceAction(value).ok).toBe(false);
    }
  });

  it("accepts only exact success status, replay header, media type, shape, and lifecycle state", async () => {
    await expect(
      decodeWorkforceApiResponse(
        Promise.resolve(response(profile, 201, "application/json", false)),
        createExpectation,
      ),
    ).resolves.toEqual(profile);
    await expect(
      decodeWorkforceApiResponse(
        Promise.resolve(response(profile, 200, "application/json", true)),
        createExpectation,
      ),
    ).resolves.toEqual(profile);
    for (const invalid of [
      response(profile, 200, "application/json", false),
      response(profile, 201, "text/plain", false),
      response({ ...profile, employeeNumber: "OTHER" }, 201, "application/json", false),
      response({ ...profile, workforceStatus: "active" }, 201, "application/json", false),
    ]) {
      await expect(
        decodeWorkforceApiResponse(Promise.resolve(invalid), createExpectation),
      ).rejects.toMatchObject({
        kind: "operational_error",
      });
    }
  });

  it("binds mutation responses to the requested aggregate and next version", async () => {
    const expectation = { expectedVersion: 1, operation: "link", workerProfileId } as const;
    const linked = { ...profile, principalLinked: true, version: 2 };
    await expect(
      decodeWorkforceApiResponse(
        Promise.resolve(response(linked, 200, "application/json", false)),
        expectation,
      ),
    ).resolves.toEqual(linked);
    for (const mismatched of [
      { ...linked, version: 3 },
      { ...linked, workerProfileId: principalId },
    ]) {
      await expect(
        decodeWorkforceApiResponse(
          Promise.resolve(response(mismatched, 200, "application/json", false)),
          expectation,
        ),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
  });

  it("strictly maps bounded Problem Details without exposing raw detail", async () => {
    const cases = [
      ["POLICY_DENIED", 403, "denied"],
      ["WORKFORCE_PROFILE_NOT_FOUND", 404, "not_found"],
      ["WORKFORCE_VERSION_CONFLICT", 409, "conflict"],
      ["WORKFORCE_PRINCIPAL_INELIGIBLE", 422, "validation"],
      ["WORKFORCE_SERVICE_INACTIVE", 503, "inactive"],
      ["ACTIVATION_DEPENDENCY_BLOCKED", 503, "dependency_unavailable"],
    ] as const;
    for (const [code, status, kind] of cases) {
      const error = await decodeWorkforceApiResponse(
        Promise.resolve(response(problem(code, status), status)),
        { expectedVersion: 1, operation: "link", workerProfileId },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(workforceFormStateForError(error).message).not.toContain("database");
    }
    await expect(
      decodeWorkforceApiResponse(Promise.resolve(response(problem("POLICY_DENIED", 403), 409)), {
        expectedVersion: 1,
        operation: "link",
        workerProfileId,
      }),
    ).rejects.toMatchObject({ kind: "operational_error" });
    const requiredEmployeeNumber = await decodeWorkforceApiResponse(
      Promise.resolve(response(problem("WORKFORCE_INPUT_INVALID", 400), 400)),
      { employeeNumber: null, operation: "create" },
    ).catch((caught: unknown) => caught);
    expect(workforceFormStateForError(requiredEmployeeNumber)).toMatchObject({
      fieldErrors: { employeeNumber: expect.any(String) },
      kind: "validation",
    });
  });

  it("persists only bounded actor-scoped recovery state with stable per-step keys", () => {
    const linked = { ...profile, principalLinked: true, version: 2 };
    const snapshot = workforceOnboardingSnapshot(keys, linked);
    expect(snapshot).toEqual({
      idempotencyKeys: keys,
      progress: {
        principalLinked: true,
        version: 2,
        workerProfileId,
        workforceStatus: "draft",
      },
      schemaVersion: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain("W-001");
    expect(parseWorkforceOnboardingSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
    for (const unsafe of [
      { ...snapshot, idempotencyKeys: { ...keys, link: "bad" } },
      {
        ...snapshot,
        progress: { ...snapshot.progress, principalLinked: false, workforceStatus: "active" },
      },
    ]) {
      expect(() => parseWorkforceOnboardingSnapshot(unsafe)).toThrow();
    }
  });

  it("fails the route closed before parsing cross-origin or extra-field requests", async () => {
    const crossOrigin = await POST(routeRequest({}, "https://attacker.example"));
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.text()).not.toContain("attacker");
    const extraField = await POST(
      routeRequest({
        employeeNumber: "W-1",
        idempotencyKey,
        operation: "create",
        tenantId: principalId,
      }),
    );
    expect(extraField.status).toBe(400);
    const invalidJsonMediaType = await POST(
      routeRequest(
        { employeeNumber: "W-1", idempotencyKey, operation: "create" },
        "http://127.0.0.1:3000",
        "application/json-p",
      ),
    );
    expect(invalidJsonMediaType.status).toBe(415);
    expect(executeWorkforceAction).not.toHaveBeenCalled();
  });
});
