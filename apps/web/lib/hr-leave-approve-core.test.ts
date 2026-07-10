import { describe, expect, it } from "vitest";
import {
  approveFormStateForError,
  buildApproveLeaveRequestPath,
  decodeApproveLeaveRequestResponse,
  HrLeaveApproveError,
  parseHrLeaveApproveTransport,
  validateHrLeaveApproval,
} from "./hr-leave-approve-core";

const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const approved = {
  approverPrincipalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  categoryCode: "annual",
  correlationId: idempotencyKey,
  createdAt: "2026-07-10T00:00:00.000Z",
  decidedAt: "2026-07-10T01:00:00.000Z",
  decisionNote: null,
  employeePrincipalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  endDate: "2026-07-12",
  idempotencyKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  leaveRequestId,
  reason: "Rest",
  startDate: "2026-07-11",
  status: "approved",
  submittedAt: "2026-07-10T00:00:00.000Z",
  tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  updatedAt: "2026-07-10T01:00:00.000Z",
  version: 2,
} as const;

function problem(code: string, status: number) {
  return {
    code,
    detail: "Safe product detail",
    instance: `/v1/hr/leave-requests/${leaveRequestId}/approve`,
    requestId: "request-1",
    status,
    title: "Request Failed",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

describe("leave approval boundary", () => {
  it("accepts only an exact version and UUID idempotency envelope", () => {
    expect(validateHrLeaveApproval({ expectedVersion: 1, idempotencyKey })).toEqual({
      ok: true,
      value: { body: { expectedVersion: 1 }, idempotencyKey },
    });
    expect(
      validateHrLeaveApproval({ expectedVersion: 1, idempotencyKey, tenantId: "private" }),
    ).toMatchObject({ ok: false });
    expect(validateHrLeaveApproval({ expectedVersion: 0, idempotencyKey })).toMatchObject({
      ok: false,
    });
    expect(validateHrLeaveApproval({ expectedVersion: 1, idempotencyKey: "bad" })).toMatchObject({
      ok: false,
    });
  });

  it("builds only the exact approval path", () => {
    expect(buildApproveLeaveRequestPath(leaveRequestId)).toBe(
      `/v1/hr/leave-requests/${leaveRequestId}/approve`,
    );
    expect(() => buildApproveLeaveRequestPath("bad")).toThrow("could not be approved");
  });

  it("requires the exact approved transition response", async () => {
    await expect(
      decodeApproveLeaveRequestResponse(
        Promise.resolve(new Response(JSON.stringify(approved), { status: 200 })),
        leaveRequestId,
        1,
      ),
    ).resolves.toEqual(approved);
    await expect(
      decodeApproveLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify({ ...approved, status: "rejected" }), { status: 200 }),
        ),
        leaveRequestId,
        1,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(
      decodeApproveLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify({ ...approved, privateField: true }), { status: 200 }),
        ),
        leaveRequestId,
        1,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps only known API problems to safe failures", async () => {
    await expect(
      decodeApproveLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify(problem("LEAVE_VERSION_CONFLICT", 409)), { status: 409 }),
        ),
        leaveRequestId,
        1,
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      decodeApproveLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify(problem("POLICY_DENIED", 403)), { status: 403 }),
        ),
        leaveRequestId,
        1,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      decodeApproveLeaveRequestResponse(
        Promise.reject(new Error("private transport detail")),
        leaveRequestId,
        1,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("returns safe messages and strictly decodes the browser transport", () => {
    expect(approveFormStateForError(new HrLeaveApproveError("conflict"))).toEqual({
      message: "This request changed or was already decided. Refresh My Work.",
      status: "error",
    });
    expect(parseHrLeaveApproveTransport({ leaveRequestId, ok: true })).toEqual({
      leaveRequestId,
      ok: true,
    });
    expect(
      parseHrLeaveApproveTransport({
        ok: false,
        state: { message: "Safe failure", status: "error" },
      }),
    ).toMatchObject({ ok: false, state: { status: "error" } });
    expect(() =>
      parseHrLeaveApproveTransport({ leaveRequestId, ok: true, private: "leak" }),
    ).toThrow("Approval response is invalid");
  });
});
