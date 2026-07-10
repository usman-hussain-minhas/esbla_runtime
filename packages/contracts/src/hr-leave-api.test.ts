import { describe, expect, it } from "vitest";
import {
  hrAssignedLeaveListQuerySchema,
  hrDecideLeaveRequestBodySchema,
  hrLeaveEvidenceEventSchema,
  hrLeaveListQuerySchema,
  hrLeaveRequestDetailSchema,
  hrLeaveRequestPageSchema,
  hrLeaveRequestPathSchema,
  hrLeaveRequestSchema,
  hrSubmitLeaveRequestBodySchema,
  problemDetailsSchema,
} from "./hr-leave-api.js";

describe("HR Leave Request API schemas", () => {
  it("uses the exact ratified contract keys without duplicate schema identities", () => {
    const schemaIds = [
      hrSubmitLeaveRequestBodySchema.$id,
      hrDecideLeaveRequestBodySchema.$id,
      hrLeaveRequestPathSchema.$id,
      hrLeaveListQuerySchema.$id,
      hrAssignedLeaveListQuerySchema.$id,
      hrLeaveRequestSchema.$id,
      hrLeaveEvidenceEventSchema.$id,
      hrLeaveRequestPageSchema.$id,
      hrLeaveRequestDetailSchema.$id,
      problemDetailsSchema.$id,
    ];

    expect(schemaIds).toEqual([
      "SubmitLeaveRequest",
      "DecideLeaveRequest",
      "LeaveRequestPath",
      "ListLeaveRequestsQuery",
      "AssignedLeaveRequestsQuery",
      "LeaveRequest",
      "LeaveEvidenceEvent",
      "LeaveRequestPage",
      "LeaveRequestDetail",
      "ProblemDetails",
    ]);
    expect(new Set(schemaIds).size).toBe(schemaIds.length);
  });

  it("keeps list cursors paired and composes detail from request plus evidence history", () => {
    expect(hrLeaveListQuerySchema.dependencies).toEqual({
      cursorLeaveRequestId: ["cursorSubmittedAt"],
      cursorSubmittedAt: ["cursorLeaveRequestId"],
    });
    expect(hrAssignedLeaveListQuerySchema.dependencies).toEqual(
      hrLeaveListQuerySchema.dependencies,
    );
    expect(hrLeaveRequestDetailSchema.properties).toMatchObject({
      history: { items: { $ref: "LeaveEvidenceEvent#" }, maxItems: 100 },
      request: { $ref: "LeaveRequest#" },
    });
  });
});
