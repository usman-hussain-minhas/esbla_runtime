const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const uuidExpression = new RegExp(uuidPattern);
const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const dateExpression = new RegExp(datePattern);
const instantPattern =
  "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$";
const instantExpression = new RegExp(instantPattern);
const maximumPostgresInteger = 2_147_483_647;

export const hrShiftRosterStatuses = ["draft", "published", "superseded"] as const;
export const hrShiftAssignmentStatuses = ["active", "cancelled"] as const;
export const hrShiftAccessScopes = ["assigned", "own", "tenant"] as const;

export type HrShiftRosterStatus = (typeof hrShiftRosterStatuses)[number];
export type HrShiftAssignmentStatus = (typeof hrShiftAssignmentStatuses)[number];
export type HrShiftAccessScope = (typeof hrShiftAccessScopes)[number];

export interface HrShiftCreateRosterBody {
  readonly periodEnd: string;
  readonly periodStart: string;
}

export interface HrShiftAssignBody {
  readonly endsAt: string;
  readonly ianaTimezone: string;
  readonly startsAt: string;
  readonly workerProfileId: string;
}

export interface HrShiftExpectedVersionBody {
  readonly expectedVersion: number;
}

export type HrShiftPublishRosterBody = HrShiftExpectedVersionBody;
export type HrShiftCancelAssignmentBody = HrShiftExpectedVersionBody;

export interface HrShiftRosterPath {
  readonly rosterVersionId: string;
}

export interface HrShiftAssignmentPath {
  readonly shiftAssignmentId: string;
}

export type HrShiftDetailQuery = Readonly<Record<string, never>>;

interface HrShiftListCursorQuery {
  readonly cursorShiftAssignmentId?: string;
  readonly cursorStartsAt?: string;
  readonly pageSize?: number;
}

export type HrShiftListQuery =
  | (HrShiftListCursorQuery &
      Readonly<{
        mode: "own";
        rangeEnd: string;
        rangeStart: string;
      }>)
  | (HrShiftListCursorQuery &
      Readonly<{
        mode: "roster";
        rosterVersionId: string;
        status: HrShiftAssignmentStatus;
      }>);

export interface HrShiftRoster {
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly periodVersion: number;
  readonly publishedAt: string | null;
  readonly rosterVersionId: string;
  readonly status: HrShiftRosterStatus;
  readonly supersedesRosterVersionId: string | null;
  readonly version: number;
}

export interface HrShiftAssignment {
  readonly endsAt: string;
  readonly ianaTimezone: string;
  readonly rosterVersionId: string;
  readonly shiftAssignmentId: string;
  readonly startsAt: string;
  readonly status: HrShiftAssignmentStatus;
  readonly version: number;
  readonly workerProfileId: string;
}

export type HrShiftAssignmentHistoryEvent =
  | Readonly<{
      eventType: "hr.shift_assignment.assign_shift";
      newState: "active";
      occurredAt: string;
      priorState: null;
    }>
  | Readonly<{
      eventType: "hr.shift_assignment.cancel_assignment";
      newState: "cancelled";
      occurredAt: string;
      priorState: "active";
    }>;

export interface HrShiftAssignmentResponse {
  readonly assignment: HrShiftAssignment;
  readonly history: readonly HrShiftAssignmentHistoryEvent[];
}

export interface HrShiftListCursor {
  readonly shiftAssignmentId: string;
  readonly startsAt: string;
}

export interface HrShiftListResponse {
  readonly accessScope: HrShiftAccessScope;
  readonly items: readonly HrShiftAssignment[];
  readonly nextCursor: HrShiftListCursor | null;
}

const uuidSchema = { pattern: uuidPattern, type: "string" } as const;
const dateSchema = { format: "date", pattern: datePattern, type: "string" } as const;
const instantSchema = { format: "date-time", pattern: instantPattern, type: "string" } as const;
const positivePostgresIntegerSchema = {
  maximum: maximumPostgresInteger,
  minimum: 1,
  type: "integer",
} as const;
const pageSizeSchema = { maximum: 50, minimum: 1, type: "integer" } as const;
const assignmentStatusSchema = { enum: hrShiftAssignmentStatuses } as const;

export const hrShiftCreateRosterBodySchema = {
  $id: "HrShiftCreateRosterRequestV1",
  additionalProperties: false,
  properties: { periodEnd: dateSchema, periodStart: dateSchema },
  required: ["periodEnd", "periodStart"],
  type: "object",
} as const;

export const hrShiftAssignBodySchema = {
  $id: "HrShiftAssignRequestV1",
  additionalProperties: false,
  properties: {
    endsAt: instantSchema,
    ianaTimezone: { pattern: "^(?=.*\\S)[\\s\\S]+$", type: "string" },
    startsAt: instantSchema,
    workerProfileId: uuidSchema,
  },
  required: ["endsAt", "ianaTimezone", "startsAt", "workerProfileId"],
  type: "object",
} as const;

export const hrShiftPublishRosterBodySchema = {
  $id: "HrShiftPublishRosterRequestV1",
  additionalProperties: false,
  properties: { expectedVersion: positivePostgresIntegerSchema },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const hrShiftCancelAssignmentBodySchema = {
  $id: "HrShiftCancelAssignmentRequestV1",
  additionalProperties: false,
  properties: { expectedVersion: positivePostgresIntegerSchema },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const hrShiftRosterPathSchema = {
  $id: "HrShiftRosterPathV1",
  additionalProperties: false,
  properties: { rosterVersionId: uuidSchema },
  required: ["rosterVersionId"],
  type: "object",
} as const;

export const hrShiftAssignmentPathSchema = {
  $id: "HrShiftAssignmentPathV1",
  additionalProperties: false,
  properties: { shiftAssignmentId: uuidSchema },
  required: ["shiftAssignmentId"],
  type: "object",
} as const;

export const hrShiftDetailQuerySchema = {
  $id: "HrShiftDetailQueryV1",
  additionalProperties: false,
  properties: {},
  type: "object",
} as const;

const listCursorQueryProperties = {
  cursorShiftAssignmentId: uuidSchema,
  cursorStartsAt: instantSchema,
  pageSize: pageSizeSchema,
} as const;

export const hrShiftListQuerySchema = {
  $id: "HrShiftListQueryV1",
  oneOf: [
    {
      additionalProperties: false,
      dependencies: {
        cursorShiftAssignmentId: ["cursorStartsAt"],
        cursorStartsAt: ["cursorShiftAssignmentId"],
      },
      properties: {
        ...listCursorQueryProperties,
        mode: { const: "own" },
        rangeEnd: instantSchema,
        rangeStart: instantSchema,
      },
      required: ["mode", "rangeEnd", "rangeStart"],
      type: "object",
    },
    {
      additionalProperties: false,
      dependencies: {
        cursorShiftAssignmentId: ["cursorStartsAt"],
        cursorStartsAt: ["cursorShiftAssignmentId"],
      },
      properties: {
        ...listCursorQueryProperties,
        mode: { const: "roster" },
        rosterVersionId: uuidSchema,
        status: assignmentStatusSchema,
      },
      required: ["mode", "rosterVersionId", "status"],
      type: "object",
    },
  ],
} as const;

const rosterProperties = {
  periodEnd: dateSchema,
  periodStart: dateSchema,
  periodVersion: positivePostgresIntegerSchema,
  publishedAt: { anyOf: [instantSchema, { type: "null" }] },
  rosterVersionId: uuidSchema,
  status: { enum: hrShiftRosterStatuses },
  supersedesRosterVersionId: { pattern: uuidPattern, type: ["string", "null"] },
  version: positivePostgresIntegerSchema,
} as const;
const rosterRequired = [
  "periodEnd",
  "periodStart",
  "periodVersion",
  "publishedAt",
  "rosterVersionId",
  "status",
  "supersedesRosterVersionId",
  "version",
] as const;

export const hrShiftRosterResponseSchema = {
  $id: "HrShiftRosterResponseV1",
  additionalProperties: false,
  properties: rosterProperties,
  required: rosterRequired,
  type: "object",
} as const;

const assignmentProperties = {
  endsAt: instantSchema,
  ianaTimezone: { pattern: "^(?=.*\\S)[\\s\\S]+$", type: "string" },
  rosterVersionId: uuidSchema,
  shiftAssignmentId: uuidSchema,
  startsAt: instantSchema,
  status: assignmentStatusSchema,
  version: positivePostgresIntegerSchema,
  workerProfileId: uuidSchema,
} as const;
const assignmentRequired = [
  "endsAt",
  "ianaTimezone",
  "rosterVersionId",
  "shiftAssignmentId",
  "startsAt",
  "status",
  "version",
  "workerProfileId",
] as const;
const assignmentSchema = {
  additionalProperties: false,
  properties: assignmentProperties,
  required: assignmentRequired,
  type: "object",
} as const;
const assignmentHistorySchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        eventType: { const: "hr.shift_assignment.assign_shift" },
        newState: { const: "active" },
        occurredAt: instantSchema,
        priorState: { type: "null" },
      },
      required: ["eventType", "newState", "occurredAt", "priorState"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        eventType: { const: "hr.shift_assignment.cancel_assignment" },
        newState: { const: "cancelled" },
        occurredAt: instantSchema,
        priorState: { const: "active" },
      },
      required: ["eventType", "newState", "occurredAt", "priorState"],
      type: "object",
    },
  ],
} as const;

export const hrShiftAssignmentResponseSchema = {
  $id: "HrShiftAssignmentResponseV1",
  additionalProperties: false,
  properties: {
    assignment: assignmentSchema,
    history: { items: assignmentHistorySchema, maxItems: 2, minItems: 1, type: "array" },
  },
  required: ["assignment", "history"],
  type: "object",
} as const;

const listCursorSchema = {
  additionalProperties: false,
  properties: { shiftAssignmentId: uuidSchema, startsAt: instantSchema },
  required: ["shiftAssignmentId", "startsAt"],
  type: "object",
} as const;

export const hrShiftListResponseSchema = {
  $id: "HrShiftAssignmentListResponseV1",
  additionalProperties: false,
  properties: {
    accessScope: { enum: hrShiftAccessScopes },
    items: { items: assignmentSchema, maxItems: 50, type: "array" },
    nextCursor: { anyOf: [listCursorSchema, { type: "null" }] },
  },
  required: ["accessScope", "items", "nextCursor"],
  type: "object",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !uuidExpression.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
}

function assertPositivePostgresInteger(value: unknown, label: string): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximumPostgresInteger
  ) {
    throw new TypeError(`${label} must be a positive PostgreSQL integer`);
  }
}

function assertPageSize(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new TypeError(`${label} must be an integer from 1 through 50`);
  }
}

function isValidCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

function assertDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !dateExpression.test(value) || !isValidCalendarDate(value)) {
    throw new TypeError(`${label} must be a valid calendar date`);
  }
}

function assertInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO instant`);
  const match = instantExpression.exec(value);
  if (!match || !isValidCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)) {
    throw new TypeError(`${label} must be an ISO instant`);
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7] as string;
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offset !== "Z" &&
      (Number(offset.slice(1, 3)) > 14 ||
        Number(offset.slice(4, 6)) > 59 ||
        (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4, 6)) !== 0))) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO instant`);
  }
}

function assertCanonicalInstant(value: unknown, label: string): asserts value is string {
  assertInstant(value, label);
  if (new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO instant`);
  }
}

function assertIanaTimezone(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank IANA timezone`);
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw new TypeError(`${label} must be a valid IANA timezone`);
  }
}

export function parseHrShiftCreateRosterBody(value: unknown): HrShiftCreateRosterBody {
  if (!isRecord(value)) throw new TypeError("HrShiftCreateRosterRequestV1 must be an object");
  assertExactKeys(value, ["periodEnd", "periodStart"], [], "HrShiftCreateRosterRequestV1");
  assertDate(value.periodStart, "HrShiftCreateRosterRequestV1.periodStart");
  assertDate(value.periodEnd, "HrShiftCreateRosterRequestV1.periodEnd");
  if (value.periodEnd < value.periodStart) {
    throw new TypeError("HrShiftCreateRosterRequestV1 period is invalid");
  }
  return value as unknown as HrShiftCreateRosterBody;
}

export function parseHrShiftAssignBody(value: unknown): HrShiftAssignBody {
  if (!isRecord(value)) throw new TypeError("HrShiftAssignRequestV1 must be an object");
  assertExactKeys(
    value,
    ["endsAt", "ianaTimezone", "startsAt", "workerProfileId"],
    [],
    "HrShiftAssignRequestV1",
  );
  assertUuid(value.workerProfileId, "HrShiftAssignRequestV1.workerProfileId");
  assertInstant(value.startsAt, "HrShiftAssignRequestV1.startsAt");
  assertInstant(value.endsAt, "HrShiftAssignRequestV1.endsAt");
  assertIanaTimezone(value.ianaTimezone, "HrShiftAssignRequestV1.ianaTimezone");
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    throw new TypeError("HrShiftAssignRequestV1 time range is invalid");
  }
  return value as unknown as HrShiftAssignBody;
}

function parseExpectedVersionBody(value: unknown, label: string): HrShiftExpectedVersionBody {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["expectedVersion"], [], label);
  assertPositivePostgresInteger(value.expectedVersion, `${label}.expectedVersion`);
  return value as unknown as HrShiftExpectedVersionBody;
}

export function parseHrShiftPublishRosterBody(value: unknown): HrShiftPublishRosterBody {
  return parseExpectedVersionBody(value, "HrShiftPublishRosterRequestV1");
}

export function parseHrShiftCancelAssignmentBody(value: unknown): HrShiftCancelAssignmentBody {
  return parseExpectedVersionBody(value, "HrShiftCancelAssignmentRequestV1");
}

export function parseHrShiftRosterPath(value: unknown): HrShiftRosterPath {
  if (!isRecord(value)) throw new TypeError("HrShiftRosterPathV1 must be an object");
  assertExactKeys(value, ["rosterVersionId"], [], "HrShiftRosterPathV1");
  assertUuid(value.rosterVersionId, "HrShiftRosterPathV1.rosterVersionId");
  return value as unknown as HrShiftRosterPath;
}

export function parseHrShiftAssignmentPath(value: unknown): HrShiftAssignmentPath {
  if (!isRecord(value)) throw new TypeError("HrShiftAssignmentPathV1 must be an object");
  assertExactKeys(value, ["shiftAssignmentId"], [], "HrShiftAssignmentPathV1");
  assertUuid(value.shiftAssignmentId, "HrShiftAssignmentPathV1.shiftAssignmentId");
  return value as unknown as HrShiftAssignmentPath;
}

export function parseHrShiftDetailQuery(value: unknown): HrShiftDetailQuery {
  if (!isRecord(value)) throw new TypeError("HrShiftDetailQueryV1 must be an object");
  assertExactKeys(value, [], [], "HrShiftDetailQueryV1");
  return value as HrShiftDetailQuery;
}

export function parseHrShiftListQuery(value: unknown): HrShiftListQuery {
  if (!isRecord(value)) throw new TypeError("HrShiftListQueryV1 must be an object");
  const cursorFields = ["cursorShiftAssignmentId", "cursorStartsAt", "pageSize"] as const;
  if (value.mode === "own") {
    assertExactKeys(value, ["mode", "rangeEnd", "rangeStart"], cursorFields, "HrShiftListQueryV1");
    assertInstant(value.rangeStart, "HrShiftListQueryV1.rangeStart");
    assertInstant(value.rangeEnd, "HrShiftListQueryV1.rangeEnd");
    if (Date.parse(value.rangeEnd) <= Date.parse(value.rangeStart)) {
      throw new TypeError("HrShiftListQueryV1 range is invalid");
    }
  } else if (value.mode === "roster") {
    assertExactKeys(
      value,
      ["mode", "rosterVersionId", "status"],
      cursorFields,
      "HrShiftListQueryV1",
    );
    assertUuid(value.rosterVersionId, "HrShiftListQueryV1.rosterVersionId");
    if (!(hrShiftAssignmentStatuses as readonly unknown[]).includes(value.status)) {
      throw new TypeError("HrShiftListQueryV1.status is invalid");
    }
  } else {
    throw new TypeError("HrShiftListQueryV1.mode is invalid");
  }
  const hasCursorId = Object.hasOwn(value, "cursorShiftAssignmentId");
  const hasCursorStart = Object.hasOwn(value, "cursorStartsAt");
  if (hasCursorId !== hasCursorStart) {
    throw new TypeError("HrShiftListQueryV1 cursor must be paired");
  }
  if (hasCursorId) {
    assertUuid(value.cursorShiftAssignmentId, "HrShiftListQueryV1.cursorShiftAssignmentId");
    assertCanonicalInstant(value.cursorStartsAt, "HrShiftListQueryV1.cursorStartsAt");
  }
  if (Object.hasOwn(value, "pageSize")) {
    assertPageSize(value.pageSize, "HrShiftListQueryV1.pageSize");
  }
  return value as unknown as HrShiftListQuery;
}

function parseRoster(value: unknown, label: string): HrShiftRoster {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, rosterRequired, [], label);
  assertUuid(value.rosterVersionId, `${label}.rosterVersionId`);
  assertDate(value.periodStart, `${label}.periodStart`);
  assertDate(value.periodEnd, `${label}.periodEnd`);
  if (value.periodEnd < value.periodStart) throw new TypeError(`${label} period is invalid`);
  assertPositivePostgresInteger(value.periodVersion, `${label}.periodVersion`);
  assertPositivePostgresInteger(value.version, `${label}.version`);
  if (!(hrShiftRosterStatuses as readonly unknown[]).includes(value.status)) {
    throw new TypeError(`${label}.status is invalid`);
  }
  if (value.supersedesRosterVersionId !== null) {
    assertUuid(value.supersedesRosterVersionId, `${label}.supersedesRosterVersionId`);
  }
  if (value.publishedAt === null) {
    if (value.status !== "draft") throw new TypeError(`${label}.publishedAt conflicts with status`);
  } else {
    assertCanonicalInstant(value.publishedAt, `${label}.publishedAt`);
    if (value.status === "draft") throw new TypeError(`${label}.publishedAt conflicts with status`);
  }
  return value as unknown as HrShiftRoster;
}

export function parseHrShiftRosterResponse(value: unknown): HrShiftRoster {
  return parseRoster(value, "HrShiftRosterResponseV1");
}

function parseAssignment(value: unknown, label: string): HrShiftAssignment {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, assignmentRequired, [], label);
  assertUuid(value.shiftAssignmentId, `${label}.shiftAssignmentId`);
  assertUuid(value.rosterVersionId, `${label}.rosterVersionId`);
  assertUuid(value.workerProfileId, `${label}.workerProfileId`);
  assertCanonicalInstant(value.startsAt, `${label}.startsAt`);
  assertCanonicalInstant(value.endsAt, `${label}.endsAt`);
  assertIanaTimezone(value.ianaTimezone, `${label}.ianaTimezone`);
  assertPositivePostgresInteger(value.version, `${label}.version`);
  if (!(hrShiftAssignmentStatuses as readonly unknown[]).includes(value.status)) {
    throw new TypeError(`${label}.status is invalid`);
  }
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    throw new TypeError(`${label} time range is invalid`);
  }
  return value as unknown as HrShiftAssignment;
}

function parseHistoryEvent(value: unknown, index: number): HrShiftAssignmentHistoryEvent {
  const label = `HrShiftAssignmentResponseV1.history[${index}]`;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["eventType", "newState", "occurredAt", "priorState"], [], label);
  assertCanonicalInstant(value.occurredAt, `${label}.occurredAt`);
  const isAssigned =
    value.eventType === "hr.shift_assignment.assign_shift" &&
    value.priorState === null &&
    value.newState === "active";
  const isCancelled =
    value.eventType === "hr.shift_assignment.cancel_assignment" &&
    value.priorState === "active" &&
    value.newState === "cancelled";
  if (!isAssigned && !isCancelled) throw new TypeError(`${label} transition is invalid`);
  return value as unknown as HrShiftAssignmentHistoryEvent;
}

export function parseHrShiftAssignmentResponse(value: unknown): HrShiftAssignmentResponse {
  if (!isRecord(value)) throw new TypeError("HrShiftAssignmentResponseV1 must be an object");
  assertExactKeys(value, ["assignment", "history"], [], "HrShiftAssignmentResponseV1");
  const assignment = parseAssignment(value.assignment, "HrShiftAssignmentResponseV1.assignment");
  if (!Array.isArray(value.history) || value.history.length < 1 || value.history.length > 2) {
    throw new TypeError("HrShiftAssignmentResponseV1.history is invalid");
  }
  const history = value.history.map(parseHistoryEvent);
  if (
    history[0]?.eventType !== "hr.shift_assignment.assign_shift" ||
    (history.length === 2 && history[1]?.eventType !== "hr.shift_assignment.cancel_assignment") ||
    history.some((event, index) => {
      const previous = history[index - 1];
      return previous ? Date.parse(event.occurredAt) < Date.parse(previous.occurredAt) : false;
    }) ||
    assignment.status !== history[history.length - 1]?.newState ||
    assignment.version !== history.length
  ) {
    throw new TypeError("HrShiftAssignmentResponseV1 history conflicts with assignment");
  }
  return value as unknown as HrShiftAssignmentResponse;
}

export function parseHrShiftListResponse(value: unknown): HrShiftListResponse {
  if (!isRecord(value)) throw new TypeError("HrShiftAssignmentListResponseV1 must be an object");
  assertExactKeys(
    value,
    ["accessScope", "items", "nextCursor"],
    [],
    "HrShiftAssignmentListResponseV1",
  );
  if (!(hrShiftAccessScopes as readonly unknown[]).includes(value.accessScope)) {
    throw new TypeError("HrShiftAssignmentListResponseV1.accessScope is invalid");
  }
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw new TypeError("HrShiftAssignmentListResponseV1.items is invalid");
  }
  for (const item of value.items) {
    parseAssignment(item, "HrShiftAssignmentListResponseV1.items[]");
  }
  if (value.nextCursor !== null) {
    if (!isRecord(value.nextCursor)) {
      throw new TypeError("HrShiftAssignmentListResponseV1.nextCursor is invalid");
    }
    assertExactKeys(
      value.nextCursor,
      ["shiftAssignmentId", "startsAt"],
      [],
      "HrShiftAssignmentListResponseV1.nextCursor",
    );
    assertUuid(
      value.nextCursor.shiftAssignmentId,
      "HrShiftAssignmentListResponseV1.nextCursor.shiftAssignmentId",
    );
    assertCanonicalInstant(
      value.nextCursor.startsAt,
      "HrShiftAssignmentListResponseV1.nextCursor.startsAt",
    );
  }
  return value as unknown as HrShiftListResponse;
}
