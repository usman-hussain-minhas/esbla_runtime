import { describe, expect, it } from "vitest";
import {
  buildRejectLeaveRequestPath,
  decodeRejectLeaveRequestResponse,
  HrLeaveRejectError,
  parseHrLeaveRejectTransport,
  rejectFormStateForError,
  validateHrLeaveRejection,
} from "./hr-leave-reject-core";

const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const rejected = {
  approverPrincipalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  categoryCode: "annual",
  correlationId: idempotencyKey,
  createdAt: "2026-07-10T00:00:00.000Z",
  decidedAt: "2026-07-10T01:00:00.000Z",
  decisionNote: "Coverage unavailable",
  employeePrincipalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  endDate: "2026-07-12",
  idempotencyKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  leaveRequestId,
  reason: "Rest",
  startDate: "2026-07-11",
  status: "rejected",
  submittedAt: "2026-07-10T00:00:00.000Z",
  tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  updatedAt: "2026-07-10T01:00:00.000Z",
  version: 2,
} as const;

function problem(code: string, status: number, detail = "Safe product detail") {
  return {
    code,
    detail,
    instance: `/v1/hr/leave-requests/${leaveRequestId}/reject`,
    requestId: "request-1",
    status,
    title: "Request Failed",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

describe("leave rejection boundary", () => {
  it("accepts only an exact envelope and normalizes an optional bounded note", () => {
    expect(
      validateHrLeaveRejection({
        decisionNote: "  Coverage unavailable  ",
        expectedVersion: 1,
        idempotencyKey,
      }),
    ).toEqual({
      ok: true,
      value: {
        body: { decisionNote: "Coverage unavailable", expectedVersion: 1 },
        idempotencyKey,
      },
    });
    expect(
      validateHrLeaveRejection({ decisionNote: "   ", expectedVersion: 1, idempotencyKey }),
    ).toEqual({
      ok: true,
      value: { body: { expectedVersion: 1 }, idempotencyKey },
    });
    expect(
      validateHrLeaveRejection({
        decisionNote: "Safe",
        expectedVersion: 1,
        idempotencyKey,
        tenantId: "private",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateHrLeaveRejection({
        decisionNote: "x".repeat(2001),
        expectedVersion: 1,
        idempotencyKey,
      }),
    ).toMatchObject({
      ok: false,
      state: { fieldErrors: { decisionNote: expect.any(String) } },
    });
  });

  it("builds only the exact rejection path", () => {
    expect(buildRejectLeaveRequestPath(leaveRequestId)).toBe(
      `/v1/hr/leave-requests/${leaveRequestId}/reject`,
    );
    expect(() => buildRejectLeaveRequestPath("bad")).toThrow("could not be rejected");
  });

  it("requires the exact rejected transition and normalized note", async () => {
    await expect(
      decodeRejectLeaveRequestResponse(
        Promise.resolve(new Response(JSON.stringify(rejected), { status: 200 })),
        leaveRequestId,
        1,
        "Coverage unavailable",
      ),
    ).resolves.toEqual(rejected);
    await expect(
      decodeRejectLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify({ ...rejected, status: "approved" }), { status: 200 }),
        ),
        leaveRequestId,
        1,
        "Coverage unavailable",
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(
      decodeRejectLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify({ ...rejected, decisionNote: "Changed" }), { status: 200 }),
        ),
        leaveRequestId,
        1,
        "Coverage unavailable",
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps the exact tenant note policy to a field-bound retry", async () => {
    await expect(
      decodeRejectLeaveRequestResponse(
        Promise.resolve(
          new Response(
            JSON.stringify(
              problem("LEAVE_INPUT_INVALID", 400, "Rejection note is required by tenant policy"),
            ),
            { status: 400 },
          ),
        ),
        leaveRequestId,
        1,
        null,
      ),
    ).rejects.toMatchObject({ kind: "note_required" });
    expect(rejectFormStateForError(new HrLeaveRejectError("note_required"))).toEqual({
      fieldErrors: { decisionNote: "A decision note is required by your tenant policy." },
      message: "Review the highlighted field.",
      status: "error",
    });
  });

  it("maps only known API problems to bounded failures", async () => {
    await expect(
      decodeRejectLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify(problem("LEAVE_VERSION_CONFLICT", 409)), { status: 409 }),
        ),
        leaveRequestId,
        1,
        null,
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      decodeRejectLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify(problem("POLICY_DENIED", 403)), { status: 403 }),
        ),
        leaveRequestId,
        1,
        null,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      decodeRejectLeaveRequestResponse(
        Promise.reject(new Error("private transport detail")),
        leaveRequestId,
        1,
        null,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("strictly decodes the bounded browser transport", () => {
    expect(parseHrLeaveRejectTransport({ leaveRequestId, ok: true })).toEqual({
      leaveRequestId,
      ok: true,
    });
    expect(
      parseHrLeaveRejectTransport({
        ok: false,
        state: {
          fieldErrors: { decisionNote: "Safe field error" },
          message: "Safe failure",
          status: "error",
        },
      }),
    ).toMatchObject({ ok: false, state: { status: "error" } });
    expect(() =>
      parseHrLeaveRejectTransport({ leaveRequestId, ok: true, private: "leak" }),
    ).toThrow("Rejection response is invalid");
  });
});
