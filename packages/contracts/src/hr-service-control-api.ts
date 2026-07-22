const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const maximumPostgresInteger = 2_147_483_647;

export const hrServiceKeys = [
  "attendance",
  "employment_record",
  "expense_claim_boundary",
  "shift_assignment",
  "timesheet",
  "workforce_profile",
] as const;

export type HrServiceKey = (typeof hrServiceKeys)[number];
export type HrServiceControlQuery = Readonly<Record<string, never>>;

export interface HrServiceActivateBody {
  readonly expectedVersion: number | null;
}

export interface HrServiceDeactivateBody {
  readonly expectedVersion: number;
}

export interface HrWorkforceProfileSettings {
  readonly employeeNumberRequired: boolean;
  readonly managerVisibility: "minimized" | "none";
  readonly unlinkedWorkerCreationAllowed: boolean;
}
export interface HrServiceConfigureBody {
  readonly expectedSettingsVersion: number;
  readonly settings: HrWorkforceProfileSettings;
}
interface HrServiceControlBase {
  readonly activationState: "active" | "inactive";
  readonly activationVersion: number;
  readonly settingsVersion: number;
  readonly updatedAt: string;
  readonly version: number;
}
export type HrServiceControl = HrServiceControlBase &
  (
    | { readonly serviceKey: "workforce_profile"; readonly settings: HrWorkforceProfileSettings }
    | {
        readonly serviceKey: Exclude<HrServiceKey, "workforce_profile">;
        readonly settings: Readonly<Record<string, never>>;
      }
  );

const positiveVersionSchema = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 1,
  type: "integer",
} as const;

export const hrServiceControlQuerySchema = {
  $id: "HrServiceControlQueryV1",
  additionalProperties: false,
  properties: {},
  type: "object",
} as const;

export const hrServiceActivateBodySchema = {
  $id: "HrServiceActivateRequestV1",
  additionalProperties: false,
  properties: {
    expectedVersion: { anyOf: [positiveVersionSchema, { type: "null" }] },
  },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const hrServiceDeactivateBodySchema = {
  $id: "HrServiceDeactivateRequestV1",
  additionalProperties: false,
  properties: { expectedVersion: positiveVersionSchema },
  required: ["expectedVersion"],
  type: "object",
} as const;

const workforceProfileSettingsSchema = {
  additionalProperties: false,
  properties: {
    employeeNumberRequired: { type: "boolean" },
    managerVisibility: { enum: ["minimized", "none"] },
    unlinkedWorkerCreationAllowed: { type: "boolean" },
  },
  required: ["employeeNumberRequired", "managerVisibility", "unlinkedWorkerCreationAllowed"],
  type: "object",
} as const;
const emptyServiceSettingsSchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
} as const;
export const hrServiceConfigureBodySchema = {
  $id: "HrServiceConfigureRequestV1",
  additionalProperties: false,
  properties: {
    expectedSettingsVersion: { ...positiveVersionSchema, maximum: maximumPostgresInteger },
    settings: workforceProfileSettingsSchema,
  },
  required: ["expectedSettingsVersion", "settings"],
  type: "object",
} as const;

export const hrServiceControlSchema = {
  $id: "HrServiceControlResponseV1",
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        serviceKey: { const: "workforce_profile" },
        settings: workforceProfileSettingsSchema,
      },
      type: "object",
    },
    {
      properties: {
        serviceKey: { not: { const: "workforce_profile" } },
        settings: emptyServiceSettingsSchema,
      },
      type: "object",
    },
  ],
  properties: {
    activationState: { enum: ["active", "inactive"] },
    activationVersion: positiveVersionSchema,
    serviceKey: { enum: hrServiceKeys },
    settings: { anyOf: [workforceProfileSettingsSchema, emptyServiceSettingsSchema] },
    settingsVersion: positiveVersionSchema,
    updatedAt: { format: "date-time", type: "string" },
    version: positiveVersionSchema,
  },
  required: [
    "activationState",
    "activationVersion",
    "serviceKey",
    "settings",
    "settingsVersion",
    "updatedAt",
    "version",
  ],
  type: "object",
} as const;

const serviceControlKeys = [
  "activationState",
  "activationVersion",
  "serviceKey",
  "settings",
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

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function parseWorkforceProfileSettings(value: unknown, label: string): HrWorkforceProfileSettings {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    ["employeeNumberRequired", "managerVisibility", "unlinkedWorkerCreationAllowed"],
    label,
  );
  if (
    typeof value.employeeNumberRequired !== "boolean" ||
    (value.managerVisibility !== "minimized" && value.managerVisibility !== "none") ||
    typeof value.unlinkedWorkerCreationAllowed !== "boolean"
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as unknown as HrWorkforceProfileSettings;
}

function assertDateTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO date-time`);
  const match = dateTimePattern.exec(value);
  if (!match) throw new TypeError(`${label} must be an ISO date-time`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new TypeError(`${label} must be a valid ISO date-time`);
  }
}

function parseLifecycleBody(
  value: unknown,
  label: string,
  allowNull: boolean,
): HrServiceActivateBody | HrServiceDeactivateBody {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["expectedVersion"], label);
  if (allowNull && value.expectedVersion === null) {
    return value as unknown as HrServiceActivateBody;
  }
  assertPositiveSafeInteger(value.expectedVersion, `${label}.expectedVersion`);
  return value as unknown as HrServiceDeactivateBody;
}

export function parseHrServiceControlQuery(value: unknown): HrServiceControlQuery {
  if (!isRecord(value)) throw new TypeError("HrServiceControlQueryV1 must be an object");
  assertExactKeys(value, [], "HrServiceControlQueryV1");
  return value as HrServiceControlQuery;
}

export function parseHrServiceActivateBody(value: unknown): HrServiceActivateBody {
  return parseLifecycleBody(value, "HrServiceActivateRequestV1", true) as HrServiceActivateBody;
}

export function parseHrServiceDeactivateBody(value: unknown): HrServiceDeactivateBody {
  return parseLifecycleBody(
    value,
    "HrServiceDeactivateRequestV1",
    false,
  ) as HrServiceDeactivateBody;
}

export function parseHrServiceConfigureBody(value: unknown): HrServiceConfigureBody {
  if (!isRecord(value)) throw new TypeError("HrServiceConfigureRequestV1 must be an object");
  assertExactKeys(value, ["expectedSettingsVersion", "settings"], "HrServiceConfigureRequestV1");
  assertPositiveSafeInteger(
    value.expectedSettingsVersion,
    "HrServiceConfigureRequestV1.expectedSettingsVersion",
  );
  if (value.expectedSettingsVersion > maximumPostgresInteger) {
    throw new TypeError("HrServiceConfigureRequestV1.expectedSettingsVersion is invalid");
  }
  parseWorkforceProfileSettings(value.settings, "HrServiceConfigureRequestV1.settings");
  return value as unknown as HrServiceConfigureBody;
}

export function parseHrServiceControl(value: unknown): HrServiceControl {
  if (!isRecord(value)) throw new TypeError("HrServiceControlResponseV1 must be an object");
  assertExactKeys(value, serviceControlKeys, "HrServiceControlResponseV1");
  if (!(hrServiceKeys as readonly unknown[]).includes(value.serviceKey)) {
    throw new TypeError("HrServiceControlResponseV1.serviceKey is invalid");
  }
  if (value.activationState !== "active" && value.activationState !== "inactive") {
    throw new TypeError("HrServiceControlResponseV1.activationState is invalid");
  }
  if (value.serviceKey === "workforce_profile") {
    parseWorkforceProfileSettings(value.settings, "HrServiceControlResponseV1.settings");
  } else {
    if (!isRecord(value.settings)) {
      throw new TypeError("HrServiceControlResponseV1.settings must be an object");
    }
    assertExactKeys(value.settings, [], "HrServiceControlResponseV1.settings");
  }
  assertPositiveSafeInteger(
    value.activationVersion,
    "HrServiceControlResponseV1.activationVersion",
  );
  assertPositiveSafeInteger(value.settingsVersion, "HrServiceControlResponseV1.settingsVersion");
  assertDateTime(value.updatedAt, "HrServiceControlResponseV1.updatedAt");
  assertPositiveSafeInteger(value.version, "HrServiceControlResponseV1.version");
  return value as unknown as HrServiceControl;
}
