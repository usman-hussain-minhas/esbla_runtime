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

const uuidSchema = { pattern: uuidPattern, type: "string" } as const;
const instantSchema = { format: "date-time", pattern: instantPattern, type: "string" } as const;
const observationKindSchema = { enum: hrAttendanceObservationKinds } as const;

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
    attendanceObservationId: uuidSchema,
    observationKind: observationKindSchema,
    observedAt: instantSchema,
    sourceKind: { enum: hrAttendanceSourceKinds },
    version: { const: 1 },
    workerProfileId: uuidSchema,
  },
  required: [
    "attendanceObservationId",
    "observationKind",
    "observedAt",
    "sourceKind",
    "version",
    "workerProfileId",
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
