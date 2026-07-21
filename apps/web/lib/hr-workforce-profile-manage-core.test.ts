import { describe, expect, it } from "vitest";
import {
  decodeWorkforceControlResponse,
  decodeWorkforceControlState,
  decodeWorkforceProfileMutationResponse,
  HrWorkforceManageError,
  parseWorkforceControlTransport,
  parseWorkforceManageTransport,
  validateWorkforceControlCommand,
  validateWorkforceManagementCommand,
} from "./hr-workforce-profile-manage-core.js";

const idempotencyKey = "10000000-0000-4000-8000-000000000001";
const workerProfileId = "20000000-0000-4000-8000-000000000001";
const principalId = "30000000-0000-4000-8000-000000000001";
const profile = {
  createdAt: "2026-07-21T06:00:00.000Z",
  employeeNumber: "EMP-0001",
  principalLinked: false,
  updatedAt: "2026-07-21T06:00:00.000Z",
  version: 1,
  workerProfileId,
  workforceStatus: "draft",
} as const;
const control = {
  activationState: "active",
  activationVersion: 1,
  serviceKey: "workforce_profile",
  settingsVersion: 1,
  updatedAt: "2026-07-21T06:00:00.000Z",
  version: 1,
} as const;

function json(body: unknown, status = 200, contentType = "application/json") {
  return Promise.resolve(
    new Response(JSON.stringify(body), { headers: { "content-type": contentType }, status }),
  );
}

function problem(code: string, status: number) {
  return json(
    {
      code,
      detail: "Sanitized detail",
      instance: "/v1/hr/workforce-profiles",
      requestId: idempotencyKey,
      status,
      title: "Request Failed",
      type: `urn:esbla:problem:${code.toLowerCase()}`,
    },
    status,
    "application/problem+json",
  );
}

describe("workforce management command validation", () => {
  it("derives exact API commands without tenant or actor identity", () => {
    expect(
      validateWorkforceManagementCommand({
        action: "create",
        employeeNumber: " EMP-0001 ",
        idempotencyKey,
      }),
    ).toEqual({
      command: {
        body: { employeeNumber: "EMP-0001" },
        idempotencyKey,
        method: "POST",
        path: "/v1/hr/workforce-profiles",
      },
      ok: true,
    });
    expect(
      validateWorkforceManagementCommand({
        action: "link",
        expectedVersion: 1,
        idempotencyKey,
        principalId,
        workerProfileId,
      }),
    ).toMatchObject({
      command: {
        body: { expectedVersion: 1, principalId },
        path: `/v1/hr/workforce-profiles/${workerProfileId}/principal-link`,
      },
      ok: true,
    });
  });

  it("rejects extra identity scope, stale shapes, and invalid lifecycle inputs", () => {
    expect(
      validateWorkforceManagementCommand({
        action: "create",
        employeeNumber: "EMP-1",
        idempotencyKey,
        tenantId: "forged",
      }).ok,
    ).toBe(false);
    expect(
      validateWorkforceManagementCommand({
        action: "activate_profile",
        expectedVersion: 0,
        idempotencyKey,
        workerProfileId,
      }).ok,
    ).toBe(false);
    expect(
      validateWorkforceControlCommand({
        action: "deactivate",
        expectedVersion: null,
        idempotencyKey,
      }).ok,
    ).toBe(false);
    expect(
      validateWorkforceControlCommand({
        action: "activate",
        expectedVersion: null,
        idempotencyKey,
      }).ok,
    ).toBe(true);
  });
});

describe("workforce management response decoding", () => {
  it("accepts exact profile and control success shapes", async () => {
    await expect(decodeWorkforceProfileMutationResponse(json(profile, 201))).resolves.toEqual(
      profile,
    );
    await expect(decodeWorkforceControlResponse(json(control))).resolves.toEqual(control);
    expect(parseWorkforceManageTransport({ ok: true, profile })).toEqual({ ok: true, profile });
    expect(parseWorkforceControlTransport({ control, ok: true })).toEqual({ control, ok: true });
  });

  it("maps strict Problem Details and treats absent control as uninitialized", async () => {
    await expect(
      decodeWorkforceProfileMutationResponse(
        problem("WORKFORCE_PROFILE_PRINCIPAL_UNAVAILABLE", 422),
      ),
    ).rejects.toMatchObject({ kind: "principal_unavailable" });
    await expect(
      decodeWorkforceProfileMutationResponse(problem("POLICY_DENIED", 403)),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      decodeWorkforceControlState(problem("WORKFORCE_PROFILE_NOT_FOUND", 404)),
    ).resolves.toEqual({ status: "uninitialized" });
  });

  it("rejects malformed, overbroad, and wrong-media responses", async () => {
    await expect(
      decodeWorkforceProfileMutationResponse(json({ ...profile, tenantId: "private" }, 200)),
    ).rejects.toBeInstanceOf(HrWorkforceManageError);
    await expect(
      decodeWorkforceControlResponse(json(control, 200, "text/plain")),
    ).rejects.toBeInstanceOf(HrWorkforceManageError);
    expect(() => parseWorkforceManageTransport({ ok: true, profile, extra: true })).toThrow();
    expect(() => parseWorkforceControlTransport({ message: "safe", ok: false, raw: {} })).toThrow();
  });
});
