const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type HrWorkforceStatus = "active" | "draft" | "suspended" | "terminated";

export interface HrWorkforceCreateProfileBody {
  readonly employeeNumber?: string;
}

export interface HrWorkforceLinkPrincipalBody {
  readonly expectedVersion: number;
  readonly principalId: string;
}

export interface HrWorkforceChangeStatusBody {
  readonly expectedVersion: number;
  readonly targetStatus: Exclude<HrWorkforceStatus, "draft">;
}

export interface HrWorkforceProfilePath {
  readonly workerProfileId: string;
}

export interface HrWorkforceProfile {
  readonly createdAt: string;
  readonly employeeNumber: string | null;
  readonly principalLinked: boolean;
  readonly updatedAt: string;
  readonly version: number;
  readonly workerProfileId: string;
  readonly workforceStatus: HrWorkforceStatus;
}

export interface HrWorkforceServiceLifecycleBody {
  readonly expectedVersion: number | null;
}

export interface HrWorkforceServiceControl {
  readonly activationState: "active" | "inactive";
  readonly activationVersion: number;
  readonly serviceKey: "workforce_profile";
  readonly settingsVersion: number;
  readonly updatedAt: string;
  readonly version: number;
}

const employeeNumberSchema = {
  maxLength: 64,
  minLength: 1,
  pattern: ".*\\S.*",
  type: "string",
} as const;

export const hrWorkforceCreateProfileBodySchema = {
  $id: "HrWorkforceCreateProfileRequestV1",
  additionalProperties: false,
  properties: { employeeNumber: employeeNumberSchema },
  type: "object",
} as const;

export const hrWorkforceLinkPrincipalBodySchema = {
  $id: "HrWorkforceLinkPrincipalRequestV1",
  additionalProperties: false,
  properties: {
    expectedVersion: { minimum: 1, type: "integer" },
    principalId: { pattern: uuidPattern, type: "string" },
  },
  required: ["principalId", "expectedVersion"],
  type: "object",
} as const;

export const hrWorkforceChangeStatusBodySchema = {
  $id: "HrWorkforceChangeStatusRequestV1",
  additionalProperties: false,
  properties: {
    expectedVersion: { minimum: 1, type: "integer" },
    targetStatus: { enum: ["active", "suspended", "terminated"] },
  },
  required: ["targetStatus", "expectedVersion"],
  type: "object",
} as const;

export const hrWorkforceProfilePathSchema = {
  $id: "HrWorkforceProfilePathV1",
  additionalProperties: false,
  properties: { workerProfileId: { pattern: uuidPattern, type: "string" } },
  required: ["workerProfileId"],
  type: "object",
} as const;

export const hrWorkforceProfileSchema = {
  $id: "HrWorkforceProfileResponseV1",
  additionalProperties: false,
  properties: {
    createdAt: { format: "date-time", type: "string" },
    employeeNumber: { anyOf: [employeeNumberSchema, { type: "null" }] },
    principalLinked: { type: "boolean" },
    updatedAt: { format: "date-time", type: "string" },
    version: { minimum: 1, type: "integer" },
    workerProfileId: { pattern: uuidPattern, type: "string" },
    workforceStatus: { enum: ["draft", "active", "suspended", "terminated"] },
  },
  required: [
    "workerProfileId",
    "employeeNumber",
    "workforceStatus",
    "principalLinked",
    "createdAt",
    "updatedAt",
    "version",
  ],
  type: "object",
} as const;

export const hrWorkforceServiceLifecycleBodySchema = {
  additionalProperties: false,
  properties: {
    expectedVersion: {
      anyOf: [{ minimum: 1, type: "integer" }, { type: "null" }],
    },
  },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const hrWorkforceServiceActivateBodySchema = {
  $id: "HrServiceActivateRequestV1",
  ...hrWorkforceServiceLifecycleBodySchema,
} as const;

export const hrWorkforceServiceDeactivateBodySchema = {
  $id: "HrServiceDeactivateRequestV1",
  ...hrWorkforceServiceLifecycleBodySchema,
} as const;

export const hrWorkforceServiceControlSchema = {
  $id: "HrServiceControlResponseV1",
  additionalProperties: false,
  properties: {
    activationState: { enum: ["inactive", "active"] },
    activationVersion: { minimum: 1, type: "integer" },
    serviceKey: { const: "workforce_profile" },
    settingsVersion: { minimum: 1, type: "integer" },
    updatedAt: { format: "date-time", type: "string" },
    version: { minimum: 1, type: "integer" },
  },
  required: [
    "serviceKey",
    "activationState",
    "activationVersion",
    "settingsVersion",
    "updatedAt",
    "version",
  ],
  type: "object",
} as const;

const workforceProfileKeys = [
  "createdAt",
  "employeeNumber",
  "principalLinked",
  "updatedAt",
  "version",
  "workerProfileId",
  "workforceStatus",
] as const;

const workforceServiceControlKeys = [
  "activationState",
  "activationVersion",
  "serviceKey",
  "settingsVersion",
  "updatedAt",
  "version",
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

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(uuidPattern).test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
}

function assertDateTime(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !dateTimePattern.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function assertEmployeeNumber(value: unknown, label: string): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== "string" || value.length > 64 || value.trim().length === 0) {
    throw new TypeError(`${label} must be null or a non-blank string of at most 64 characters`);
  }
}

export function parseHrWorkforceProfile(value: unknown): HrWorkforceProfile {
  if (!isRecord(value)) throw new TypeError("HrWorkforceProfile must be an object");
  assertExactKeys(value, workforceProfileKeys, "HrWorkforceProfile");
  assertUuid(value.workerProfileId, "HrWorkforceProfile.workerProfileId");
  assertEmployeeNumber(value.employeeNumber, "HrWorkforceProfile.employeeNumber");
  if (
    !(["draft", "active", "suspended", "terminated"] as const).includes(
      value.workforceStatus as HrWorkforceStatus,
    )
  ) {
    throw new TypeError("HrWorkforceProfile.workforceStatus is invalid");
  }
  if (typeof value.principalLinked !== "boolean") {
    throw new TypeError("HrWorkforceProfile.principalLinked must be a boolean");
  }
  if (value.workforceStatus === "active" && !value.principalLinked) {
    throw new TypeError("HrWorkforceProfile.active profile must have a principal link");
  }
  assertDateTime(value.createdAt, "HrWorkforceProfile.createdAt");
  assertDateTime(value.updatedAt, "HrWorkforceProfile.updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new TypeError("HrWorkforceProfile.updatedAt cannot precede createdAt");
  }
  assertPositiveInteger(value.version, "HrWorkforceProfile.version");
  return value as unknown as HrWorkforceProfile;
}

export function parseHrWorkforceServiceControl(value: unknown): HrWorkforceServiceControl {
  if (!isRecord(value)) throw new TypeError("HrWorkforceServiceControl must be an object");
  assertExactKeys(value, workforceServiceControlKeys, "HrWorkforceServiceControl");
  if (value.serviceKey !== "workforce_profile") {
    throw new TypeError("HrWorkforceServiceControl.serviceKey is invalid");
  }
  if (value.activationState !== "active" && value.activationState !== "inactive") {
    throw new TypeError("HrWorkforceServiceControl.activationState is invalid");
  }
  assertPositiveInteger(value.activationVersion, "HrWorkforceServiceControl.activationVersion");
  assertPositiveInteger(value.settingsVersion, "HrWorkforceServiceControl.settingsVersion");
  assertDateTime(value.updatedAt, "HrWorkforceServiceControl.updatedAt");
  assertPositiveInteger(value.version, "HrWorkforceServiceControl.version");
  return value as unknown as HrWorkforceServiceControl;
}
