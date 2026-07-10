import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildLeaveRequestDetailPath,
  decodeLeaveRequestDetailResponse,
} from "./hr-leave-detail-core";

const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const submittedAt = "2026-07-10T00:00:00.000Z";
const detail = {
  history: [
    {
      eventType: "evidence.hr.leave_request.submitted",
      newState: "submitted",
      occurredAt: submittedAt,
      priorState: null,
    },
  ],
  request: {
    categoryCode: "annual",
    decidedAt: null,
    decisionNote: null,
    employeeDisplayName: "Employee A",
    endDate: "2026-07-12",
    leaveRequestId,
    reason: "Rest",
    startDate: "2026-07-11",
    status: "submitted",
    submittedAt,
    version: 1,
  },
};

describe("leave-request detail boundary", () => {
  it("builds only the exact detail path", () => {
    expect(buildLeaveRequestDetailPath(leaveRequestId)).toBe(
      `/v1/hr/leave-requests/${leaveRequestId}`,
    );
    expect(() => buildLeaveRequestDetailPath("bad")).toThrow("unavailable");
  });

  it("strictly decodes detail and distinguishes safe not-found", async () => {
    await expect(
      decodeLeaveRequestDetailResponse(
        Promise.resolve(new Response(JSON.stringify(detail), { status: 200 })),
      ),
    ).resolves.toEqual(detail);
    await expect(
      decodeLeaveRequestDetailResponse(Promise.resolve(new Response("", { status: 404 }))),
    ).resolves.toBeNull();
    await expect(
      decodeLeaveRequestDetailResponse(
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...detail,
              request: { ...detail.request, tenantId: "private" },
            }),
            { status: 200 },
          ),
        ),
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      decodeLeaveRequestDetailResponse(Promise.resolve(new Response("private", { status: 403 }))),
    ).rejects.toThrow("unavailable");
  });

  it("keeps the rendered detail read-only and free of internal identity fields", async () => {
    const pageSource = await readFile(
      new URL("../app/workspace/hr/leave/[leaveRequestId]/page.tsx", import.meta.url),
      "utf8",
    );
    expect(pageSource).toContain("Evidence history");
    expect(pageSource).not.toContain("tenantId");
    expect(pageSource).not.toContain("employeePrincipalId");
    expect(pageSource).not.toContain("correlationId");
    expect(pageSource).not.toContain("idempotencyKey");
    expect(pageSource).not.toContain("<form");
    expect(pageSource).not.toContain("<button");
    expect(pageSource).not.toContain("/approve");
    expect(pageSource).not.toContain("/reject");
  });
});
