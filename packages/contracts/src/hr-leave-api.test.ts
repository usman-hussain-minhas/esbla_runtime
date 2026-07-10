import { describe, expect, it } from "vitest";
import {
  hrAssignedLeaveListQuerySchema,
  hrAssignedLeaveRequestPageSchema,
  hrAssignedLeaveRequestSchema,
  hrDecideLeaveRequestBodySchema,
  hrLeaveEvidenceEventSchema,
  hrLeaveListQuerySchema,
  hrLeaveRequestDetailRequestSchema,
  hrLeaveRequestDetailSchema,
  hrLeaveRequestPageSchema,
  hrLeaveRequestPathSchema,
  hrLeaveRequestSchema,
  hrSubmitLeaveRequestBodySchema,
  parseApiProblemDetails,
  parseHrAssignedLeaveRequestPage,
  parseHrLeaveRequest,
  parseHrLeaveRequestDetail,
  parseHrLeaveRequestPage,
  problemDetailsSchema,
} from "./hr-leave-api.js";

const leaveRequest = {
  approverPrincipalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  categoryCode: "annual",
  correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  createdAt: "2026-07-10T00:00:00.000Z",
  decidedAt: null,
  decisionNote: null,
  employeePrincipalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  endDate: "2026-07-12",
  idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  reason: "Rest",
  startDate: "2026-07-11",
  status: "submitted",
  submittedAt: "2026-07-10T00:00:00.000Z",
  tenantId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  updatedAt: "2026-07-10T00:00:00.000Z",
  version: 1,
} as const;

describe("HR Leave Request API schemas", () => {
  it("uses the exact ratified contract keys without duplicate schema identities", () => {
    const schemaIds = [
      hrSubmitLeaveRequestBodySchema.$id,
      hrDecideLeaveRequestBodySchema.$id,
      hrLeaveRequestPathSchema.$id,
      hrLeaveListQuerySchema.$id,
      hrAssignedLeaveListQuerySchema.$id,
      hrAssignedLeaveRequestSchema.$id,
      hrAssignedLeaveRequestPageSchema.$id,
      hrLeaveRequestSchema.$id,
      hrLeaveRequestDetailRequestSchema.$id,
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
      "AssignedLeaveRequest",
      "AssignedLeaveRequestPage",
      "LeaveRequest",
      "LeaveRequestDetailRequest",
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
      history: { items: { $ref: "LeaveEvidenceEvent#" }, maxItems: 100, minItems: 1 },
      request: { $ref: "LeaveRequestDetailRequest#" },
    });
  });

  it("strictly decodes evidence-backed detail and rejects broken history", () => {
    const detailRequest = {
      categoryCode: leaveRequest.categoryCode,
      decidedAt: leaveRequest.decidedAt,
      decisionNote: leaveRequest.decisionNote,
      employeeDisplayName: "Employee A",
      endDate: leaveRequest.endDate,
      leaveRequestId: leaveRequest.leaveRequestId,
      reason: leaveRequest.reason,
      startDate: leaveRequest.startDate,
      status: leaveRequest.status,
      submittedAt: leaveRequest.submittedAt,
      version: leaveRequest.version,
    } as const;
    const submitted = {
      eventType: "evidence.hr.leave_request.submitted",
      newState: "submitted",
      occurredAt: leaveRequest.submittedAt,
      priorState: null,
    } as const;
    const detail = { history: [submitted], request: detailRequest };

    expect(parseHrLeaveRequestDetail(detail)).toBe(detail);
    expect(() => parseHrLeaveRequestDetail({ history: [], request: detailRequest })).toThrow(
      "between 1 and 100",
    );
    expect(() =>
      parseHrLeaveRequestDetail({
        history: [{ ...submitted, eventType: "evidence.hr.leave_request.approved" }],
        request: detailRequest,
      }),
    ).toThrow("does not match newState");
    expect(() =>
      parseHrLeaveRequestDetail({
        history: [{ ...submitted, privateDetail: "secret" }],
        request: detailRequest,
      }),
    ).toThrow("unexpected or missing fields");
    expect(() =>
      parseHrLeaveRequestDetail({
        history: [submitted],
        request: { ...detailRequest, decisionNote: "Not decided" },
      }),
    ).toThrow("submitted request cannot have decisionNote");
    expect(() =>
      parseHrLeaveRequestDetail({
        history: [submitted],
        request: {
          ...detailRequest,
          decidedAt: "2026-07-10T01:00:00.000Z",
          status: "approved",
        },
      }),
    ).toThrow("does not prove the current request status");
  });

  it("strictly decodes a bounded leave-request page", () => {
    const page = {
      items: [leaveRequest],
      nextCursor: {
        leaveRequestId: leaveRequest.leaveRequestId,
        submittedAt: leaveRequest.submittedAt,
      },
    };
    expect(parseHrLeaveRequestPage(page)).toBe(page);
    expect(parseHrLeaveRequest(leaveRequest)).toBe(leaveRequest);
    expect(hrLeaveRequestPageSchema.properties.items.maxItems).toBe(50);
  });

  it("strictly decodes a privacy-minimized assigned-work page", () => {
    const item = {
      categoryCode: "annual",
      employeeDisplayName: "Employee A",
      endDate: "2026-07-12",
      leaveRequestId: leaveRequest.leaveRequestId,
      reason: "Rest",
      startDate: "2026-07-11",
      submittedAt: leaveRequest.submittedAt,
      version: 1,
      workItemId: "11111111-1111-4111-8111-111111111111",
    };
    const page = {
      items: [item],
      nextCursor: {
        leaveRequestId: leaveRequest.leaveRequestId,
        submittedAt: leaveRequest.submittedAt,
      },
    };

    expect(parseHrAssignedLeaveRequestPage(page)).toBe(page);
    expect(hrAssignedLeaveRequestPageSchema.properties.items.maxItems).toBe(50);
    expect(() =>
      parseHrAssignedLeaveRequestPage({
        items: [{ ...item, tenantId: leaveRequest.tenantId }],
        nextCursor: null,
      }),
    ).toThrow("unexpected or missing fields");
  });

  it("strictly decodes API problem details", () => {
    const problem = {
      code: "LEAVE_MANAGER_REQUIRED",
      detail: "Employee has no active assigned manager",
      instance: "/v1/hr/leave-requests",
      requestId: "request-1",
      status: 422,
      title: "Unprocessable Content",
      type: "urn:esbla:problem:leave_manager_required",
    };
    expect(parseApiProblemDetails(problem)).toBe(problem);
    expect(() => parseApiProblemDetails({ ...problem, privateDetail: "secret" })).toThrow(
      "unexpected or missing fields",
    );
    expect(() => parseApiProblemDetails({ ...problem, status: 200 })).toThrow("HTTP error status");
  });

  it("rejects malformed, over-broad, or calendar-invalid page payloads", () => {
    expect(() => parseHrLeaveRequestPage({ items: [], nextCursor: null, surprise: true })).toThrow(
      "unexpected or missing fields",
    );
    expect(() =>
      parseHrLeaveRequestPage({
        items: [{ ...leaveRequest, startDate: "2026-02-31" }],
        nextCursor: null,
      }),
    ).toThrow("valid calendar date");
    expect(() =>
      parseHrLeaveRequestPage({
        items: [{ ...leaveRequest, submittedAt: "July 10, 2026" }],
        nextCursor: null,
      }),
    ).toThrow("ISO date-time");
    expect(() =>
      parseHrLeaveRequestPage({
        items: [{ ...leaveRequest, reason: "x".repeat(2001) }],
        nextCursor: null,
      }),
    ).toThrow("at most 2000 characters");
    expect(() =>
      parseHrLeaveRequestPage({
        items: Array.from({ length: 51 }, () => leaveRequest),
        nextCursor: null,
      }),
    ).toThrow("at most 50");
  });
});
