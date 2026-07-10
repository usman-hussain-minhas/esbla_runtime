import { beforeEach, describe, expect, it, vi } from "vitest";
import { HrLeaveRejectError } from "../../../../../../lib/hr-leave-reject-core";

const { rejectAssignedLeaveRequest } = vi.hoisted(() => ({
  rejectAssignedLeaveRequest: vi.fn(),
}));

vi.mock("../../../../../../lib/hr-leave-reject", () => ({
  rejectAssignedLeaveRequest,
}));

import { POST } from "./route";

const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const url = `http://127.0.0.1:3000/workspace/my-work/leave/${leaveRequestId}/reject`;
const context = { params: Promise.resolve({ leaveRequestId }) };

function request(body: unknown, origin = "http://127.0.0.1:3000") {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": origin === "http://127.0.0.1:3000" ? "same-origin" : "cross-site",
    },
    method: "POST",
  });
}

describe("HR leave rejection web transport", () => {
  beforeEach(() => {
    rejectAssignedLeaveRequest.mockReset();
  });

  it("fails closed before parsing a cross-origin request", async () => {
    const response = await POST(request({}, "https://attacker.example"), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, state: { status: "error" } });
    expect(rejectAssignedLeaveRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid or identity-bearing rejection envelope", async () => {
    const response = await POST(
      request({
        decisionNote: "Safe",
        expectedVersion: 1,
        idempotencyKey,
        tenantId: "private",
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private");
    expect(rejectAssignedLeaveRequest).not.toHaveBeenCalled();
  });

  it("forwards only the normalized versioned rejection and returns bounded success", async () => {
    rejectAssignedLeaveRequest.mockResolvedValue({ leaveRequestId });
    const response = await POST(
      request({ decisionNote: "  Coverage unavailable  ", expectedVersion: 1, idempotencyKey }),
      context,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ leaveRequestId, ok: true });
    expect(rejectAssignedLeaveRequest).toHaveBeenCalledOnce();
    expect(rejectAssignedLeaveRequest).toHaveBeenCalledWith(leaveRequestId, {
      body: { decisionNote: "Coverage unavailable", expectedVersion: 1 },
      idempotencyKey,
    });
  });

  it("returns a field-bound tenant-note retry without leaking upstream detail", async () => {
    rejectAssignedLeaveRequest.mockRejectedValue(
      Object.assign(new HrLeaveRejectError("note_required"), {
        privateDetail: "tenant setting row",
      }),
    );
    const response = await POST(
      request({ decisionNote: "", expectedVersion: 1, idempotencyKey }),
      context,
    );
    expect(response.status).toBe(400);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toMatchObject({
      ok: false,
      state: {
        fieldErrors: { decisionNote: expect.any(String) },
        status: "error",
      },
    });
    expect(responseText).not.toContain("tenant setting row");
  });

  it("maps an upstream conflict without leaking its private detail", async () => {
    rejectAssignedLeaveRequest.mockRejectedValue(
      Object.assign(new HrLeaveRejectError("conflict"), { privateDetail: "database row" }),
    );
    const response = await POST(
      request({ decisionNote: "Coverage unavailable", expectedVersion: 1, idempotencyKey }),
      context,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("database row");
  });
});
