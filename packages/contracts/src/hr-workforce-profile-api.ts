const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const uuidExpression = new RegExp(uuidPattern);

export const hrWorkforceStatuses = ["active", "draft", "suspended", "terminated"] as const;
export const hrWorkforceStatusTargets = ["active", "suspended", "terminated"] as const;
export const hrReportingRelationshipStatuses = ["assigned", "unassigned"] as const;

export type HrWorkforceStatus = (typeof hrWorkforceStatuses)[number];
export type HrWorkforceStatusTarget = (typeof hrWorkforceStatusTargets)[number];
export type HrReportingRelationshipStatus = (typeof hrReportingRelationshipStatuses)[number];

export interface HrWorkforceCreateProfileBody {
  readonly employeeNumber?: string | null;
}

export interface HrWorkforceLinkPrincipalBody {
  readonly expectedVersion: number;
  readonly principalId: string;
}

export interface HrWorkforceChangeStatusBody {
  readonly expectedVersion: number;
  readonly status: HrWorkforceStatusTarget;
}

export interface HrWorkforceChangeReportingRelationshipBody {
  readonly expectedVersion: number;
  readonly managerWorkerProfileId: string | null;
  readonly relationshipStatus: HrReportingRelationshipStatus;
}

export interface HrWorkforceProfilePath {
  readonly workerProfileId: string;
}

export type HrWorkforceOwnQuery = Readonly<Record<string, never>>;

export interface HrWorkforceProfile {
  readonly employeeNumber: string | null;
  readonly principalLinked: boolean;
  readonly version: number;
  readonly workerProfileId: string;
  readonly workforceStatus: HrWorkforceStatus;
}

export interface HrReportingRelationship {
  readonly effectiveAt: string;
  readonly managerWorkerProfileId: string | null;
  readonly relationshipStatus: HrReportingRelationshipStatus;
  readonly relationshipVersion: number;
  readonly reportingRelationshipId: string;
  readonly supersedesReportingRelationshipId: string | null;
  readonly workerProfileId: string;
  readonly workerProfileVersion: number;
}

const positiveVersionSchema = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 1,
  type: "integer",
} as const;

const uuidSchema = { pattern: uuidPattern, type: "string" } as const;

export const hrWorkforceCreateProfileBodySchema = {
  $id: "HrWorkforceCreateProfileRequestV1",
  additionalProperties: false,
  properties: {
    employeeNumber: { type: ["string", "null"] },
  },
  type: "object",
} as const;

export const hrWorkforceLinkPrincipalBodySchema = {
  $id: "HrWorkforceLinkPrincipalRequestV1",
  additionalProperties: false,
  properties: {
    expectedVersion: positiveVersionSchema,
    principalId: uuidSchema,
  },
  required: ["expectedVersion", "principalId"],
  type: "object",
} as const;

export const hrWorkforceOwnQuerySchema = {
  $id: "HrWorkforceOwnQueryV1",
  additionalProperties: false,
  properties: {},
  type: "object",
} as const;

export const hrWorkforceChangeStatusBodySchema = {
  $id: "HrWorkforceChangeStatusRequestV1",
  additionalProperties: false,
  properties: {
    expectedVersion: positiveVersionSchema,
    status: { enum: hrWorkforceStatusTargets },
  },
  required: ["expectedVersion", "status"],
  type: "object",
} as const;

export const hrWorkforceChangeReportingRelationshipBodySchema = {
  $id: "HrWorkforceChangeReportingRelationshipRequestV1",
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        managerWorkerProfileId: uuidSchema,
        relationshipStatus: { const: "assigned" },
      },
      type: "object",
    },
    {
      properties: {
        managerWorkerProfileId: { type: "null" },
        relationshipStatus: { const: "unassigned" },
      },
      type: "object",
    },
  ],
  properties: {
    expectedVersion: positiveVersionSchema,
    managerWorkerProfileId: { pattern: uuidPattern, type: ["string", "null"] },
    relationshipStatus: { enum: hrReportingRelationshipStatuses },
  },
  required: ["expectedVersion", "managerWorkerProfileId", "relationshipStatus"],
  type: "object",
} as const;

export const hrWorkforceProfilePathSchema = {
  $id: "HrWorkforceProfilePathV1",
  additionalProperties: false,
  properties: { workerProfileId: uuidSchema },
  required: ["workerProfileId"],
  type: "object",
} as const;

export const hrWorkforceProfileSchema = {
  $id: "HrWorkforceProfileResponseV1",
  additionalProperties: false,
  properties: {
    employeeNumber: { type: ["string", "null"] },
    principalLinked: { type: "boolean" },
    version: positiveVersionSchema,
    workerProfileId: uuidSchema,
    workforceStatus: { enum: hrWorkforceStatuses },
  },
  required: ["employeeNumber", "principalLinked", "version", "workerProfileId", "workforceStatus"],
  type: "object",
} as const;

export const hrReportingRelationshipSchema = {
  $id: "HrReportingRelationshipResponseV1",
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        managerWorkerProfileId: uuidSchema,
        relationshipStatus: { const: "assigned" },
      },
      type: "object",
    },
    {
      properties: {
        managerWorkerProfileId: { type: "null" },
        relationshipStatus: { const: "unassigned" },
      },
      type: "object",
    },
  ],
  properties: {
    effectiveAt: { format: "date-time", type: "string" },
    managerWorkerProfileId: { pattern: uuidPattern, type: ["string", "null"] },
    relationshipStatus: { enum: hrReportingRelationshipStatuses },
    relationshipVersion: positiveVersionSchema,
    reportingRelationshipId: uuidSchema,
    supersedesReportingRelationshipId: { pattern: uuidPattern, type: ["string", "null"] },
    workerProfileId: uuidSchema,
    workerProfileVersion: positiveVersionSchema,
  },
  required: [
    "effectiveAt",
    "managerWorkerProfileId",
    "relationshipStatus",
    "relationshipVersion",
    "reportingRelationshipId",
    "supersedesReportingRelationshipId",
    "workerProfileId",
    "workerProfileVersion",
  ],
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

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNullableUuid(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertUuid(value, label);
}

function assertIsoDateTime(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical ISO date-time`);
  }
}

export function parseHrWorkforceCreateProfileBody(value: unknown): HrWorkforceCreateProfileBody {
  if (!isRecord(value)) throw new TypeError("HrWorkforceCreateProfileRequestV1 must be an object");
  if (Object.keys(value).some((key) => key !== "employeeNumber")) {
    throw new TypeError("HrWorkforceCreateProfileRequestV1 has unexpected fields");
  }
  if (
    Object.hasOwn(value, "employeeNumber") &&
    value.employeeNumber !== null &&
    typeof value.employeeNumber !== "string"
  ) {
    throw new TypeError("HrWorkforceCreateProfileRequestV1.employeeNumber must be text or null");
  }
  return value as HrWorkforceCreateProfileBody;
}

export function parseHrWorkforceLinkPrincipalBody(value: unknown): HrWorkforceLinkPrincipalBody {
  if (!isRecord(value)) throw new TypeError("HrWorkforceLinkPrincipalRequestV1 must be an object");
  assertExactKeys(value, ["expectedVersion", "principalId"], "HrWorkforceLinkPrincipalRequestV1");
  assertPositiveSafeInteger(
    value.expectedVersion,
    "HrWorkforceLinkPrincipalRequestV1.expectedVersion",
  );
  assertUuid(value.principalId, "HrWorkforceLinkPrincipalRequestV1.principalId");
  return value as unknown as HrWorkforceLinkPrincipalBody;
}

export function parseHrWorkforceOwnQuery(value: unknown): HrWorkforceOwnQuery {
  if (!isRecord(value)) throw new TypeError("HrWorkforceOwnQueryV1 must be an object");
  assertExactKeys(value, [], "HrWorkforceOwnQueryV1");
  return value as HrWorkforceOwnQuery;
}

export function parseHrWorkforceChangeStatusBody(value: unknown): HrWorkforceChangeStatusBody {
  if (!isRecord(value)) throw new TypeError("HrWorkforceChangeStatusRequestV1 must be an object");
  assertExactKeys(value, ["expectedVersion", "status"], "HrWorkforceChangeStatusRequestV1");
  assertPositiveSafeInteger(
    value.expectedVersion,
    "HrWorkforceChangeStatusRequestV1.expectedVersion",
  );
  if (!(hrWorkforceStatusTargets as readonly unknown[]).includes(value.status)) {
    throw new TypeError("HrWorkforceChangeStatusRequestV1.status is invalid");
  }
  return value as unknown as HrWorkforceChangeStatusBody;
}

export function parseHrWorkforceChangeReportingRelationshipBody(
  value: unknown,
): HrWorkforceChangeReportingRelationshipBody {
  if (!isRecord(value)) {
    throw new TypeError("HrWorkforceChangeReportingRelationshipRequestV1 must be an object");
  }
  assertExactKeys(
    value,
    ["expectedVersion", "managerWorkerProfileId", "relationshipStatus"],
    "HrWorkforceChangeReportingRelationshipRequestV1",
  );
  assertPositiveSafeInteger(
    value.expectedVersion,
    "HrWorkforceChangeReportingRelationshipRequestV1.expectedVersion",
  );
  if (!(hrReportingRelationshipStatuses as readonly unknown[]).includes(value.relationshipStatus)) {
    throw new TypeError(
      "HrWorkforceChangeReportingRelationshipRequestV1.relationshipStatus is invalid",
    );
  }
  assertNullableUuid(
    value.managerWorkerProfileId,
    "HrWorkforceChangeReportingRelationshipRequestV1.managerWorkerProfileId",
  );
  if ((value.relationshipStatus === "assigned") !== (value.managerWorkerProfileId !== null)) {
    throw new TypeError(
      "HrWorkforceChangeReportingRelationshipRequestV1 manager and status conflict",
    );
  }
  return value as unknown as HrWorkforceChangeReportingRelationshipBody;
}

export function parseHrWorkforceProfilePath(value: unknown): HrWorkforceProfilePath {
  if (!isRecord(value)) throw new TypeError("HrWorkforceProfilePathV1 must be an object");
  assertExactKeys(value, ["workerProfileId"], "HrWorkforceProfilePathV1");
  assertUuid(value.workerProfileId, "HrWorkforceProfilePathV1.workerProfileId");
  return value as unknown as HrWorkforceProfilePath;
}

export function parseHrWorkforceProfile(value: unknown): HrWorkforceProfile {
  if (!isRecord(value)) throw new TypeError("HrWorkforceProfileResponseV1 must be an object");
  assertExactKeys(
    value,
    ["employeeNumber", "principalLinked", "version", "workerProfileId", "workforceStatus"],
    "HrWorkforceProfileResponseV1",
  );
  if (value.employeeNumber !== null && typeof value.employeeNumber !== "string") {
    throw new TypeError("HrWorkforceProfileResponseV1.employeeNumber must be text or null");
  }
  if (typeof value.principalLinked !== "boolean") {
    throw new TypeError("HrWorkforceProfileResponseV1.principalLinked must be boolean");
  }
  assertPositiveSafeInteger(value.version, "HrWorkforceProfileResponseV1.version");
  assertUuid(value.workerProfileId, "HrWorkforceProfileResponseV1.workerProfileId");
  if (!(hrWorkforceStatuses as readonly unknown[]).includes(value.workforceStatus)) {
    throw new TypeError("HrWorkforceProfileResponseV1.workforceStatus is invalid");
  }
  return value as unknown as HrWorkforceProfile;
}

export function parseHrReportingRelationship(value: unknown): HrReportingRelationship {
  if (!isRecord(value)) throw new TypeError("HrReportingRelationshipResponseV1 must be an object");
  assertExactKeys(
    value,
    [
      "effectiveAt",
      "managerWorkerProfileId",
      "relationshipStatus",
      "relationshipVersion",
      "reportingRelationshipId",
      "supersedesReportingRelationshipId",
      "workerProfileId",
      "workerProfileVersion",
    ],
    "HrReportingRelationshipResponseV1",
  );
  assertIsoDateTime(value.effectiveAt, "HrReportingRelationshipResponseV1.effectiveAt");
  assertNullableUuid(
    value.managerWorkerProfileId,
    "HrReportingRelationshipResponseV1.managerWorkerProfileId",
  );
  if (!(hrReportingRelationshipStatuses as readonly unknown[]).includes(value.relationshipStatus)) {
    throw new TypeError("HrReportingRelationshipResponseV1.relationshipStatus is invalid");
  }
  if ((value.relationshipStatus === "assigned") !== (value.managerWorkerProfileId !== null)) {
    throw new TypeError("HrReportingRelationshipResponseV1 manager and status conflict");
  }
  assertPositiveSafeInteger(
    value.relationshipVersion,
    "HrReportingRelationshipResponseV1.relationshipVersion",
  );
  assertUuid(
    value.reportingRelationshipId,
    "HrReportingRelationshipResponseV1.reportingRelationshipId",
  );
  assertNullableUuid(
    value.supersedesReportingRelationshipId,
    "HrReportingRelationshipResponseV1.supersedesReportingRelationshipId",
  );
  assertUuid(value.workerProfileId, "HrReportingRelationshipResponseV1.workerProfileId");
  assertPositiveSafeInteger(
    value.workerProfileVersion,
    "HrReportingRelationshipResponseV1.workerProfileVersion",
  );
  return value as unknown as HrReportingRelationship;
}
