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
    const detailRoot = new URL("../app/workspace/hr/leave/[leaveRequestId]/", import.meta.url);
    const [pageSource, faceSource] = await Promise.all([
      readFile(new URL("page.tsx", detailRoot), "utf8"),
      readFile(new URL("leave-request-detail-face.tsx", detailRoot), "utf8"),
    ]);
    expect(pageSource).toContain("HrLeaveRequestDetailFace");
    expect(faceSource).toContain("Evidence history");
    expect(faceSource).not.toContain("tenantId");
    expect(faceSource).not.toContain("employeePrincipalId");
    expect(faceSource).not.toContain("correlationId");
    expect(faceSource).not.toContain("idempotencyKey");
    expect(faceSource).not.toContain("<form");
    expect(faceSource).not.toContain("<button");
    expect(faceSource).not.toContain("/approve");
    expect(faceSource).not.toContain("/reject");
  });
});
