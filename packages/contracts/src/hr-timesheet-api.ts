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

export interface HrTimesheetOwnListQuery {
  readonly cursorPeriodStart?: string;
  readonly cursorTimesheetId?: string;
  readonly pageSize?: number;
}

export interface HrTimesheetAssignedListQuery {
  readonly cursorSubmittedAt?: string;
  readonly cursorTimesheetVersionId?: string;
  readonly pageSize?: number;
}

export interface HrTimesheetDetailQuery {
  readonly cursorTimesheetVersionId?: string;
  readonly cursorVersion?: number;
  readonly pageSize?: number;
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
  readonly accessScope?: "assigned" | "own" | "tenant";
  readonly currentVersion: HrTimesheetCurrentVersion;
  readonly history?: HrTimesheetHistoryPage;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly rootVersion: number;
  readonly timesheetId: string;
  readonly workerProfileId: string;
}

export interface HrTimesheetHistoryItem {
  readonly assignedApproverWorkerProfileId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly rowVersion: number;
  readonly status: HrTimesheetStatus;
  readonly submittedAt: string | null;
  readonly supersedesVersionId: string | null;
  readonly timesheetVersionId: string;
  readonly totalMinutes: number;
  readonly version: number;
}

export interface HrTimesheetHistoryCursor {
  readonly timesheetVersionId: string;
  readonly version: number;
}

export interface HrTimesheetHistoryPage {
  readonly items: readonly HrTimesheetHistoryItem[];
  readonly nextCursor: HrTimesheetHistoryCursor | null;
}

export interface HrTimesheetListItem {
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly rootVersion: number;
  readonly status: HrTimesheetStatus;
  readonly submittedAt: string | null;
  readonly timesheetId: string;
  readonly timesheetVersionId: string;
  readonly totalMinutes: number;
  readonly version: number;
  readonly workerProfileId: string;
  readonly workItemId: string | null;
}

export interface HrTimesheetOwnCursor {
  readonly periodStart: string;
  readonly timesheetId: string;
}

export interface HrTimesheetAssignedCursor {
  readonly submittedAt: string;
  readonly timesheetVersionId: string;
}

export type HrTimesheetListResponse =
  | Readonly<{
      items: readonly HrTimesheetListItem[];
      kind: "own";
      nextCursor: HrTimesheetOwnCursor | null;
    }>
  | Readonly<{
      items: readonly HrTimesheetListItem[];
      kind: "assigned";
      nextCursor: HrTimesheetAssignedCursor | null;
    }>;

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

const pageSize = { maximum: 50, minimum: 1, type: "integer" } as const;

export const hrTimesheetOwnListQuerySchema = {
  $id: "HrTimesheetOwnListQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorPeriodStart: ["cursorTimesheetId"],
    cursorTimesheetId: ["cursorPeriodStart"],
  },
  properties: {
    cursorPeriodStart: date,
    cursorTimesheetId: uuid,
    pageSize,
  },
  type: "object",
} as const;

export const hrTimesheetAssignedListQuerySchema = {
  $id: "HrTimesheetAssignedListQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorSubmittedAt: ["cursorTimesheetVersionId"],
    cursorTimesheetVersionId: ["cursorSubmittedAt"],
  },
  properties: {
    cursorSubmittedAt: { format: "date-time", type: "string" },
    cursorTimesheetVersionId: uuid,
    pageSize,
  },
  type: "object",
} as const;

export const hrTimesheetDetailQuerySchema = {
  $id: "HrTimesheetDetailQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorTimesheetVersionId: ["cursorVersion"],
    cursorVersion: ["cursorTimesheetVersionId"],
  },
  properties: {
    cursorTimesheetVersionId: uuid,
    cursorVersion: version,
    pageSize,
  },
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

const historyItemSchema = {
  additionalProperties: false,
  properties: {
    assignedApproverWorkerProfileId: { anyOf: [uuid, { type: "null" }] },
    decidedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
    decisionNote: {
      anyOf: [{ maxLength: 2000, minLength: 1, type: "string" }, { type: "null" }],
    },
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
    "decidedAt",
    "decisionNote",
    "rowVersion",
    "status",
    "submittedAt",
    "supersedesVersionId",
    "timesheetVersionId",
    "totalMinutes",
    "version",
  ],
  type: "object",
} as const;

const historyPageSchema = {
  additionalProperties: false,
  properties: {
    items: { items: historyItemSchema, maxItems: 50, type: "array" },
    nextCursor: {
      anyOf: [
        {
          additionalProperties: false,
          properties: { timesheetVersionId: uuid, version },
          required: ["timesheetVersionId", "version"],
          type: "object",
        },
        { type: "null" },
      ],
    },
  },
  required: ["items", "nextCursor"],
  type: "object",
} as const;

export const hrTimesheetResponseSchema = {
  $id: "HrTimesheetResponseV1",
  additionalProperties: false,
  properties: {
    accessScope: { enum: ["assigned", "own", "tenant"] },
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
    history: historyPageSchema,
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

const listItemSchema = {
  additionalProperties: false,
  properties: {
    periodEnd: date,
    periodStart: date,
    rootVersion: version,
    status: { enum: ["approved", "draft", "rejected", "submitted"] },
    submittedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
    timesheetId: uuid,
    timesheetVersionId: uuid,
    totalMinutes: { maximum: 72_000, minimum: 0, type: "integer" },
    version,
    workerProfileId: uuid,
    workItemId: { anyOf: [uuid, { type: "null" }] },
  },
  required: [
    "periodEnd",
    "periodStart",
    "rootVersion",
    "status",
    "submittedAt",
    "timesheetId",
    "timesheetVersionId",
    "totalMinutes",
    "version",
    "workerProfileId",
    "workItemId",
  ],
  type: "object",
} as const;

export const hrTimesheetListResponseSchema = {
  $id: "HrTimesheetListResponseV1",
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        kind: { const: "own" },
        nextCursor: {
          anyOf: [
            {
              additionalProperties: false,
              properties: { periodStart: date, timesheetId: uuid },
              required: ["periodStart", "timesheetId"],
              type: "object",
            },
            { type: "null" },
          ],
        },
      },
      type: "object",
    },
    {
      properties: {
        kind: { const: "assigned" },
        nextCursor: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                submittedAt: { format: "date-time", type: "string" },
                timesheetVersionId: uuid,
              },
              required: ["submittedAt", "timesheetVersionId"],
              type: "object",
            },
            { type: "null" },
          ],
        },
      },
      type: "object",
    },
  ],
  properties: {
    items: { items: listItemSchema, maxItems: 50, type: "array" },
    kind: { enum: ["assigned", "own"] },
    nextCursor: { type: ["object", "null"] },
  },
  required: ["items", "kind", "nextCursor"],
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

function boundedPageSize(value: unknown): number {
  const selected = positive(value);
  if (selected > 50) throw new TypeError();
  return selected;
}

function canonicalTimestamp(value: unknown): string {
  const selected = string(value, /.+/);
  const parsed = new Date(selected);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/.test(selected) ||
    parsed.toISOString().slice(0, 23) !== selected.slice(0, 23)
  )
    throw new TypeError();
  return selected;
}

export function parseHrTimesheetOwnListQuery(value: unknown): HrTimesheetOwnListQuery {
  const input = record(value);
  const allowed = ["cursorPeriodStart", "cursorTimesheetId", "pageSize"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError();
  const hasDate = Object.hasOwn(input, "cursorPeriodStart");
  const hasId = Object.hasOwn(input, "cursorTimesheetId");
  if (hasDate !== hasId) throw new TypeError();
  return {
    ...(hasDate
      ? {
          cursorPeriodStart: string(input.cursorPeriodStart, dateExpression),
          cursorTimesheetId: string(input.cursorTimesheetId, uuidExpression),
        }
      : {}),
    ...(Object.hasOwn(input, "pageSize") ? { pageSize: boundedPageSize(input.pageSize) } : {}),
  };
}

export function parseHrTimesheetAssignedListQuery(value: unknown): HrTimesheetAssignedListQuery {
  const input = record(value);
  const allowed = ["cursorSubmittedAt", "cursorTimesheetVersionId", "pageSize"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError();
  const hasTimestamp = Object.hasOwn(input, "cursorSubmittedAt");
  const hasId = Object.hasOwn(input, "cursorTimesheetVersionId");
  if (hasTimestamp !== hasId) throw new TypeError();
  return {
    ...(hasTimestamp
      ? {
          cursorSubmittedAt: canonicalTimestamp(input.cursorSubmittedAt),
          cursorTimesheetVersionId: string(input.cursorTimesheetVersionId, uuidExpression),
        }
      : {}),
    ...(Object.hasOwn(input, "pageSize") ? { pageSize: boundedPageSize(input.pageSize) } : {}),
  };
}

export function parseHrTimesheetDetailQuery(value: unknown): HrTimesheetDetailQuery {
  const input = record(value);
  const allowed = ["cursorTimesheetVersionId", "cursorVersion", "pageSize"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError();
  const hasId = Object.hasOwn(input, "cursorTimesheetVersionId");
  const hasVersion = Object.hasOwn(input, "cursorVersion");
  if (hasId !== hasVersion) throw new TypeError();
  return {
    ...(hasId
      ? {
          cursorTimesheetVersionId: string(input.cursorTimesheetVersionId, uuidExpression),
          cursorVersion: positive(input.cursorVersion),
        }
      : {}),
    ...(Object.hasOwn(input, "pageSize") ? { pageSize: boundedPageSize(input.pageSize) } : {}),
  };
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : string(value, uuidExpression);
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : canonicalTimestamp(value);
}

function parseHistoryItem(value: unknown): HrTimesheetHistoryItem {
  const item = record(value);
  exact(item, [
    "assignedApproverWorkerProfileId",
    "decidedAt",
    "decisionNote",
    "rowVersion",
    "status",
    "submittedAt",
    "supersedesVersionId",
    "timesheetVersionId",
    "totalMinutes",
    "version",
  ]);
  if (!["approved", "draft", "rejected", "submitted"].includes(String(item.status)))
    throw new TypeError();
  if (
    item.decisionNote !== null &&
    (typeof item.decisionNote !== "string" ||
      item.decisionNote.length < 1 ||
      item.decisionNote.length > 2000)
  ) {
    throw new TypeError();
  }
  return {
    assignedApproverWorkerProfileId: nullableUuid(item.assignedApproverWorkerProfileId),
    decidedAt: nullableTimestamp(item.decidedAt),
    decisionNote: item.decisionNote as string | null,
    rowVersion: positive(item.rowVersion),
    status: item.status as HrTimesheetStatus,
    submittedAt: nullableTimestamp(item.submittedAt),
    supersedesVersionId: nullableUuid(item.supersedesVersionId),
    timesheetVersionId: string(item.timesheetVersionId, uuidExpression),
    totalMinutes: boundedTotal(item.totalMinutes),
    version: positive(item.version),
  };
}

function parseHistoryPage(value: unknown): HrTimesheetHistoryPage {
  const page = record(value);
  exact(page, ["items", "nextCursor"]);
  if (!Array.isArray(page.items) || page.items.length > 50) throw new TypeError();
  let nextCursor: HrTimesheetHistoryCursor | null = null;
  if (page.nextCursor !== null) {
    const cursor = record(page.nextCursor);
    exact(cursor, ["timesheetVersionId", "version"]);
    nextCursor = {
      timesheetVersionId: string(cursor.timesheetVersionId, uuidExpression),
      version: positive(cursor.version),
    };
  }
  return { items: page.items.map(parseHistoryItem), nextCursor };
}

export function parseHrTimesheetResponse(value: unknown): HrTimesheetResponse {
  const root = record(value);
  const enriched = Object.hasOwn(root, "accessScope") || Object.hasOwn(root, "history");
  if (Object.hasOwn(root, "accessScope") !== Object.hasOwn(root, "history")) throw new TypeError();
  exact(
    root,
    enriched
      ? [
          "accessScope",
          "currentVersion",
          "history",
          "periodEnd",
          "periodStart",
          "rootVersion",
          "timesheetId",
          "workerProfileId",
        ]
      : [
          "currentVersion",
          "periodEnd",
          "periodStart",
          "rootVersion",
          "timesheetId",
          "workerProfileId",
        ],
  );
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
  const accessScope = root.accessScope;
  if (enriched && !["assigned", "own", "tenant"].includes(String(accessScope)))
    throw new TypeError();
  return {
    ...(enriched
      ? {
          accessScope: accessScope as "assigned" | "own" | "tenant",
        }
      : {}),
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
    ...(enriched ? { history: parseHistoryPage(root.history) } : {}),
    periodEnd: string(root.periodEnd, dateExpression),
    periodStart: string(root.periodStart, dateExpression),
    rootVersion: positive(root.rootVersion),
    timesheetId: string(root.timesheetId, uuidExpression),
    workerProfileId: string(root.workerProfileId, uuidExpression),
  };
}

function parseListItem(value: unknown): HrTimesheetListItem {
  const item = record(value);
  exact(item, [
    "periodEnd",
    "periodStart",
    "rootVersion",
    "status",
    "submittedAt",
    "timesheetId",
    "timesheetVersionId",
    "totalMinutes",
    "version",
    "workerProfileId",
    "workItemId",
  ]);
  if (!["approved", "draft", "rejected", "submitted"].includes(String(item.status)))
    throw new TypeError();
  return {
    periodEnd: string(item.periodEnd, dateExpression),
    periodStart: string(item.periodStart, dateExpression),
    rootVersion: positive(item.rootVersion),
    status: item.status as HrTimesheetStatus,
    submittedAt: nullableTimestamp(item.submittedAt),
    timesheetId: string(item.timesheetId, uuidExpression),
    timesheetVersionId: string(item.timesheetVersionId, uuidExpression),
    totalMinutes: boundedTotal(item.totalMinutes),
    version: positive(item.version),
    workerProfileId: string(item.workerProfileId, uuidExpression),
    workItemId: nullableUuid(item.workItemId),
  };
}

export function parseHrTimesheetListResponse(value: unknown): HrTimesheetListResponse {
  const page = record(value);
  exact(page, ["items", "kind", "nextCursor"]);
  if (!Array.isArray(page.items) || page.items.length > 50) throw new TypeError();
  const items = page.items.map(parseListItem);
  if (page.kind === "own") {
    let nextCursor: HrTimesheetOwnCursor | null = null;
    if (page.nextCursor !== null) {
      const cursor = record(page.nextCursor);
      exact(cursor, ["periodStart", "timesheetId"]);
      nextCursor = {
        periodStart: string(cursor.periodStart, dateExpression),
        timesheetId: string(cursor.timesheetId, uuidExpression),
      };
    }
    if (items.some((item) => item.workItemId !== null)) throw new TypeError();
    return { items, kind: "own", nextCursor };
  }
  if (page.kind !== "assigned") throw new TypeError();
  let nextCursor: HrTimesheetAssignedCursor | null = null;
  if (page.nextCursor !== null) {
    const cursor = record(page.nextCursor);
    exact(cursor, ["submittedAt", "timesheetVersionId"]);
    nextCursor = {
      submittedAt: canonicalTimestamp(cursor.submittedAt),
      timesheetVersionId: string(cursor.timesheetVersionId, uuidExpression),
    };
  }
  if (
    items.some(
      (item) =>
        item.workItemId === null || item.status !== "submitted" || item.submittedAt === null,
    )
  ) {
    throw new TypeError();
  }
  return { items, kind: "assigned", nextCursor };
}
