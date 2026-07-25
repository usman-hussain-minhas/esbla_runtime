const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const uuid = { pattern: uuidPattern, type: "string" } as const;
const date = { pattern: datePattern, type: "string" } as const;
const version = { maximum: 2_147_483_647, minimum: 1, type: "integer" } as const;

export type HrTimesheetStatus = "approved" | "draft" | "rejected" | "submitted";

export interface HrTimesheetCreateBody {
  readonly periodEnd: string;
  readonly periodStart: string;
}

export interface HrTimesheetEditEntry {
  readonly description?: string | null;
  readonly entryDate: string;
  readonly expectedVersion?: number;
  readonly minutes: number;
  readonly timesheetEntryId?: string;
}

export interface HrTimesheetEditDraftBody {
  readonly entries: readonly HrTimesheetEditEntry[];
  readonly expectedRootVersion: number;
  readonly expectedTimesheetVersionId: string;
  readonly expectedVersion: number;
}

export type HrTimesheetSubmitBody = Omit<HrTimesheetEditDraftBody, "entries">;
export type HrTimesheetCreateCorrectionBody = HrTimesheetSubmitBody;

export interface HrTimesheetDecisionBody extends HrTimesheetSubmitBody {
  readonly decisionNote?: string | null;
}

export type HrTimesheetApproveBody = HrTimesheetDecisionBody;
export type HrTimesheetRejectBody = HrTimesheetDecisionBody;

export interface HrTimesheetPath {
  readonly timesheetId: string;
}

export interface HrTimesheetEntry {
  readonly description: string | null;
  readonly entryDate: string;
  readonly minutes: number;
  readonly timesheetEntryId: string;
  readonly version: number;
}

export interface HrTimesheetCurrentVersion {
  readonly assignedApproverWorkerProfileId: string | null;
  readonly entries: readonly HrTimesheetEntry[];
  readonly rowVersion: number;
  readonly status: HrTimesheetStatus;
  readonly submittedAt: string | null;
  readonly supersedesVersionId: string | null;
  readonly timesheetVersionId: string;
  readonly totalMinutes: number;
  readonly version: number;
}

export interface HrTimesheetResponse {
  readonly currentVersion: HrTimesheetCurrentVersion;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly rootVersion: number;
  readonly timesheetId: string;
  readonly workerProfileId: string;
}

const editEntrySchema = {
  additionalProperties: false,
  properties: {
    description: { anyOf: [{ maxLength: 500, minLength: 1, type: "string" }, { type: "null" }] },
    entryDate: date,
    expectedVersion: version,
    minutes: { maximum: 1440, minimum: 1, type: "integer" },
    timesheetEntryId: uuid,
  },
  required: ["entryDate", "minutes"],
  type: "object",
} as const;
const expectedProperties = {
  expectedRootVersion: version,
  expectedTimesheetVersionId: uuid,
  expectedVersion: version,
} as const;

export const hrTimesheetCreateBodySchema = {
  $id: "HrTimesheetCreateRequestV1",
  additionalProperties: false,
  properties: { periodEnd: date, periodStart: date },
  required: ["periodEnd", "periodStart"],
  type: "object",
} as const;

export const hrTimesheetEditDraftBodySchema = {
  $id: "HrTimesheetEditDraftRequestV1",
  additionalProperties: false,
  properties: {
    entries: { items: editEntrySchema, maxItems: 50, type: "array" },
    ...expectedProperties,
  },
  required: ["entries", "expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"],
  type: "object",
} as const;

export const hrTimesheetSubmitBodySchema = {
  $id: "HrTimesheetSubmitRequestV1",
  additionalProperties: false,
  properties: expectedProperties,
  required: ["expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"],
  type: "object",
} as const;

export const hrTimesheetCreateCorrectionBodySchema = {
  $id: "HrTimesheetCreateCorrectionRequestV1",
  additionalProperties: false,
  properties: expectedProperties,
  required: ["expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"],
  type: "object",
} as const;

const decisionProperties = {
  decisionNote: {
    anyOf: [{ maxLength: 2000, minLength: 1, type: "string" }, { type: "null" }],
  },
  ...expectedProperties,
} as const;

export const hrTimesheetApproveBodySchema = {
  $id: "HrTimesheetApproveRequestV1",
  additionalProperties: false,
  properties: decisionProperties,
  required: ["expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"],
  type: "object",
} as const;

export const hrTimesheetRejectBodySchema = {
  $id: "HrTimesheetRejectRequestV1",
  additionalProperties: false,
  properties: decisionProperties,
  required: ["expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"],
  type: "object",
} as const;

export const hrTimesheetPathSchema = {
  $id: "HrTimesheetPathV1",
  additionalProperties: false,
  properties: { timesheetId: uuid },
  required: ["timesheetId"],
  type: "object",
} as const;

const responseEntrySchema = {
  additionalProperties: false,
  properties: {
    description: { anyOf: [{ maxLength: 500, minLength: 1, type: "string" }, { type: "null" }] },
    entryDate: date,
    minutes: { maximum: 1440, minimum: 1, type: "integer" },
    timesheetEntryId: uuid,
    version,
  },
  required: ["description", "entryDate", "minutes", "timesheetEntryId", "version"],
  type: "object",
} as const;

export const hrTimesheetResponseSchema = {
  $id: "HrTimesheetResponseV1",
  additionalProperties: false,
  properties: {
    currentVersion: {
      additionalProperties: false,
      properties: {
        assignedApproverWorkerProfileId: { anyOf: [uuid, { type: "null" }] },
        entries: { items: responseEntrySchema, maxItems: 50, type: "array" },
        rowVersion: version,
        status: { enum: ["approved", "draft", "rejected", "submitted"] },
        submittedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
        supersedesVersionId: { anyOf: [uuid, { type: "null" }] },
        timesheetVersionId: uuid,
        totalMinutes: { maximum: 72_000, minimum: 0, type: "integer" },
        version,
      },
      required: [
        "assignedApproverWorkerProfileId",
        "entries",
        "rowVersion",
        "status",
        "submittedAt",
        "supersedesVersionId",
        "timesheetVersionId",
        "totalMinutes",
        "version",
      ],
      type: "object",
    },
    periodEnd: date,
    periodStart: date,
    rootVersion: version,
    timesheetId: uuid,
    workerProfileId: uuid,
  },
  required: [
    "currentVersion",
    "periodEnd",
    "periodStart",
    "rootVersion",
    "timesheetId",
    "workerProfileId",
  ],
  type: "object",
} as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new TypeError();
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError();
  return value;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    throw new TypeError();
  return Number(value);
}
function boundedTotal(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 72_000)
    throw new TypeError();
  return Number(value);
}
const uuidExpression = new RegExp(uuidPattern);
const dateExpression = new RegExp(datePattern);

export function parseHrTimesheetCreateBody(value: unknown): HrTimesheetCreateBody {
  const input = record(value);
  exact(input, ["periodEnd", "periodStart"]);
  return {
    periodEnd: string(input.periodEnd, dateExpression),
    periodStart: string(input.periodStart, dateExpression),
  };
}

export function parseHrTimesheetEditDraftBody(value: unknown): HrTimesheetEditDraftBody {
  const input = record(value);
  exact(input, ["entries", "expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"]);
  if (!Array.isArray(input.entries) || input.entries.length > 50) throw new TypeError();
  const entries = input.entries.map((candidate) => {
    const entry = record(candidate);
    const allowed = ["description", "entryDate", "expectedVersion", "minutes", "timesheetEntryId"];
    if (Object.keys(entry).some((key) => !allowed.includes(key))) throw new TypeError();
    const hasId = entry.timesheetEntryId !== undefined;
    const hasVersion = entry.expectedVersion !== undefined;
    if (hasId !== hasVersion || !Number.isSafeInteger(entry.minutes)) throw new TypeError();
    if (
      entry.description !== undefined &&
      entry.description !== null &&
      typeof entry.description !== "string"
    )
      throw new TypeError();
    return {
      ...(entry.description === undefined ? {} : { description: entry.description }),
      entryDate: string(entry.entryDate, dateExpression),
      ...(hasVersion ? { expectedVersion: positive(entry.expectedVersion) } : {}),
      minutes: Number(entry.minutes),
      ...(hasId ? { timesheetEntryId: string(entry.timesheetEntryId, uuidExpression) } : {}),
    };
  });
  return {
    entries,
    expectedRootVersion: positive(input.expectedRootVersion),
    expectedTimesheetVersionId: string(input.expectedTimesheetVersionId, uuidExpression),
    expectedVersion: positive(input.expectedVersion),
  };
}

export function parseHrTimesheetSubmitBody(value: unknown): HrTimesheetSubmitBody {
  const input = record(value);
  exact(input, ["expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"]);
  return {
    expectedRootVersion: positive(input.expectedRootVersion),
    expectedTimesheetVersionId: string(input.expectedTimesheetVersionId, uuidExpression),
    expectedVersion: positive(input.expectedVersion),
  };
}

export function parseHrTimesheetCreateCorrectionBody(
  value: unknown,
): HrTimesheetCreateCorrectionBody {
  return parseHrTimesheetSubmitBody(value);
}

function parseHrTimesheetDecisionBody(value: unknown): HrTimesheetDecisionBody {
  const input = record(value);
  const keys =
    input.decisionNote === undefined
      ? ["expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"]
      : ["decisionNote", "expectedRootVersion", "expectedTimesheetVersionId", "expectedVersion"];
  exact(input, keys);
  if (
    input.decisionNote !== undefined &&
    input.decisionNote !== null &&
    (typeof input.decisionNote !== "string" ||
      input.decisionNote.length < 1 ||
      input.decisionNote.length > 2000)
  ) {
    throw new TypeError();
  }
  return {
    ...(input.decisionNote === undefined ? {} : { decisionNote: input.decisionNote }),
    expectedRootVersion: positive(input.expectedRootVersion),
    expectedTimesheetVersionId: string(input.expectedTimesheetVersionId, uuidExpression),
    expectedVersion: positive(input.expectedVersion),
  };
}

export function parseHrTimesheetApproveBody(value: unknown): HrTimesheetApproveBody {
  return parseHrTimesheetDecisionBody(value);
}

export function parseHrTimesheetRejectBody(value: unknown): HrTimesheetRejectBody {
  return parseHrTimesheetDecisionBody(value);
}

export function parseHrTimesheetPath(value: unknown): HrTimesheetPath {
  const input = record(value);
  exact(input, ["timesheetId"]);
  return { timesheetId: string(input.timesheetId, uuidExpression) };
}

export function parseHrTimesheetResponse(value: unknown): HrTimesheetResponse {
  const root = record(value);
  exact(root, [
    "currentVersion",
    "periodEnd",
    "periodStart",
    "rootVersion",
    "timesheetId",
    "workerProfileId",
  ]);
  const current = record(root.currentVersion);
  exact(current, [
    "assignedApproverWorkerProfileId",
    "entries",
    "rowVersion",
    "status",
    "submittedAt",
    "supersedesVersionId",
    "timesheetVersionId",
    "totalMinutes",
    "version",
  ]);
  if (!Array.isArray(current.entries) || current.entries.length > 50) throw new TypeError();
  if (!["approved", "draft", "rejected", "submitted"].includes(String(current.status)))
    throw new TypeError();
  const nullableUuid = (candidate: unknown) =>
    candidate === null ? null : string(candidate, uuidExpression);
  const entries = current.entries.map((candidate) => {
    const entry = record(candidate);
    exact(entry, ["description", "entryDate", "minutes", "timesheetEntryId", "version"]);
    if (
      (entry.description !== null && typeof entry.description !== "string") ||
      !Number.isSafeInteger(entry.minutes) ||
      Number(entry.minutes) < 1 ||
      Number(entry.minutes) > 1440
    )
      throw new TypeError();
    return {
      description: entry.description as string | null,
      entryDate: string(entry.entryDate, dateExpression),
      minutes: Number(entry.minutes),
      timesheetEntryId: string(entry.timesheetEntryId, uuidExpression),
      version: positive(entry.version),
    };
  });
  return {
    currentVersion: {
      assignedApproverWorkerProfileId: nullableUuid(current.assignedApproverWorkerProfileId),
      entries,
      rowVersion: positive(current.rowVersion),
      status: current.status as HrTimesheetStatus,
      submittedAt:
        current.submittedAt === null
          ? null
          : new Date(string(current.submittedAt, /.+/)).toISOString(),
      supersedesVersionId: nullableUuid(current.supersedesVersionId),
      timesheetVersionId: string(current.timesheetVersionId, uuidExpression),
      totalMinutes: boundedTotal(current.totalMinutes),
      version: positive(current.version),
    },
    periodEnd: string(root.periodEnd, dateExpression),
    periodStart: string(root.periodStart, dateExpression),
    rootVersion: positive(root.rootVersion),
    timesheetId: string(root.timesheetId, uuidExpression),
    workerProfileId: string(root.workerProfileId, uuidExpression),
  };
}
