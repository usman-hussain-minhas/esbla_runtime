import { beforeEach, describe, expect, it, vi } from "vitest";
import { HrLeaveApproveError } from "../../../../../../lib/hr-leave-approve-core";

const { approveAssignedLeaveRequest } = vi.hoisted(() => ({
  approveAssignedLeaveRequest: vi.fn(),
}));

vi.mock("../../../../../../lib/hr-leave-approve", () => ({
  approveAssignedLeaveRequest,
}));

import { POST } from "./route";

const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const url = `http://127.0.0.1:3000/workspace/my-work/leave/${leaveRequestId}/approve`;
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

describe("HR leave approval web transport", () => {
  beforeEach(() => {
    approveAssignedLeaveRequest.mockReset();
  });

  it("fails closed before parsing a cross-origin request", async () => {
    const response = await POST(request({}, "https://attacker.example"), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, state: { status: "error" } });
    expect(approveAssignedLeaveRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid or identity-bearing approval envelope", async () => {
    const response = await POST(
      request({ expectedVersion: 1, idempotencyKey, tenantId: "private" }),
      context,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private");
    expect(approveAssignedLeaveRequest).not.toHaveBeenCalled();
  });

  it("forwards only the exact versioned approval and returns a bounded success", async () => {
    approveAssignedLeaveRequest.mockResolvedValue({ leaveRequestId });
    const response = await POST(request({ expectedVersion: 1, idempotencyKey }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ leaveRequestId, ok: true });
    expect(approveAssignedLeaveRequest).toHaveBeenCalledOnce();
    expect(approveAssignedLeaveRequest).toHaveBeenCalledWith(leaveRequestId, {
      body: { expectedVersion: 1 },
      idempotencyKey,
    });
  });

  it("maps an upstream conflict without leaking its private detail", async () => {
    approveAssignedLeaveRequest.mockRejectedValue(
      Object.assign(new HrLeaveApproveError("conflict"), { privateDetail: "database row" }),
    );
    const response = await POST(request({ expectedVersion: 1, idempotencyKey }), context);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("database row");
  });
});
