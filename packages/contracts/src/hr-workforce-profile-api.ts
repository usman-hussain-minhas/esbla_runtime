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

export interface HrWorkforceListQuery {
  readonly cursorCreatedAt?: string;
  readonly cursorEffectiveAt?: string;
  readonly cursorReportingRelationshipId?: string;
  readonly cursorWorkerProfileId?: string;
  readonly pageSize?: number;
  readonly status?: HrWorkforceStatus;
}

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

export interface HrWorkforceCursor {
  readonly createdAt: string;
  readonly workerProfileId: string;
}

export interface HrDirectReportsCursor {
  readonly effectiveAt: string;
  readonly reportingRelationshipId: string;
}

export interface HrWorkforceDirectReport {
  readonly profile: HrWorkforceProfile;
  readonly relationship: HrReportingRelationship;
}

export interface HrWorkforcePage {
  readonly items: readonly HrWorkforceProfile[];
  readonly kind: "workforce";
  readonly nextCursor: HrWorkforceCursor | null;
}

export interface HrDirectReportsPage {
  readonly items: readonly HrWorkforceDirectReport[];
  readonly kind: "direct_reports";
  readonly nextCursor: HrDirectReportsCursor | null;
}

export type HrWorkforceListResponse = HrDirectReportsPage | HrWorkforcePage;

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

const pageSizeSchema = {
  maximum: 50,
  minimum: 1,
  type: "integer",
} as const;

export const hrWorkforceListQuerySchema = {
  $id: "HrWorkforceListQueryV1",
  oneOf: [
    {
      additionalProperties: false,
      dependencies: {
        cursorCreatedAt: ["cursorWorkerProfileId"],
        cursorWorkerProfileId: ["cursorCreatedAt"],
      },
      properties: {
        cursorCreatedAt: { format: "date-time", type: "string" },
        cursorWorkerProfileId: uuidSchema,
        pageSize: pageSizeSchema,
        status: { enum: hrWorkforceStatuses },
      },
      required: ["status"],
      type: "object",
    },
    {
      additionalProperties: false,
      dependencies: {
        cursorEffectiveAt: ["cursorReportingRelationshipId"],
        cursorReportingRelationshipId: ["cursorEffectiveAt"],
      },
      properties: {
        cursorEffectiveAt: { format: "date-time", type: "string" },
        cursorReportingRelationshipId: uuidSchema,
        pageSize: pageSizeSchema,
      },
      type: "object",
    },
  ],
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

const workforceCursorSchema = {
  additionalProperties: false,
  properties: {
    createdAt: { format: "date-time", type: "string" },
    workerProfileId: uuidSchema,
  },
  required: ["createdAt", "workerProfileId"],
  type: "object",
} as const;

const directReportsCursorSchema = {
  additionalProperties: false,
  properties: {
    effectiveAt: { format: "date-time", type: "string" },
    reportingRelationshipId: uuidSchema,
  },
  required: ["effectiveAt", "reportingRelationshipId"],
  type: "object",
} as const;

export const hrWorkforceListResponseSchema = {
  $id: "HrWorkforceListResponseV1",
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        items: {
          items: { $ref: "HrWorkforceProfileResponseV1#" },
          maxItems: 50,
          type: "array",
        },
        kind: { const: "workforce" },
        nextCursor: { anyOf: [workforceCursorSchema, { type: "null" }] },
      },
      required: ["items", "kind", "nextCursor"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        items: {
          items: {
            additionalProperties: false,
            properties: {
              profile: { $ref: "HrWorkforceProfileResponseV1#" },
              relationship: { $ref: "HrReportingRelationshipResponseV1#" },
            },
            required: ["profile", "relationship"],
            type: "object",
          },
          maxItems: 50,
          type: "array",
        },
        kind: { const: "direct_reports" },
        nextCursor: { anyOf: [directReportsCursorSchema, { type: "null" }] },
      },
      required: ["items", "kind", "nextCursor"],
      type: "object",
    },
  ],
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

function assertPageSize(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new TypeError(`${label} must be an integer from 1 through 50`);
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

export function parseHrWorkforceListQuery(value: unknown): HrWorkforceListQuery {
  if (!isRecord(value)) throw new TypeError("HrWorkforceListQueryV1 must be an object");
  const workforceMode = Object.hasOwn(value, "status");
  const allowed = workforceMode
    ? ["cursorCreatedAt", "cursorWorkerProfileId", "pageSize", "status"]
    : ["cursorEffectiveAt", "cursorReportingRelationshipId", "pageSize"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError("HrWorkforceListQueryV1 has unexpected fields");
  }
  if (Object.hasOwn(value, "pageSize")) {
    assertPageSize(value.pageSize, "HrWorkforceListQueryV1.pageSize");
  }
  if (workforceMode) {
    if (!(hrWorkforceStatuses as readonly unknown[]).includes(value.status)) {
      throw new TypeError("HrWorkforceListQueryV1.status is invalid");
    }
    const hasCreatedAt = Object.hasOwn(value, "cursorCreatedAt");
    const hasProfileId = Object.hasOwn(value, "cursorWorkerProfileId");
    if (hasCreatedAt !== hasProfileId) {
      throw new TypeError("HrWorkforceListQueryV1 workforce cursor must be paired");
    }
    if (hasCreatedAt) {
      assertIsoDateTime(value.cursorCreatedAt, "HrWorkforceListQueryV1.cursorCreatedAt");
      assertUuid(value.cursorWorkerProfileId, "HrWorkforceListQueryV1.cursorWorkerProfileId");
    }
  } else {
    const hasEffectiveAt = Object.hasOwn(value, "cursorEffectiveAt");
    const hasRelationshipId = Object.hasOwn(value, "cursorReportingRelationshipId");
    if (hasEffectiveAt !== hasRelationshipId) {
      throw new TypeError("HrWorkforceListQueryV1 direct-reports cursor must be paired");
    }
    if (hasEffectiveAt) {
      assertIsoDateTime(value.cursorEffectiveAt, "HrWorkforceListQueryV1.cursorEffectiveAt");
      assertUuid(
        value.cursorReportingRelationshipId,
        "HrWorkforceListQueryV1.cursorReportingRelationshipId",
      );
    }
  }
  return value as unknown as HrWorkforceListQuery;
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

function parseWorkforceCursor(value: unknown): HrWorkforceCursor | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("HrWorkforceListResponseV1 cursor is invalid");
  assertExactKeys(value, ["createdAt", "workerProfileId"], "HrWorkforceListResponseV1 cursor");
  assertIsoDateTime(value.createdAt, "HrWorkforceListResponseV1.nextCursor.createdAt");
  assertUuid(value.workerProfileId, "HrWorkforceListResponseV1.nextCursor.workerProfileId");
  return value as unknown as HrWorkforceCursor;
}

function parseDirectReportsCursor(value: unknown): HrDirectReportsCursor | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("HrWorkforceListResponseV1 cursor is invalid");
  assertExactKeys(
    value,
    ["effectiveAt", "reportingRelationshipId"],
    "HrWorkforceListResponseV1 cursor",
  );
  assertIsoDateTime(value.effectiveAt, "HrWorkforceListResponseV1.nextCursor.effectiveAt");
  assertUuid(
    value.reportingRelationshipId,
    "HrWorkforceListResponseV1.nextCursor.reportingRelationshipId",
  );
  return value as unknown as HrDirectReportsCursor;
}

export function parseHrWorkforceListResponse(value: unknown): HrWorkforceListResponse {
  if (!isRecord(value)) throw new TypeError("HrWorkforceListResponseV1 must be an object");
  assertExactKeys(value, ["items", "kind", "nextCursor"], "HrWorkforceListResponseV1");
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw new TypeError("HrWorkforceListResponseV1.items must contain at most 50 items");
  }
  if (value.kind === "workforce") {
    for (const item of value.items) parseHrWorkforceProfile(item);
    parseWorkforceCursor(value.nextCursor);
    return value as unknown as HrWorkforcePage;
  }
  if (value.kind === "direct_reports") {
    for (const item of value.items) {
      if (!isRecord(item)) {
        throw new TypeError("HrWorkforceListResponseV1 direct report must be an object");
      }
      assertExactKeys(item, ["profile", "relationship"], "HrWorkforceListResponseV1 item");
      parseHrWorkforceProfile(item.profile);
      parseHrReportingRelationship(item.relationship);
    }
    parseDirectReportsCursor(value.nextCursor);
    return value as unknown as HrDirectReportsPage;
  }
  throw new TypeError("HrWorkforceListResponseV1.kind is invalid");
}
