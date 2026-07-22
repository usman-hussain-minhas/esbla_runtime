const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const uuidExpression = new RegExp(uuidPattern);
const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const dateExpression = new RegExp(datePattern);
const maximumPostgresInteger = 2_147_483_647;

export const hrEmploymentRecordStatuses = ["draft", "active", "ended"] as const;
export const hrEmploymentRecordVersionKinds = ["effective", "end"] as const;

export type HrEmploymentRecordStatus = (typeof hrEmploymentRecordStatuses)[number];
export type HrEmploymentRecordVersionKind = (typeof hrEmploymentRecordVersionKinds)[number];
export type HrEmploymentAccessScope = "own" | "tenant";

export interface HrEmploymentCreateRecordBody {
  readonly workerProfileId: string;
}

export interface HrEmploymentCreateVersionBody {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly employmentTypeCode: string | null;
  readonly expectedCurrentVersion: number | null;
  readonly expectedVersion: number;
  readonly organizationReference: string | null;
  readonly positionReference: string | null;
}

export interface HrEmploymentEndRecordBody {
  readonly effectiveTo: string;
  readonly expectedCurrentVersion: number;
  readonly expectedVersion: number;
}

export interface HrEmploymentRecordPath {
  readonly employmentRecordId: string;
}

export interface HrEmploymentListQuery {
  readonly cursorCreatedAt?: string;
  readonly cursorEmploymentRecordId?: string;
  readonly pageSize?: number;
}

export interface HrEmploymentDetailQuery {
  readonly cursorVersion?: number;
  readonly cursorEmploymentRecordVersionId?: string;
  readonly pageSize?: number;
}

export interface HrEmploymentRecordVersion {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly employmentTypeCode: string | null;
  readonly employmentRecordVersionId: string;
  readonly kind: HrEmploymentRecordVersionKind;
  readonly organizationReference: string | null;
  readonly positionReference: string | null;
  readonly rowVersion: number;
  readonly supersedesVersionId: string | null;
  readonly terminal: boolean;
  readonly version: number;
}

export interface HrEmploymentHistoryCursor {
  readonly version: number;
  readonly employmentRecordVersionId: string;
}

export interface HrEmploymentHistoryPage {
  readonly items: readonly HrEmploymentRecordVersion[];
  readonly nextCursor: HrEmploymentHistoryCursor | null;
}

export interface HrEmploymentRecordSummary {
  readonly createdAt: string;
  readonly currentVersion: HrEmploymentRecordVersion | null;
  readonly employmentRecordId: string;
  readonly status: HrEmploymentRecordStatus;
  readonly version: number;
  readonly workerProfileId: string;
}

export interface HrEmploymentRecord extends HrEmploymentRecordSummary {
  readonly accessScope: HrEmploymentAccessScope;
  readonly history: HrEmploymentHistoryPage;
}

export interface HrEmploymentListCursor {
  readonly createdAt: string;
  readonly employmentRecordId: string;
}

export interface HrEmploymentListResponse {
  readonly accessScope: HrEmploymentAccessScope;
  readonly items: readonly HrEmploymentRecordSummary[];
  readonly nextCursor: HrEmploymentListCursor | null;
}

const positivePostgresIntegerSchema = {
  maximum: maximumPostgresInteger,
  minimum: 1,
  type: "integer",
} as const;
const uuidSchema = { pattern: uuidPattern, type: "string" } as const;
const dateSchema = { format: "date", pattern: datePattern, type: "string" } as const;
const nullableOpaqueSchema = {
  anyOf: [{ pattern: "^(?=.*\\S)[\\s\\S]+$", type: "string" }, { type: "null" }],
} as const;
const pageSizeSchema = { maximum: 50, minimum: 1, type: "integer" } as const;

export const hrEmploymentCreateRecordBodySchema = {
  $id: "HrEmploymentCreateRecordRequestV1",
  additionalProperties: false,
  properties: { workerProfileId: uuidSchema },
  required: ["workerProfileId"],
  type: "object",
} as const;

export const hrEmploymentCreateVersionBodySchema = {
  $id: "HrEmploymentCreateVersionRequestV1",
  additionalProperties: false,
  properties: {
    effectiveFrom: dateSchema,
    effectiveTo: { anyOf: [dateSchema, { type: "null" }] },
    employmentTypeCode: nullableOpaqueSchema,
    expectedCurrentVersion: {
      anyOf: [positivePostgresIntegerSchema, { type: "null" }],
    },
    expectedVersion: positivePostgresIntegerSchema,
    organizationReference: nullableOpaqueSchema,
    positionReference: nullableOpaqueSchema,
  },
  required: [
    "effectiveFrom",
    "effectiveTo",
    "employmentTypeCode",
    "expectedCurrentVersion",
    "expectedVersion",
    "organizationReference",
    "positionReference",
  ],
  type: "object",
} as const;

export const hrEmploymentEndRecordBodySchema = {
  $id: "HrEmploymentEndRecordRequestV1",
  additionalProperties: false,
  properties: {
    effectiveTo: dateSchema,
    expectedCurrentVersion: positivePostgresIntegerSchema,
    expectedVersion: positivePostgresIntegerSchema,
  },
  required: ["effectiveTo", "expectedCurrentVersion", "expectedVersion"],
  type: "object",
} as const;

export const hrEmploymentRecordPathSchema = {
  $id: "HrEmploymentRecordPathV1",
  additionalProperties: false,
  properties: { employmentRecordId: uuidSchema },
  required: ["employmentRecordId"],
  type: "object",
} as const;

export const hrEmploymentListQuerySchema = {
  $id: "HrEmploymentListQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorCreatedAt: ["cursorEmploymentRecordId"],
    cursorEmploymentRecordId: ["cursorCreatedAt"],
  },
  properties: {
    cursorCreatedAt: { format: "date-time", type: "string" },
    cursorEmploymentRecordId: uuidSchema,
    pageSize: pageSizeSchema,
  },
  type: "object",
} as const;

export const hrEmploymentDetailQuerySchema = {
  $id: "HrEmploymentDetailQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorVersion: ["cursorEmploymentRecordVersionId"],
    cursorEmploymentRecordVersionId: ["cursorVersion"],
  },
  properties: {
    cursorVersion: positivePostgresIntegerSchema,
    cursorEmploymentRecordVersionId: uuidSchema,
    pageSize: pageSizeSchema,
  },
  type: "object",
} as const;

const employmentVersionProperties = {
  effectiveFrom: dateSchema,
  effectiveTo: { anyOf: [dateSchema, { type: "null" }] },
  employmentTypeCode: nullableOpaqueSchema,
  kind: { enum: hrEmploymentRecordVersionKinds },
  organizationReference: nullableOpaqueSchema,
  positionReference: nullableOpaqueSchema,
  rowVersion: positivePostgresIntegerSchema,
  supersedesVersionId: { pattern: uuidPattern, type: ["string", "null"] },
  terminal: { type: "boolean" },
  version: positivePostgresIntegerSchema,
  employmentRecordVersionId: uuidSchema,
} as const;
const employmentVersionRequired = [
  "effectiveFrom",
  "effectiveTo",
  "employmentTypeCode",
  "kind",
  "organizationReference",
  "positionReference",
  "rowVersion",
  "supersedesVersionId",
  "terminal",
  "version",
  "employmentRecordVersionId",
] as const;
const employmentVersionSchema = {
  additionalProperties: false,
  oneOf: [
    {
      properties: { kind: { const: "effective" }, terminal: { const: false } },
      type: "object",
    },
    {
      properties: { kind: { const: "end" }, terminal: { const: true } },
      type: "object",
    },
  ],
  properties: employmentVersionProperties,
  required: employmentVersionRequired,
  type: "object",
} as const;

export const hrEmploymentRecordVersionSchema = {
  $id: "HrEmploymentRecordVersionResponseV1",
  ...employmentVersionSchema,
} as const;

const employmentSummaryProperties = {
  createdAt: { format: "date-time", type: "string" },
  currentVersion: { anyOf: [employmentVersionSchema, { type: "null" }] },
  employmentRecordId: uuidSchema,
  status: { enum: hrEmploymentRecordStatuses },
  version: positivePostgresIntegerSchema,
  workerProfileId: uuidSchema,
} as const;
const employmentSummaryRequired = [
  "createdAt",
  "currentVersion",
  "employmentRecordId",
  "status",
  "version",
  "workerProfileId",
] as const;
const employmentSummarySchema = {
  additionalProperties: false,
  properties: employmentSummaryProperties,
  required: employmentSummaryRequired,
  type: "object",
} as const;
const historyCursorSchema = {
  additionalProperties: false,
  properties: { version: positivePostgresIntegerSchema, employmentRecordVersionId: uuidSchema },
  required: ["version", "employmentRecordVersionId"],
  type: "object",
} as const;
const historyPageSchema = {
  additionalProperties: false,
  properties: {
    items: { items: employmentVersionSchema, maxItems: 50, type: "array" },
    nextCursor: { anyOf: [historyCursorSchema, { type: "null" }] },
  },
  required: ["items", "nextCursor"],
  type: "object",
} as const;

export const hrEmploymentRecordSchema = {
  $id: "HrEmploymentRecordResponseV1",
  additionalProperties: false,
  properties: {
    ...employmentSummaryProperties,
    accessScope: { enum: ["own", "tenant"] },
    history: historyPageSchema,
  },
  required: [...employmentSummaryRequired, "accessScope", "history"],
  type: "object",
} as const;

const listCursorSchema = {
  additionalProperties: false,
  properties: {
    createdAt: { format: "date-time", type: "string" },
    employmentRecordId: uuidSchema,
  },
  required: ["createdAt", "employmentRecordId"],
  type: "object",
} as const;

export const hrEmploymentListResponseSchema = {
  $id: "HrEmploymentListResponseV1",
  additionalProperties: false,
  properties: {
    accessScope: { enum: ["own", "tenant"] },
    items: { items: employmentSummarySchema, maxItems: 50, type: "array" },
    nextCursor: { anyOf: [listCursorSchema, { type: "null" }] },
  },
  required: ["accessScope", "items", "nextCursor"],
  type: "object",
} as const;

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

function assertDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !dateExpression.test(value)) {
    throw new TypeError(`${label} must be an ISO calendar date`);
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) {
    throw new TypeError(`${label} must be a valid ISO calendar date`);
  }
}

function assertDateTime(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical ISO date-time`);
  }
}

function assertNullableOpaque(value: unknown, label: string): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
    throw new TypeError(`${label} must be nonblank text or null`);
  }
}

export function parseHrEmploymentCreateRecordBody(value: unknown): HrEmploymentCreateRecordBody {
  if (!isRecord(value)) throw new TypeError("HrEmploymentCreateRecordRequestV1 must be an object");
  assertExactKeys(value, ["workerProfileId"], "HrEmploymentCreateRecordRequestV1");
  assertUuid(value.workerProfileId, "HrEmploymentCreateRecordRequestV1.workerProfileId");
  return value as unknown as HrEmploymentCreateRecordBody;
}

export function parseHrEmploymentCreateVersionBody(value: unknown): HrEmploymentCreateVersionBody {
  if (!isRecord(value)) {
    throw new TypeError("HrEmploymentCreateVersionRequestV1 must be an object");
  }
  assertExactKeys(
    value,
    [
      "effectiveFrom",
      "effectiveTo",
      "employmentTypeCode",
      "expectedCurrentVersion",
      "expectedVersion",
      "organizationReference",
      "positionReference",
    ],
    "HrEmploymentCreateVersionRequestV1",
  );
  assertPositivePostgresInteger(
    value.expectedVersion,
    "HrEmploymentCreateVersionRequestV1.expectedVersion",
  );
  if (value.expectedCurrentVersion !== null) {
    assertPositivePostgresInteger(
      value.expectedCurrentVersion,
      "HrEmploymentCreateVersionRequestV1.expectedCurrentVersion",
    );
  }
  assertDate(value.effectiveFrom, "HrEmploymentCreateVersionRequestV1.effectiveFrom");
  if (value.effectiveTo !== null) {
    assertDate(value.effectiveTo, "HrEmploymentCreateVersionRequestV1.effectiveTo");
    if (value.effectiveTo < value.effectiveFrom) {
      throw new TypeError("HrEmploymentCreateVersionRequestV1 effective range is invalid");
    }
  }
  assertNullableOpaque(
    value.employmentTypeCode,
    "HrEmploymentCreateVersionRequestV1.employmentTypeCode",
  );
  assertNullableOpaque(
    value.organizationReference,
    "HrEmploymentCreateVersionRequestV1.organizationReference",
  );
  assertNullableOpaque(
    value.positionReference,
    "HrEmploymentCreateVersionRequestV1.positionReference",
  );
  return value as unknown as HrEmploymentCreateVersionBody;
}

export function parseHrEmploymentEndRecordBody(value: unknown): HrEmploymentEndRecordBody {
  if (!isRecord(value)) throw new TypeError("HrEmploymentEndRecordRequestV1 must be an object");
  assertExactKeys(
    value,
    ["effectiveTo", "expectedCurrentVersion", "expectedVersion"],
    "HrEmploymentEndRecordRequestV1",
  );
  assertPositivePostgresInteger(
    value.expectedVersion,
    "HrEmploymentEndRecordRequestV1.expectedVersion",
  );
  assertPositivePostgresInteger(
    value.expectedCurrentVersion,
    "HrEmploymentEndRecordRequestV1.expectedCurrentVersion",
  );
  assertDate(value.effectiveTo, "HrEmploymentEndRecordRequestV1.effectiveTo");
  return value as unknown as HrEmploymentEndRecordBody;
}

export function parseHrEmploymentRecordPath(value: unknown): HrEmploymentRecordPath {
  if (!isRecord(value)) throw new TypeError("HrEmploymentRecordPathV1 must be an object");
  assertExactKeys(value, ["employmentRecordId"], "HrEmploymentRecordPathV1");
  assertUuid(value.employmentRecordId, "HrEmploymentRecordPathV1.employmentRecordId");
  return value as unknown as HrEmploymentRecordPath;
}

export function parseHrEmploymentListQuery(value: unknown): HrEmploymentListQuery {
  if (!isRecord(value)) throw new TypeError("HrEmploymentListQueryV1 must be an object");
  const allowed = ["cursorCreatedAt", "cursorEmploymentRecordId", "pageSize"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError("HrEmploymentListQueryV1 has unexpected fields");
  }
  const hasCreatedAt = Object.hasOwn(value, "cursorCreatedAt");
  const hasRecordId = Object.hasOwn(value, "cursorEmploymentRecordId");
  if (hasCreatedAt !== hasRecordId) {
    throw new TypeError("HrEmploymentListQueryV1 cursor must be paired");
  }
  if (hasCreatedAt) {
    assertDateTime(value.cursorCreatedAt, "HrEmploymentListQueryV1.cursorCreatedAt");
    assertUuid(value.cursorEmploymentRecordId, "HrEmploymentListQueryV1.cursorEmploymentRecordId");
  }
  if (Object.hasOwn(value, "pageSize")) {
    assertPageSize(value.pageSize, "HrEmploymentListQueryV1.pageSize");
  }
  return value as unknown as HrEmploymentListQuery;
}

export function parseHrEmploymentDetailQuery(value: unknown): HrEmploymentDetailQuery {
  if (!isRecord(value)) throw new TypeError("HrEmploymentDetailQueryV1 must be an object");
  const allowed = ["cursorVersion", "cursorEmploymentRecordVersionId", "pageSize"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError("HrEmploymentDetailQueryV1 has unexpected fields");
  }
  const hasVersion = Object.hasOwn(value, "cursorVersion");
  const hasVersionId = Object.hasOwn(value, "cursorEmploymentRecordVersionId");
  if (hasVersion !== hasVersionId) {
    throw new TypeError("HrEmploymentDetailQueryV1 cursor must be paired");
  }
  if (hasVersion) {
    assertPositivePostgresInteger(value.cursorVersion, "HrEmploymentDetailQueryV1.cursorVersion");
    assertUuid(
      value.cursorEmploymentRecordVersionId,
      "HrEmploymentDetailQueryV1.cursorEmploymentRecordVersionId",
    );
  }
  if (Object.hasOwn(value, "pageSize")) {
    assertPageSize(value.pageSize, "HrEmploymentDetailQueryV1.pageSize");
  }
  return value as unknown as HrEmploymentDetailQuery;
}

function parseEmploymentVersion(value: unknown, label: string): HrEmploymentRecordVersion {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, employmentVersionRequired, label);
  assertUuid(value.employmentRecordVersionId, `${label}.employmentRecordVersionId`);
  assertPositivePostgresInteger(value.version, `${label}.version`);
  assertPositivePostgresInteger(value.rowVersion, `${label}.rowVersion`);
  if (value.supersedesVersionId !== null) {
    assertUuid(value.supersedesVersionId, `${label}.supersedesVersionId`);
  }
  if (!(hrEmploymentRecordVersionKinds as readonly unknown[]).includes(value.kind)) {
    throw new TypeError(`${label}.kind is invalid`);
  }
  if ((value.kind === "end") !== (value.terminal === true)) {
    throw new TypeError(`${label}.kind and terminal conflict`);
  }
  assertDate(value.effectiveFrom, `${label}.effectiveFrom`);
  if (value.effectiveTo !== null) {
    assertDate(value.effectiveTo, `${label}.effectiveTo`);
    if (value.effectiveTo < value.effectiveFrom) {
      throw new TypeError(`${label} effective range is invalid`);
    }
  }
  assertNullableOpaque(value.employmentTypeCode, `${label}.employmentTypeCode`);
  assertNullableOpaque(value.organizationReference, `${label}.organizationReference`);
  assertNullableOpaque(value.positionReference, `${label}.positionReference`);
  return value as unknown as HrEmploymentRecordVersion;
}

export function parseHrEmploymentRecordVersion(value: unknown): HrEmploymentRecordVersion {
  return parseEmploymentVersion(value, "HrEmploymentRecordVersionResponseV1");
}

function parseEmploymentSummary(value: unknown, label: string): HrEmploymentRecordSummary {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, employmentSummaryRequired, label);
  assertUuid(value.employmentRecordId, `${label}.employmentRecordId`);
  assertUuid(value.workerProfileId, `${label}.workerProfileId`);
  if (!(hrEmploymentRecordStatuses as readonly unknown[]).includes(value.status)) {
    throw new TypeError(`${label}.status is invalid`);
  }
  assertPositivePostgresInteger(value.version, `${label}.version`);
  assertDateTime(value.createdAt, `${label}.createdAt`);
  const currentVersion =
    value.currentVersion === null
      ? null
      : parseEmploymentVersion(value.currentVersion, `${label}.currentVersion`);
  if ((value.status === "draft") !== (currentVersion === null)) {
    throw new TypeError(`${label}.status and currentVersion conflict`);
  }
  if (
    currentVersion !== null &&
    ((value.status === "active" && currentVersion.terminal) ||
      (value.status === "ended" && !currentVersion.terminal))
  ) {
    throw new TypeError(`${label}.status and currentVersion terminal state conflict`);
  }
  return value as unknown as HrEmploymentRecordSummary;
}

export function parseHrEmploymentRecord(value: unknown): HrEmploymentRecord {
  if (!isRecord(value)) throw new TypeError("HrEmploymentRecordResponseV1 must be an object");
  assertExactKeys(
    value,
    [...employmentSummaryRequired, "accessScope", "history"],
    "HrEmploymentRecordResponseV1",
  );
  const summary = Object.fromEntries(
    employmentSummaryRequired.map((key) => [key, value[key]]),
  ) as Record<string, unknown>;
  parseEmploymentSummary(summary, "HrEmploymentRecordResponseV1");
  if (value.accessScope !== "own" && value.accessScope !== "tenant") {
    throw new TypeError("HrEmploymentRecordResponseV1.accessScope is invalid");
  }
  if (!isRecord(value.history)) {
    throw new TypeError("HrEmploymentRecordResponseV1.history must be an object");
  }
  assertExactKeys(value.history, ["items", "nextCursor"], "HrEmploymentRecordResponseV1.history");
  if (!Array.isArray(value.history.items) || value.history.items.length > 50) {
    throw new TypeError("HrEmploymentRecordResponseV1.history.items is invalid");
  }
  for (const item of value.history.items) {
    parseEmploymentVersion(item, "HrEmploymentRecordResponseV1.history.items[]");
  }
  if (value.history.nextCursor !== null) {
    if (!isRecord(value.history.nextCursor)) {
      throw new TypeError("HrEmploymentRecordResponseV1.history.nextCursor is invalid");
    }
    assertExactKeys(
      value.history.nextCursor,
      ["version", "employmentRecordVersionId"],
      "HrEmploymentRecordResponseV1.history.nextCursor",
    );
    assertPositivePostgresInteger(
      value.history.nextCursor.version,
      "HrEmploymentRecordResponseV1.history.nextCursor.version",
    );
    assertUuid(
      value.history.nextCursor.employmentRecordVersionId,
      "HrEmploymentRecordResponseV1.history.nextCursor.employmentRecordVersionId",
    );
  }
  return value as unknown as HrEmploymentRecord;
}

export function parseHrEmploymentListResponse(value: unknown): HrEmploymentListResponse {
  if (!isRecord(value)) throw new TypeError("HrEmploymentListResponseV1 must be an object");
  assertExactKeys(value, ["accessScope", "items", "nextCursor"], "HrEmploymentListResponseV1");
  if (value.accessScope !== "own" && value.accessScope !== "tenant") {
    throw new TypeError("HrEmploymentListResponseV1.accessScope is invalid");
  }
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw new TypeError("HrEmploymentListResponseV1.items is invalid");
  }
  for (const item of value.items) {
    parseEmploymentSummary(item, "HrEmploymentListResponseV1.items[]");
  }
  if (value.nextCursor !== null) {
    if (!isRecord(value.nextCursor)) {
      throw new TypeError("HrEmploymentListResponseV1.nextCursor is invalid");
    }
    assertExactKeys(
      value.nextCursor,
      ["createdAt", "employmentRecordId"],
      "HrEmploymentListResponseV1.nextCursor",
    );
    assertDateTime(value.nextCursor.createdAt, "HrEmploymentListResponseV1.nextCursor.createdAt");
    assertUuid(
      value.nextCursor.employmentRecordId,
      "HrEmploymentListResponseV1.nextCursor.employmentRecordId",
    );
  }
  return value as unknown as HrEmploymentListResponse;
}
