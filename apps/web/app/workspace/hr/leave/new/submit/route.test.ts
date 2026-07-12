import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitOwnLeaveRequest } = vi.hoisted(() => ({
  submitOwnLeaveRequest: vi.fn(),
}));

vi.mock("../../../../../../lib/hr-leave-submit", () => ({
  submitOwnLeaveRequest,
}));

import { POST } from "./route";

const url = "http://127.0.0.1:3000/workspace/hr/leave/new/submit";
const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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

describe("HR leave submission web transport", () => {
  beforeEach(() => {
    submitOwnLeaveRequest.mockReset();
  });

  it("fails closed before parsing a cross-origin request", async () => {
    const response = await POST(request({}, "https://attacker.example"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      state: { fieldErrors: {}, status: "error" },
    });
    expect(submitOwnLeaveRequest).not.toHaveBeenCalled();
  });

  it("returns bounded field errors without calling the upstream API", async () => {
    const response = await POST(
      request({
        categoryCode: "",
        endDate: "2026-02-31",
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        reason: "",
        startDate: "",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      state: {
        fieldErrors: {
          categoryCode: "Choose a leave type.",
          endDate: "Enter a valid end date.",
          startDate: "Enter a valid start date.",
        },
      },
    });
    expect(submitOwnLeaveRequest).not.toHaveBeenCalled();
  });

  it("forwards only the normalized submission and returns a bounded success response", async () => {
    submitOwnLeaveRequest.mockResolvedValue({ leaveRequestId });
    const response = await POST(
      request({
        categoryCode: "annual",
        endDate: "2026-07-12",
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        reason: "  Rest  ",
        startDate: "2026-07-11",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ leaveRequestId, ok: true });
    expect(submitOwnLeaveRequest).toHaveBeenCalledOnce();
    expect(submitOwnLeaveRequest).toHaveBeenCalledWith({
      body: {
        categoryCode: "annual",
        endDate: "2026-07-12",
        reason: "Rest",
        startDate: "2026-07-11",
      },
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
  });

  it("rejects non-JSON fallback posts without exposing submitted values", async () => {
    const response = await POST(
      new Request(url, {
        body: "reason=private",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(415);
    expect(await response.text()).not.toContain("private");
    expect(submitOwnLeaveRequest).not.toHaveBeenCalled();
  });

  it("returns the same bounded stable ID for an idempotently replayed result", async () => {
    submitOwnLeaveRequest.mockResolvedValue({ leaveRequestId });
    const first = await POST(
      request({
        categoryCode: "annual",
        endDate: "2026-07-12",
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        reason: "Rest",
        startDate: "2026-07-11",
      }),
    );
    const replay = await POST(
      request({
        categoryCode: "annual",
        endDate: "2026-07-12",
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        reason: "Rest",
        startDate: "2026-07-11",
      }),
    );

    await expect(first.json()).resolves.toEqual({ leaveRequestId, ok: true });
    await expect(replay.json()).resolves.toEqual({ leaveRequestId, ok: true });
  });
});
