import { describe, expect, it } from "vitest";
import {
  allowedWorkforceStatusTargets,
  decodeWorkforceMaintenanceApiResponse,
  decodeWorkforceMaintenanceTransport,
  statusForWorkforceMaintenanceError,
  validateWorkforceMaintenanceAction,
  WorkforceMaintenanceUiError,
  workforceMaintenanceFormStateForError,
} from "./hr-workforce-profile-maintenance-core";

const workerProfileId = "11111111-1111-4111-8111-111111111111";
const managerWorkerProfileId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const reportingRelationshipId = "44444444-4444-4444-8444-444444444444";
const effectiveAt = "2026-07-22T00:00:00.000Z";

const statusAction = {
  body: { expectedVersion: 4, status: "suspended" as const },
  idempotencyKey,
  operation: "status" as const,
};
const reportingAction = {
  body: {
    expectedVersion: 4,
    managerWorkerProfileId,
    relationshipStatus: "assigned" as const,
  },
  idempotencyKey,
  operation: "reporting" as const,
};
const profile = {
  employeeNumber: "EMP-001",
  principalLinked: true,
  version: 5,
  workerProfileId,
  workforceStatus: "suspended",
};
const relationship = {
  effectiveAt,
  managerWorkerProfileId,
  relationshipStatus: "assigned",
  relationshipVersion: 2,
  reportingRelationshipId,
  supersedesReportingRelationshipId: null,
  workerProfileId,
  workerProfileVersion: 5,
};

function response(
  body: unknown,
  status = 200,
  replay: string | null = "false",
  contentType = status >= 400 ? "application/problem+json" : "application/json",
) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      ...(replay === null ? {} : { "idempotent-replayed": replay }),
    },
    status,
  });
}

function problem(code: string, status: number) {
  return {
    code,
    detail: "private database detail",
    instance: `/v1/hr/workforce-profiles/${workerProfileId}/status`,
    requestId: "55555555-5555-4555-8555-555555555555",
    status,
    title: "Request failed",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

function decodeApi(
  responsePromise: Promise<Response>,
  action: typeof statusAction | typeof reportingAction = statusAction,
) {
  return decodeWorkforceMaintenanceApiResponse(responsePromise, workerProfileId, action);
}

function decodeTransport(responsePromise: Promise<Response>) {
  return decodeWorkforceMaintenanceTransport(responsePromise, workerProfileId, statusAction);
}

describe("Workforce Profile lifecycle and reporting maintenance core", () => {
  it("exposes only legal next status choices", () => {
    expect(allowedWorkforceStatusTargets("draft")).toEqual(["active"]);
    expect(allowedWorkforceStatusTargets("active")).toEqual(["suspended", "terminated"]);
    expect(allowedWorkforceStatusTargets("suspended")).toEqual(["active", "terminated"]);
    expect(allowedWorkforceStatusTargets("terminated")).toEqual([]);
  });

  it("strictly validates identity-free status and reporting envelopes", () => {
    expect(
      validateWorkforceMaintenanceAction({
        expectedVersion: 4,
        idempotencyKey,
        operation: "status",
        status: "suspended",
      }),
    ).toEqual({ ok: true, value: statusAction });
    expect(
      validateWorkforceMaintenanceAction({
        expectedVersion: 4,
        idempotencyKey,
        managerWorkerProfileId: managerWorkerProfileId.toUpperCase(),
        operation: "reporting",
      }),
    ).toEqual({ ok: true, value: reportingAction });
    expect(
      validateWorkforceMaintenanceAction({
        expectedVersion: 4,
        idempotencyKey,
        managerWorkerProfileId: null,
        operation: "reporting",
      }),
    ).toEqual({
      ok: true,
      value: {
        body: {
          expectedVersion: 4,
          managerWorkerProfileId: null,
          relationshipStatus: "unassigned",
        },
        idempotencyKey,
        operation: "reporting",
      },
    });

    for (const invalid of [
      null,
      { expectedVersion: 4, idempotencyKey: "bad", operation: "status", status: "suspended" },
      {
        expectedVersion: 4,
        idempotencyKey,
        managerWorkerProfileId: "not-a-uuid",
        operation: "reporting",
      },
    ]) {
      expect(validateWorkforceMaintenanceAction(invalid)).toMatchObject({ ok: false });
    }
  });

  it("accepts only exact status success bound to target, semantics, version and replay", async () => {
    for (const replay of ["false", "true"]) {
      await expect(decodeApi(Promise.resolve(response(profile, 200, replay)))).resolves.toEqual({
        operation: "status",
        status: "suspended",
        workerProfileId,
        workerProfileVersion: 5,
      });
    }
    for (const invalid of [
      response(profile, 201, "false"),
      response(profile, 200, null),
      response(profile, 200, "false", "text/plain"),
      response({ ...profile, workforceStatus: "active" }),
      response({ ...profile, version: 4 }),
    ]) {
      await expect(decodeApi(Promise.resolve(invalid))).rejects.toMatchObject({
        kind: "operational_error",
      });
    }
  });

  it("accepts exact initial and replayed reporting success bound to the requested change", async () => {
    for (const [status, replay] of [
      [201, "false"],
      [200, "true"],
    ] as const) {
      await expect(
        decodeApi(Promise.resolve(response(relationship, status, replay)), reportingAction),
      ).resolves.toEqual({
        managerWorkerProfileId,
        operation: "reporting",
        relationshipStatus: "assigned",
        workerProfileId,
        workerProfileVersion: 5,
      });
    }
    for (const invalid of [
      response(relationship, 200, "false"),
      response({ ...relationship, workerProfileId: managerWorkerProfileId }, 201),
      response({ ...relationship, managerWorkerProfileId: workerProfileId }, 201),
    ]) {
      await expect(decodeApi(Promise.resolve(invalid), reportingAction)).rejects.toMatchObject({
        kind: "operational_error",
      });
    }
  });

  it("strictly maps bounded Problem Details and never retains upstream detail", async () => {
    for (const [code, status, kind, action = statusAction] of [
      ["POLICY_DENIED", 403, "denied"],
      ["ACTOR_NOT_ACTIVE_MEMBER", 403, "denied"],
      ["WORKFORCE_PROFILE_NOT_FOUND", 404, "not_found"],
      ["WORKFORCE_PROFILE_NOT_FOUND", 404, "conflict", reportingAction],
      ["IDEMPOTENCY_CONFLICT", 409, "conflict"],
      ["WORKFORCE_PROFILE_CONFLICT", 409, "conflict"],
      ["WORKFORCE_VERSION_CONFLICT", 409, "conflict"],
      ["WORKFORCE_PRINCIPAL_INELIGIBLE", 422, "conflict"],
      ["REQUEST_VALIDATION_FAILED", 400, "validation"],
      ["WORKFORCE_INPUT_INVALID", 400, "validation"],
      ["WORKFORCE_SERVICE_INACTIVE", 503, "inactive"],
      ["ACTIVATION_DEPENDENCY_BLOCKED", 503, "dependency_unavailable"],
    ] as const) {
      const error = await decodeApi(
        Promise.resolve(response(problem(code, status), status, null)),
        action,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(JSON.stringify(error)).not.toContain("database");
    }
    for (const invalid of [
      response(problem("POLICY_DENIED", 403), 409, null),
      response({ ...problem("POLICY_DENIED", 403), tenantId: workerProfileId }, 403, null),
    ]) {
      await expect(decodeApi(Promise.resolve(invalid))).rejects.toMatchObject({
        kind: "operational_error",
      });
    }
    await expect(
      decodeApi(Promise.reject(new Error("private socket detail"))),
    ).rejects.toMatchObject({ kind: "operational_error" });
  });

  it("produces fixed form states and safe route statuses", () => {
    for (const [kind, status] of [
      ["validation", 400],
      ["denied", 403],
      ["not_found", 404],
      ["conflict", 409],
      ["inactive", 503],
      ["dependency_unavailable", 503],
      ["operational_error", 503],
    ] as const) {
      const error = new WorkforceMaintenanceUiError(kind, status);
      const state = workforceMaintenanceFormStateForError(error);
      expect(statusForWorkforceMaintenanceError(error)).toBe(status);
      expect(state.kind).toBe(kind);
      expect(state.message).not.toContain("database");
    }
    expect(
      workforceMaintenanceFormStateForError(
        new WorkforceMaintenanceUiError("validation", 400, "managerWorkerProfileId"),
      ).fieldErrors,
    ).toHaveProperty("managerWorkerProfileId");
    expect(statusForWorkforceMaintenanceError(new Error("private"))).toBe(503);
    expect(
      statusForWorkforceMaintenanceError(new WorkforceMaintenanceUiError("conflict", 422)),
    ).toBe(422);
  });

  it("strictly decodes the same-origin route transport against the submitted action", async () => {
    const result = {
      operation: "status",
      status: "suspended",
      workerProfileId,
      workerProfileVersion: 5,
    } as const;
    await expect(
      decodeTransport(Promise.resolve(response({ ok: true, result }, 200, null))),
    ).resolves.toEqual({ ok: true, result });

    const denied = workforceMaintenanceFormStateForError(new WorkforceMaintenanceUiError("denied"));
    await expect(
      decodeTransport(
        Promise.resolve(response({ ok: false, state: denied }, 403, null, "application/json")),
      ),
    ).resolves.toEqual({ ok: false, state: denied });

    for (const invalid of [
      response({ ok: true, result: { ...result, workerProfileVersion: 4 } }, 200, null),
      response({ ok: false, state: { ...denied, message: "private database detail" } }, 403, null),
      response({ ok: false, state: denied }, 200, null),
      response({ ok: true, result }, 200, null, "text/plain"),
    ]) {
      await expect(decodeTransport(Promise.resolve(invalid))).resolves.toMatchObject({
        ok: false,
        state: { kind: "operational_error" },
      });
    }
  });
});
