import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildAssignedLeaveRequestListPath,
  decodeAssignedLeaveRequestListResponse,
} from "./hr-leave-assigned-list-core";

const cursor = {
  leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  submittedAt: "2026-07-10T00:00:00.000Z",
};

const assignedItem = {
  categoryCode: "annual",
  employeeDisplayName: "Employee A",
  endDate: "2026-07-12",
  leaveRequestId: cursor.leaveRequestId,
  reason: "Rest",
  startDate: "2026-07-11",
  submittedAt: cursor.submittedAt,
  version: 1,
  workItemId: "11111111-1111-4111-8111-111111111111",
};

describe("assigned leave-request list boundary", () => {
  it("builds only the bounded assigned-list query without client identity parameters", () => {
    const path = buildAssignedLeaveRequestListPath(cursor);
    expect(path).toBe(
      "/v1/hr/leave-requests/assigned?pageSize=50&cursorLeaveRequestId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee&cursorSubmittedAt=2026-07-10T00%3A00%3A00.000Z",
    );
    expect(path).not.toContain("tenant");
    expect(path).not.toContain("principal");
    expect(() => buildAssignedLeaveRequestListPath({ ...cursor, leaveRequestId: "bad" })).toThrow(
      "unavailable",
    );
  });

  it("accepts only the privacy-minimized page and fails opaquely", async () => {
    const page = { items: [assignedItem], nextCursor: cursor };
    await expect(
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(new Response(JSON.stringify(page), { status: 200 })),
      ),
    ).resolves.toEqual(page);
    await expect(
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ ...assignedItem, tenantId: "private" }],
              nextCursor: null,
            }),
            { status: 200 },
          ),
        ),
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(new Response("private", { status: 403 })),
      ),
    ).rejects.toThrow("unavailable");
  });

  it("keeps the My Work list privacy-minimized and delegates decisions to bounded actions", async () => {
    const pageSource = await readFile(
      new URL("../app/workspace/my-work/page.tsx", import.meta.url),
      "utf8",
    );
    expect(pageSource).toContain("Assigned approvals");
    expect(pageSource).toContain("LeaveApprovalAction");
    expect(pageSource).toContain("LeaveRejectionAction");
    expect(pageSource).not.toContain("fetch(");
    expect(pageSource).not.toContain("/approve");
    expect(pageSource).not.toContain("/reject");
    expect(pageSource).not.toContain("tenantId");
    expect(pageSource).not.toContain("employeePrincipalId");
  });
});
