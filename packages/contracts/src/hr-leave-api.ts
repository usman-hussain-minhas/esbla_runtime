const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";

export interface HrSubmitLeaveRequestBody {
  readonly categoryCode: "annual" | "other" | "sick" | "unpaid";
  readonly endDate: string;
  readonly reason?: string;
  readonly startDate: string;
}

export interface HrDecideLeaveRequestBody {
  readonly decisionNote?: string;
  readonly expectedVersion: number;
}

export interface HrLeaveListQuery {
  readonly cursorLeaveRequestId?: string;
  readonly cursorSubmittedAt?: string;
  readonly pageSize?: number;
}

export interface HrLeaveRequestPath {
  readonly leaveRequestId: string;
}

export const hrSubmitLeaveRequestBodySchema = {
  $id: "SubmitLeaveRequest",
  additionalProperties: false,
  properties: {
    categoryCode: { enum: ["annual", "sick", "unpaid", "other"] },
    endDate: { pattern: datePattern, type: "string" },
    reason: { maxLength: 2000, minLength: 1, type: "string" },
    startDate: { pattern: datePattern, type: "string" },
  },
  required: ["categoryCode", "endDate", "startDate"],
  type: "object",
} as const;

export const hrDecideLeaveRequestBodySchema = {
  $id: "DecideLeaveRequest",
  additionalProperties: false,
  properties: {
    decisionNote: { maxLength: 2000, minLength: 1, type: "string" },
    expectedVersion: { minimum: 1, type: "integer" },
  },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const hrLeaveRequestPathSchema = {
  $id: "LeaveRequestPath",
  additionalProperties: false,
  properties: { leaveRequestId: { pattern: uuidPattern, type: "string" } },
  required: ["leaveRequestId"],
  type: "object",
} as const;

const leaveListQueryDefinition = {
  additionalProperties: false,
  dependencies: {
    cursorLeaveRequestId: ["cursorSubmittedAt"],
    cursorSubmittedAt: ["cursorLeaveRequestId"],
  },
  properties: {
    cursorLeaveRequestId: { pattern: uuidPattern, type: "string" },
    cursorSubmittedAt: { format: "date-time", type: "string" },
    pageSize: { default: 50, maximum: 50, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;

export const hrLeaveListQuerySchema = {
  $id: "ListLeaveRequestsQuery",
  ...leaveListQueryDefinition,
} as const;

export const hrAssignedLeaveListQuerySchema = {
  $id: "AssignedLeaveRequestsQuery",
  ...leaveListQueryDefinition,
} as const;

export const hrLeaveRequestSchema = {
  $id: "LeaveRequest",
  additionalProperties: false,
  properties: {
    approverPrincipalId: { pattern: uuidPattern, type: "string" },
    categoryCode: { enum: ["annual", "sick", "unpaid", "other"] },
    correlationId: { pattern: uuidPattern, type: "string" },
    createdAt: { format: "date-time", type: "string" },
    decidedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
    decisionNote: { anyOf: [{ maxLength: 2000, type: "string" }, { type: "null" }] },
    employeePrincipalId: { pattern: uuidPattern, type: "string" },
    endDate: { pattern: datePattern, type: "string" },
    idempotencyKey: { pattern: uuidPattern, type: "string" },
    leaveRequestId: { pattern: uuidPattern, type: "string" },
    reason: { anyOf: [{ maxLength: 2000, type: "string" }, { type: "null" }] },
    startDate: { pattern: datePattern, type: "string" },
    status: { enum: ["submitted", "approved", "rejected"] },
    submittedAt: { format: "date-time", type: "string" },
    tenantId: { pattern: uuidPattern, type: "string" },
    updatedAt: { format: "date-time", type: "string" },
    version: { minimum: 1, type: "integer" },
  },
  required: [
    "approverPrincipalId",
    "categoryCode",
    "correlationId",
    "createdAt",
    "decidedAt",
    "decisionNote",
    "employeePrincipalId",
    "endDate",
    "idempotencyKey",
    "leaveRequestId",
    "reason",
    "startDate",
    "status",
    "submittedAt",
    "tenantId",
    "updatedAt",
    "version",
  ],
  type: "object",
} as const;

export const hrLeaveEvidenceEventSchema = {
  $id: "LeaveEvidenceEvent",
  additionalProperties: false,
  properties: {
    actorPrincipalId: { pattern: uuidPattern, type: "string" },
    correlationId: { pattern: uuidPattern, type: "string" },
    eventType: {
      enum: [
        "evidence.hr.leave_request.submitted",
        "evidence.hr.leave_request.approved",
        "evidence.hr.leave_request.rejected",
      ],
    },
    evidenceEventId: { pattern: uuidPattern, type: "string" },
    newState: { enum: ["submitted", "approved", "rejected"] },
    occurredAt: { format: "date-time", type: "string" },
    priorState: { anyOf: [{ enum: ["submitted"] }, { type: "null" }] },
  },
  required: [
    "actorPrincipalId",
    "correlationId",
    "eventType",
    "evidenceEventId",
    "newState",
    "occurredAt",
    "priorState",
  ],
  type: "object",
} as const;

export const hrLeaveRequestPageSchema = {
  $id: "LeaveRequestPage",
  additionalProperties: false,
  properties: {
    items: { items: { $ref: "LeaveRequest#" }, type: "array" },
    nextCursor: {
      anyOf: [
        {
          additionalProperties: false,
          properties: {
            leaveRequestId: { pattern: uuidPattern, type: "string" },
            submittedAt: { format: "date-time", type: "string" },
          },
          required: ["leaveRequestId", "submittedAt"],
          type: "object",
        },
        { type: "null" },
      ],
    },
  },
  required: ["items", "nextCursor"],
  type: "object",
} as const;

export const hrLeaveRequestDetailSchema = {
  $id: "LeaveRequestDetail",
  additionalProperties: false,
  properties: {
    history: { items: { $ref: "LeaveEvidenceEvent#" }, maxItems: 100, type: "array" },
    request: { $ref: "LeaveRequest#" },
  },
  required: ["request", "history"],
  type: "object",
} as const;

export const problemDetailsSchema = {
  $id: "ProblemDetails",
  additionalProperties: false,
  properties: {
    code: { minLength: 1, type: "string" },
    detail: { minLength: 1, type: "string" },
    instance: { minLength: 1, type: "string" },
    requestId: { minLength: 1, type: "string" },
    status: { maximum: 599, minimum: 400, type: "integer" },
    title: { minLength: 1, type: "string" },
    type: { minLength: 1, type: "string" },
  },
  required: ["type", "title", "status", "detail", "instance", "code", "requestId"],
  type: "object",
} as const;
