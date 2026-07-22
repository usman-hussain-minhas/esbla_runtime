import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeWorkforceMaintenance } = vi.hoisted(() => ({
  executeWorkforceMaintenance: vi.fn(),
}));

vi.mock("../../../../../../../lib/hr-workforce-profile-maintenance", () => ({
  executeWorkforceMaintenance,
}));

import { POST } from "./route";

const workerProfileId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const url = `http://127.0.0.1:3000/workspace/hr/profile/by-id/${workerProfileId}/action`;
const context = { params: Promise.resolve({ workerProfileId }) };

function request(
  body: unknown,
  origin = "http://127.0.0.1:3000",
  contentType = "application/json",
) {
  return new Request(url, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": contentType,
      origin,
      "sec-fetch-site": origin === "http://127.0.0.1:3000" ? "same-origin" : "cross-site",
    },
    method: "POST",
  });
}

describe("Workforce Profile maintenance web transport", () => {
  beforeEach(() => executeWorkforceMaintenance.mockReset());

  it("fails closed before parsing a cross-origin request", async () => {
    const response = await POST(request({}, "https://attacker.example"), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      state: { kind: "denied", status: "error" },
    });
    expect(executeWorkforceMaintenance).not.toHaveBeenCalled();
  });

  it("rejects unsupported media, malformed JSON, and identity-bearing envelopes", async () => {
    for (const input of [
      request({}, undefined, "text/plain"),
      request("{broken"),
      request({
        actorPrincipalId: "private",
        expectedVersion: 4,
        idempotencyKey,
        operation: "status",
        status: "suspended",
      }),
    ]) {
      const response = await POST(input, context);
      expect([400, 415]).toContain(response.status);
      expect(await response.text()).not.toContain("private");
    }
    expect(executeWorkforceMaintenance).not.toHaveBeenCalled();
  });

  it("derives the target and table-drives only exact status and reporting actions", async () => {
    const cases = [
      [
        { expectedVersion: 4, idempotencyKey, operation: "status", status: "suspended" },
        { body: { expectedVersion: 4, status: "suspended" }, idempotencyKey, operation: "status" },
      ],
      [
        {
          expectedVersion: 4,
          idempotencyKey,
          managerWorkerProfileId: "33333333-3333-4333-8333-333333333333",
          operation: "reporting",
        },
        {
          body: {
            expectedVersion: 4,
            managerWorkerProfileId: "33333333-3333-4333-8333-333333333333",
            relationshipStatus: "assigned",
          },
          idempotencyKey,
          operation: "reporting",
        },
      ],
      [
        {
          expectedVersion: 4,
          idempotencyKey,
          managerWorkerProfileId: null,
          operation: "reporting",
        },
        {
          body: {
            expectedVersion: 4,
            managerWorkerProfileId: null,
            relationshipStatus: "unassigned",
          },
          idempotencyKey,
          operation: "reporting",
        },
      ],
    ] as const;
    for (const [payload, action] of cases) {
      const result = { operation: action.operation, workerProfileId, workerProfileVersion: 5 };
      executeWorkforceMaintenance.mockResolvedValueOnce(result);
      const response = await POST(request(payload), context);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, result });
      expect(executeWorkforceMaintenance).toHaveBeenLastCalledWith(workerProfileId, action);
    }

    const invalidPath = await POST(
      request({ expectedVersion: 4, idempotencyKey, operation: "status", status: "suspended" }),
      { params: Promise.resolve({ workerProfileId: "not-a-uuid" }) },
    );
    expect(invalidPath.status).toBe(400);
    expect(executeWorkforceMaintenance).toHaveBeenCalledTimes(3);
  });
});
