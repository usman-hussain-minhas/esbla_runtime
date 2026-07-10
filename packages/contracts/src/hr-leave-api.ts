const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

export type HrLeaveCategoryCode = "annual" | "other" | "sick" | "unpaid";
export type HrLeaveRequestStatus = "approved" | "rejected" | "submitted";

export interface HrLeaveRequest {
  readonly approverPrincipalId: string;
  readonly categoryCode: HrLeaveCategoryCode;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly employeePrincipalId: string;
  readonly endDate: string;
  readonly idempotencyKey: string;
  readonly leaveRequestId: string;
  readonly reason: string | null;
  readonly startDate: string;
  readonly status: HrLeaveRequestStatus;
  readonly submittedAt: string;
  readonly tenantId: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface HrLeaveRequestCursor {
  readonly leaveRequestId: string;
  readonly submittedAt: string;
}

export interface HrLeaveRequestPage {
  readonly items: readonly HrLeaveRequest[];
  readonly nextCursor: HrLeaveRequestCursor | null;
}

export interface ApiProblemDetails {
  readonly code: string;
  readonly detail: string;
  readonly instance: string;
  readonly requestId: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
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
    items: { items: { $ref: "LeaveRequest#" }, maxItems: 50, type: "array" },
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

const leaveRequestKeys = [
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
] as const;

const problemDetailsKeys = [
  "code",
  "detail",
  "instance",
  "requestId",
  "status",
  "title",
  "type",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string) {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!new RegExp(uuidPattern).test(value)) throw new TypeError(`${label} must be a UUID`);
}

function assertDate(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`${label} must be an ISO date`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError(`${label} must be a valid calendar date`);
  }
}

function assertDateTime(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!dateTimePattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    assertString(value, label);
    if (value.length > 2000) throw new TypeError(`${label} must be at most 2000 characters`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertLeaveRequest(value: unknown, label: string): asserts value is HrLeaveRequest {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, leaveRequestKeys, label);
  for (const key of [
    "approverPrincipalId",
    "correlationId",
    "employeePrincipalId",
    "idempotencyKey",
    "leaveRequestId",
    "tenantId",
  ] as const) {
    assertUuid(value[key], `${label}.${key}`);
  }
  for (const key of ["createdAt", "submittedAt", "updatedAt"] as const) {
    assertDateTime(value[key], `${label}.${key}`);
  }
  if (value.decidedAt !== null) {
    assertDateTime(value.decidedAt, `${label}.decidedAt`);
  }
  for (const key of ["startDate", "endDate"] as const) {
    assertDate(value[key], `${label}.${key}`);
  }
  assertNullableString(value.decisionNote, `${label}.decisionNote`);
  assertNullableString(value.reason, `${label}.reason`);
  if (
    !(["annual", "other", "sick", "unpaid"] as const).includes(
      value.categoryCode as HrLeaveCategoryCode,
    )
  ) {
    throw new TypeError(`${label}.categoryCode is invalid`);
  }
  if (
    !(["approved", "rejected", "submitted"] as const).includes(value.status as HrLeaveRequestStatus)
  ) {
    throw new TypeError(`${label}.status is invalid`);
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new TypeError(`${label}.version must be a positive integer`);
  }
}

function assertCursor(value: unknown): asserts value is HrLeaveRequestCursor {
  if (!isRecord(value))
    throw new TypeError("LeaveRequestPage.nextCursor must be an object or null");
  assertExactKeys(value, ["leaveRequestId", "submittedAt"], "LeaveRequestPage.nextCursor");
  assertUuid(value.leaveRequestId, "LeaveRequestPage.nextCursor.leaveRequestId");
  assertDateTime(value.submittedAt, "LeaveRequestPage.nextCursor.submittedAt");
}

export function parseHrLeaveRequestPage(value: unknown): HrLeaveRequestPage {
  if (!isRecord(value)) throw new TypeError("LeaveRequestPage must be an object");
  assertExactKeys(value, ["items", "nextCursor"], "LeaveRequestPage");
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw new TypeError("LeaveRequestPage.items must be an array of at most 50 requests");
  }
  value.items.forEach((item, index) => {
    assertLeaveRequest(item, `LeaveRequestPage.items[${index}]`);
  });
  if (value.nextCursor !== null) assertCursor(value.nextCursor);
  return value as unknown as HrLeaveRequestPage;
}

export function parseHrLeaveRequest(value: unknown): HrLeaveRequest {
  assertLeaveRequest(value, "LeaveRequest");
  return value;
}

export function parseApiProblemDetails(value: unknown): ApiProblemDetails {
  if (!isRecord(value)) throw new TypeError("ProblemDetails must be an object");
  assertExactKeys(value, problemDetailsKeys, "ProblemDetails");
  for (const key of ["code", "detail", "instance", "requestId", "title", "type"] as const) {
    assertNonEmptyString(value[key], `ProblemDetails.${key}`);
  }
  if (
    !Number.isSafeInteger(value.status) ||
    (value.status as number) < 400 ||
    (value.status as number) > 599
  ) {
    throw new TypeError("ProblemDetails.status must be an HTTP error status");
  }
  return value as unknown as ApiProblemDetails;
}
