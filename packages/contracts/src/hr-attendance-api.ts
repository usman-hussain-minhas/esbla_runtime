const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const uuidExpression = new RegExp(uuidPattern);
const instantPattern =
  "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$";
const instantExpression = new RegExp(instantPattern);

export const hrAttendanceObservationKinds = ["presence_start", "presence_end"] as const;
export const hrAttendanceSourceKinds = ["manual", "synthetic"] as const;
export type HrAttendanceObservationKind = (typeof hrAttendanceObservationKinds)[number];
export type HrAttendanceSourceKind = (typeof hrAttendanceSourceKinds)[number];

export interface HrAttendanceRecordManualBody {
  readonly observationKind: HrAttendanceObservationKind;
  readonly observedAt: string;
  readonly workerProfileId: string;
}

export interface HrAttendanceObservation {
  readonly attendanceObservationId: string;
  readonly observationKind: HrAttendanceObservationKind;
  readonly observedAt: string;
  readonly sourceKind: HrAttendanceSourceKind;
  readonly version: 1;
  readonly workerProfileId: string;
}

export interface HrAttendanceCorrectionBody {
  readonly correctedObservationKind: HrAttendanceObservationKind;
  readonly correctedObservedAt: string;
  readonly expectedCurrentCorrectionId: string | null;
  readonly expectedCurrentCorrectionVersion: number | null;
  readonly reason: string;
}

export interface HrAttendanceCorrectionPath {
  readonly observationId: string;
}

export interface HrAttendanceCorrection {
  readonly attendanceCorrectionId: string;
  readonly attendanceObservationId: string;
  readonly correctedObservationKind: HrAttendanceObservationKind;
  readonly correctedObservedAt: string;
  readonly createdAt: string;
  readonly reason: string;
  readonly supersedesAttendanceCorrectionId: string | null;
  readonly version: number;
}

export interface HrAttendanceObservationCursor {
  readonly attendanceObservationId: string;
  readonly observedAt: string;
}

export interface HrAttendanceCorrectionCursor {
  readonly attendanceCorrectionId: string;
  readonly version: number;
}

export interface HrAttendanceListQuery {
  readonly cursorAttendanceObservationId?: string;
  readonly cursorObservedAt?: string;
  readonly pageSize?: number;
  readonly rangeEnd: string;
  readonly rangeStart: string;
}

export type HrAttendanceOwnListQuery = HrAttendanceListQuery;
export type HrAttendanceReportsListQuery = HrAttendanceListQuery;

export interface HrAttendanceDetailQuery {
  readonly cursorAttendanceCorrectionId?: string;
  readonly cursorCorrectionVersion?: number;
  readonly pageSize?: number;
}

export interface HrAttendanceCorrectionPage {
  readonly items: readonly HrAttendanceCorrection[];
  readonly nextCursor: HrAttendanceCorrectionCursor | null;
}

export type HrAttendanceAccessScope = "assigned" | "own" | "tenant";

export interface HrAttendanceListResponse {
  readonly accessScope: HrAttendanceAccessScope;
  readonly items: readonly HrAttendanceObservation[];
  readonly nextCursor: HrAttendanceObservationCursor | null;
}

export type HrAttendanceObservationResponse =
  | HrAttendanceObservation
  | (HrAttendanceObservation & { readonly corrections: HrAttendanceCorrectionPage });

const uuidSchema = { pattern: uuidPattern, type: "string" } as const;
const instantSchema = { format: "date-time", pattern: instantPattern, type: "string" } as const;
const observationKindSchema = { enum: hrAttendanceObservationKinds } as const;
const observationCursorSchema = {
  additionalProperties: false,
  properties: {
    attendanceObservationId: uuidSchema,
    observedAt: instantSchema,
  },
  required: ["attendanceObservationId", "observedAt"],
  type: "object",
} as const;
const correctionCursorSchema = {
  additionalProperties: false,
  properties: {
    attendanceCorrectionId: uuidSchema,
    version: { maximum: 2_147_483_647, minimum: 1, type: "integer" },
  },
  required: ["attendanceCorrectionId", "version"],
  type: "object",
} as const;
const listQueryProperties = {
  cursorAttendanceObservationId: uuidSchema,
  cursorObservedAt: instantSchema,
  pageSize: { maximum: 50, minimum: 1, type: "integer" },
  rangeEnd: instantSchema,
  rangeStart: instantSchema,
} as const;
const observationResponseProperties = {
  attendanceObservationId: uuidSchema,
  observationKind: observationKindSchema,
  observedAt: instantSchema,
  sourceKind: { enum: hrAttendanceSourceKinds },
  version: { const: 1 },
  workerProfileId: uuidSchema,
} as const;
const observationResponseRequired = [
  "attendanceObservationId",
  "observationKind",
  "observedAt",
  "sourceKind",
  "version",
  "workerProfileId",
] as const;
const attendanceObservationListItemSchema = {
  additionalProperties: false,
  properties: observationResponseProperties,
  required: observationResponseRequired,
  type: "object",
} as const;

export const hrAttendanceRecordManualBodySchema = {
  $id: "HrAttendanceRecordManualRequestV1",
  additionalProperties: false,
  properties: {
    observationKind: observationKindSchema,
    observedAt: instantSchema,
    workerProfileId: uuidSchema,
  },
  required: ["observationKind", "observedAt", "workerProfileId"],
  type: "object",
} as const;

export const hrAttendanceObservationResponseSchema = {
  $id: "HrAttendanceObservationResponseV1",
  additionalProperties: false,
  properties: {
    ...observationResponseProperties,
    corrections: {
      additionalProperties: false,
      properties: {
        items: {
          items: { $ref: "HrAttendanceCorrectionResponseV1#" },
          maxItems: 50,
          type: "array",
        },
        nextCursor: { anyOf: [correctionCursorSchema, { type: "null" }] },
      },
      required: ["items", "nextCursor"],
      type: "object",
    },
  },
  required: [...observationResponseRequired],
  type: "object",
} as const;

export const hrAttendanceOwnListQuerySchema = {
  $id: "HrAttendanceOwnListQueryV1",
  additionalProperties: false,
  properties: listQueryProperties,
  required: ["rangeEnd", "rangeStart"],
  type: "object",
} as const;

export const hrAttendanceReportsListQuerySchema = {
  ...hrAttendanceOwnListQuerySchema,
  $id: "HrAttendanceReportsListQueryV1",
} as const;

export const hrAttendanceDetailQuerySchema = {
  $id: "HrAttendanceDetailQueryV1",
  additionalProperties: false,
  properties: {
    cursorAttendanceCorrectionId: uuidSchema,
    cursorCorrectionVersion: { maximum: 2_147_483_647, minimum: 1, type: "integer" },
    pageSize: { maximum: 50, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;

export const hrAttendanceListResponseSchema = {
  $id: "HrAttendanceListResponseV1",
  additionalProperties: false,
  properties: {
    accessScope: { enum: ["assigned", "own", "tenant"] },
    items: {
      items: attendanceObservationListItemSchema,
      maxItems: 50,
      type: "array",
    },
    nextCursor: { anyOf: [observationCursorSchema, { type: "null" }] },
  },
  required: ["accessScope", "items", "nextCursor"],
  type: "object",
} as const;

export const hrAttendanceCorrectionBodySchema = {
  $id: "HrAttendanceCorrectionRequestV1",
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        expectedCurrentCorrectionId: { type: "null" },
        expectedCurrentCorrectionVersion: { type: "null" },
      },
    },
    {
      properties: {
        expectedCurrentCorrectionId: uuidSchema,
        expectedCurrentCorrectionVersion: { minimum: 1, type: "integer" },
      },
    },
  ],
  properties: {
    correctedObservationKind: observationKindSchema,
    correctedObservedAt: instantSchema,
    expectedCurrentCorrectionId: { anyOf: [uuidSchema, { type: "null" }] },
    expectedCurrentCorrectionVersion: {
      anyOf: [{ minimum: 1, type: "integer" }, { type: "null" }],
    },
    reason: { maxLength: 2000, minLength: 1, type: "string" },
  },
  required: [
    "correctedObservationKind",
    "correctedObservedAt",
    "expectedCurrentCorrectionId",
    "expectedCurrentCorrectionVersion",
    "reason",
  ],
  type: "object",
} as const;

export const hrAttendanceCorrectionPathSchema = {
  $id: "HrAttendanceCorrectionPathV1",
  additionalProperties: false,
  properties: { observationId: uuidSchema },
  required: ["observationId"],
  type: "object",
} as const;

export const hrAttendanceCorrectionResponseSchema = {
  $id: "HrAttendanceCorrectionResponseV1",
  additionalProperties: false,
  properties: {
    attendanceCorrectionId: uuidSchema,
    attendanceObservationId: uuidSchema,
    correctedObservationKind: observationKindSchema,
    correctedObservedAt: instantSchema,
    createdAt: instantSchema,
    reason: { maxLength: 2000, minLength: 1, type: "string" },
    supersedesAttendanceCorrectionId: { anyOf: [uuidSchema, { type: "null" }] },
    version: { minimum: 1, type: "integer" },
  },
  required: [
    "attendanceCorrectionId",
    "attendanceObservationId",
    "correctedObservationKind",
    "correctedObservedAt",
    "createdAt",
    "reason",
    "supersedesAttendanceCorrectionId",
    "version",
  ],
  type: "object",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const allowed = new Set(required);
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

function validDate(year: number, month: number, day: number): boolean {
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  );
}

function assertInstant(value: unknown, label: string, canonical: boolean): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO instant`);
  const match = instantExpression.exec(value);
  if (
    !match ||
    !validDate(Number(match[1]), Number(match[2]), Number(match[3])) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  ) {
    throw new TypeError(`${label} must be an ISO instant`);
  }
  const offset = match[7] as string;
  if (
    offset !== "Z" &&
    (Number(offset.slice(1, 3)) > 14 ||
      Number(offset.slice(4, 6)) > 59 ||
      (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4, 6)) !== 0))
  ) {
    throw new TypeError(`${label} must be an ISO instant`);
  }
  if (
    !Number.isFinite(Date.parse(value)) ||
    (canonical && new Date(value).toISOString() !== value)
  ) {
    throw new TypeError(`${label} must be a canonical ISO instant`);
  }
}

function assertObservationKind(
  value: unknown,
  label: string,
): asserts value is HrAttendanceObservationKind {
  if (!(hrAttendanceObservationKinds as readonly unknown[]).includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function assertPageSize(value: unknown, label: string): asserts value is number {
  assertPositiveInteger(value, label);
  if (value > 50) throw new TypeError(`${label} must not exceed 50`);
}

function assertReason(value: unknown, label: string, canonical: boolean): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > 2000 ||
    (canonical && value !== value.trim())
  ) {
    throw new TypeError(`${label} must be a bounded correction reason`);
  }
}

export function parseHrAttendanceRecordManualBody(value: unknown): HrAttendanceRecordManualBody {
  const label = "HrAttendanceRecordManualRequestV1";
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["observationKind", "observedAt", "workerProfileId"], label);
  assertObservationKind(value.observationKind, `${label}.observationKind`);
  assertInstant(value.observedAt, `${label}.observedAt`, false);
  assertUuid(value.workerProfileId, `${label}.workerProfileId`);
  return value as unknown as HrAttendanceRecordManualBody;
}

export function parseHrAttendanceObservation(value: unknown): HrAttendanceObservation {
  const label = "HrAttendanceObservationResponseV1";
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "attendanceObservationId",
      "observationKind",
      "observedAt",
      "sourceKind",
      "version",
      "workerProfileId",
    ],
    label,
  );
  assertUuid(value.attendanceObservationId, `${label}.attendanceObservationId`);
  assertUuid(value.workerProfileId, `${label}.workerProfileId`);
  assertObservationKind(value.observationKind, `${label}.observationKind`);
  assertInstant(value.observedAt, `${label}.observedAt`, true);
  if (!(hrAttendanceSourceKinds as readonly unknown[]).includes(value.sourceKind)) {
    throw new TypeError(`${label}.sourceKind is invalid`);
  }
  if (value.version !== 1) throw new TypeError(`${label}.version is invalid`);
  return value as unknown as HrAttendanceObservation;
}

function parseListQuery(value: unknown, label: string): HrAttendanceListQuery {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const allowed = [
    "cursorAttendanceObservationId",
    "cursorObservedAt",
    "pageSize",
    "rangeEnd",
    "rangeStart",
  ];
  if (
    !Object.hasOwn(value, "rangeStart") ||
    !Object.hasOwn(value, "rangeEnd") ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
  assertInstant(value.rangeStart, `${label}.rangeStart`, true);
  assertInstant(value.rangeEnd, `${label}.rangeEnd`, true);
  if (Date.parse(value.rangeEnd) <= Date.parse(value.rangeStart)) {
    throw new TypeError(`${label} rangeEnd must follow rangeStart`);
  }
  const hasTimestamp = Object.hasOwn(value, "cursorObservedAt");
  const hasId = Object.hasOwn(value, "cursorAttendanceObservationId");
  if (hasTimestamp !== hasId) throw new TypeError(`${label} cursor must be paired`);
  if (hasTimestamp) {
    assertInstant(value.cursorObservedAt, `${label}.cursorObservedAt`, true);
    assertUuid(value.cursorAttendanceObservationId, `${label}.cursorAttendanceObservationId`);
  }
  if (Object.hasOwn(value, "pageSize")) assertPageSize(value.pageSize, `${label}.pageSize`);
  return value as unknown as HrAttendanceListQuery;
}

export function parseHrAttendanceOwnListQuery(value: unknown): HrAttendanceOwnListQuery {
  return parseListQuery(value, "HrAttendanceOwnListQueryV1");
}

export function parseHrAttendanceReportsListQuery(value: unknown): HrAttendanceReportsListQuery {
  return parseListQuery(value, "HrAttendanceReportsListQueryV1");
}

export function parseHrAttendanceDetailQuery(value: unknown): HrAttendanceDetailQuery {
  const label = "HrAttendanceDetailQueryV1";
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const allowed = ["cursorAttendanceCorrectionId", "cursorCorrectionVersion", "pageSize"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} has unexpected fields`);
  }
  const hasVersion = Object.hasOwn(value, "cursorCorrectionVersion");
  const hasId = Object.hasOwn(value, "cursorAttendanceCorrectionId");
  if (hasVersion !== hasId) throw new TypeError(`${label} cursor must be paired`);
  if (hasVersion) {
    assertPositiveInteger(value.cursorCorrectionVersion, `${label}.cursorCorrectionVersion`);
    if (value.cursorCorrectionVersion > 2_147_483_647) {
      throw new TypeError(`${label}.cursorCorrectionVersion is too large`);
    }
    assertUuid(value.cursorAttendanceCorrectionId, `${label}.cursorAttendanceCorrectionId`);
  }
  if (Object.hasOwn(value, "pageSize")) assertPageSize(value.pageSize, `${label}.pageSize`);
  return value as unknown as HrAttendanceDetailQuery;
}

export function parseHrAttendanceCorrectionBody(value: unknown): HrAttendanceCorrectionBody {
  const label = "HrAttendanceCorrectionRequestV1";
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "correctedObservationKind",
      "correctedObservedAt",
      "expectedCurrentCorrectionId",
      "expectedCurrentCorrectionVersion",
      "reason",
    ],
    label,
  );
  assertObservationKind(value.correctedObservationKind, `${label}.correctedObservationKind`);
  assertInstant(value.correctedObservedAt, `${label}.correctedObservedAt`, false);
  assertReason(value.reason, `${label}.reason`, false);
  const firstCorrection =
    value.expectedCurrentCorrectionId === null && value.expectedCurrentCorrectionVersion === null;
  if (!firstCorrection) {
    assertUuid(value.expectedCurrentCorrectionId, `${label}.expectedCurrentCorrectionId`);
    assertPositiveInteger(
      value.expectedCurrentCorrectionVersion,
      `${label}.expectedCurrentCorrectionVersion`,
    );
  }
  return value as unknown as HrAttendanceCorrectionBody;
}

export function parseHrAttendanceCorrectionPath(value: unknown): HrAttendanceCorrectionPath {
  const label = "HrAttendanceCorrectionPathV1";
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["observationId"], label);
  assertUuid(value.observationId, `${label}.observationId`);
  return value as unknown as HrAttendanceCorrectionPath;
}

export function parseHrAttendanceCorrection(value: unknown): HrAttendanceCorrection {
  const label = "HrAttendanceCorrectionResponseV1";
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      "attendanceCorrectionId",
      "attendanceObservationId",
      "correctedObservationKind",
      "correctedObservedAt",
      "createdAt",
      "reason",
      "supersedesAttendanceCorrectionId",
      "version",
    ],
    label,
  );
  assertUuid(value.attendanceCorrectionId, `${label}.attendanceCorrectionId`);
  assertUuid(value.attendanceObservationId, `${label}.attendanceObservationId`);
  assertObservationKind(value.correctedObservationKind, `${label}.correctedObservationKind`);
  assertInstant(value.correctedObservedAt, `${label}.correctedObservedAt`, true);
  assertInstant(value.createdAt, `${label}.createdAt`, true);
  assertReason(value.reason, `${label}.reason`, true);
  if (value.supersedesAttendanceCorrectionId !== null) {
    assertUuid(value.supersedesAttendanceCorrectionId, `${label}.supersedesAttendanceCorrectionId`);
  }
  assertPositiveInteger(value.version, `${label}.version`);
  return value as unknown as HrAttendanceCorrection;
}

function parseCorrectionCursor(value: unknown, label: string): HrAttendanceCorrectionCursor {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["attendanceCorrectionId", "version"], label);
  assertUuid(value.attendanceCorrectionId, `${label}.attendanceCorrectionId`);
  assertPositiveInteger(value.version, `${label}.version`);
  if (value.version > 2_147_483_647) throw new TypeError(`${label}.version is too large`);
  return value as unknown as HrAttendanceCorrectionCursor;
}

function parseObservationCursor(value: unknown, label: string): HrAttendanceObservationCursor {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["attendanceObservationId", "observedAt"], label);
  assertUuid(value.attendanceObservationId, `${label}.attendanceObservationId`);
  assertInstant(value.observedAt, `${label}.observedAt`, true);
  return value as unknown as HrAttendanceObservationCursor;
}

export function parseHrAttendanceObservationResponse(
  value: unknown,
): HrAttendanceObservationResponse {
  if (!isRecord(value) || !Object.hasOwn(value, "corrections")) {
    return parseHrAttendanceObservation(value);
  }
  const label = "HrAttendanceObservationResponseV1";
  assertExactKeys(
    value,
    [
      "attendanceObservationId",
      "corrections",
      "observationKind",
      "observedAt",
      "sourceKind",
      "version",
      "workerProfileId",
    ],
    label,
  );
  parseHrAttendanceObservation({
    attendanceObservationId: value.attendanceObservationId,
    observationKind: value.observationKind,
    observedAt: value.observedAt,
    sourceKind: value.sourceKind,
    version: value.version,
    workerProfileId: value.workerProfileId,
  });
  if (!isRecord(value.corrections)) throw new TypeError(`${label}.corrections is invalid`);
  assertExactKeys(value.corrections, ["items", "nextCursor"], `${label}.corrections`);
  if (!Array.isArray(value.corrections.items) || value.corrections.items.length > 50) {
    throw new TypeError(`${label}.corrections.items is invalid`);
  }
  value.corrections.items.forEach(parseHrAttendanceCorrection);
  if (value.corrections.nextCursor !== null) {
    parseCorrectionCursor(value.corrections.nextCursor, `${label}.corrections.nextCursor`);
  }
  return value as unknown as HrAttendanceObservationResponse;
}

export function parseHrAttendanceListResponse(value: unknown): HrAttendanceListResponse {
  const label = "HrAttendanceListResponseV1";
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["accessScope", "items", "nextCursor"], label);
  if (!["assigned", "own", "tenant"].includes(String(value.accessScope))) {
    throw new TypeError(`${label}.accessScope is invalid`);
  }
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw new TypeError(`${label}.items is invalid`);
  }
  value.items.forEach(parseHrAttendanceObservation);
  if (value.nextCursor !== null) {
    parseObservationCursor(value.nextCursor, `${label}.nextCursor`);
  }
  return value as unknown as HrAttendanceListResponse;
}
