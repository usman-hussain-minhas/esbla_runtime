const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const categoryPattern = "^[^\\s,]+$";
const uuid = {
  maxLength: 36,
  minLength: 36,
  pattern: uuidPattern,
  type: "string",
} as const;
const date = {
  format: "date",
  maxLength: 10,
  minLength: 10,
  pattern: datePattern,
  type: "string",
} as const;
const version = { maximum: 2_147_483_647, minimum: 1, type: "integer" } as const;
const amount = { maximum: 2_147_483_647, minimum: 1, type: "integer" } as const;
const total = { maximum: 2_147_483_647, minimum: 0, type: "integer" } as const;
const pageSize = { maximum: 50, minimum: 1, type: "integer" } as const;
const currencyCodes = Object.freeze(Intl.supportedValuesOf("currency"));
const currencyCodeSet = new Set(currencyCodes);

export type HrExpenseClaimStatus = "approved" | "draft" | "rejected" | "submitted";

export interface HrExpenseClaimCreateBody {
  readonly currencyCode: string;
}

export interface HrExpenseClaimEditLine {
  readonly amountMinor: number;
  readonly categoryCode: string;
  readonly description?: string | null;
  readonly expenseDate: string;
  readonly expenseLineId?: string;
  readonly expectedVersion?: number;
}

export interface HrExpenseClaimExpectedBody {
  readonly expectedExpenseClaimVersionId: string;
  readonly expectedRootVersion: number;
  readonly expectedVersion: number;
}

export interface HrExpenseClaimEditDraftBody extends HrExpenseClaimExpectedBody {
  readonly lines: readonly HrExpenseClaimEditLine[];
}

export type HrExpenseClaimSubmitBody = HrExpenseClaimExpectedBody;
export type HrExpenseClaimCreateCorrectionBody = HrExpenseClaimExpectedBody;

export interface HrExpenseClaimDecisionBody extends HrExpenseClaimExpectedBody {
  readonly decisionNote?: string | null;
}

export type HrExpenseClaimApproveBody = HrExpenseClaimDecisionBody;
export type HrExpenseClaimRejectBody = HrExpenseClaimDecisionBody;

export interface HrExpenseClaimPath {
  readonly expenseClaimId: string;
}

export interface HrExpenseClaimOwnListQuery {
  readonly cursorCreatedAt?: string;
  readonly cursorExpenseClaimId?: string;
  readonly pageSize?: number;
}

export interface HrExpenseClaimAssignedListQuery {
  readonly cursorExpenseClaimVersionId?: string;
  readonly cursorSubmittedAt?: string;
  readonly pageSize?: number;
}

export interface HrExpenseClaimDetailQuery {
  readonly cursorExpenseClaimVersionId?: string;
  readonly cursorVersion?: number;
  readonly pageSize?: number;
}

export interface HrExpenseClaimLine {
  readonly amountMinor: number;
  readonly categoryCode: string;
  readonly description: string | null;
  readonly expenseDate: string;
  readonly expenseLineId: string;
  readonly version: number;
}

export interface HrExpenseClaimCurrentVersion {
  readonly assignedApproverWorkerProfileId: string | null;
  readonly currencyCode: string;
  readonly expenseClaimVersionId: string;
  readonly lines: readonly HrExpenseClaimLine[];
  readonly rowVersion: number;
  readonly status: HrExpenseClaimStatus;
  readonly submittedAt: string | null;
  readonly supersedesVersionId: string | null;
  readonly totalAmountMinor: number;
  readonly version: number;
}

export interface HrExpenseClaimHistoryItem {
  readonly assignedApproverWorkerProfileId: string | null;
  readonly currencyCode: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly expenseClaimVersionId: string;
  readonly rowVersion: number;
  readonly status: HrExpenseClaimStatus;
  readonly submittedAt: string | null;
  readonly supersedesVersionId: string | null;
  readonly totalAmountMinor: number;
  readonly version: number;
}

export interface HrExpenseClaimHistoryCursor {
  readonly expenseClaimVersionId: string;
  readonly version: number;
}

export interface HrExpenseClaimHistoryPage {
  readonly items: readonly HrExpenseClaimHistoryItem[];
  readonly nextCursor: HrExpenseClaimHistoryCursor | null;
}

export interface HrExpenseClaimResponse {
  readonly accessScope?: "assigned" | "own";
  readonly currentVersion: HrExpenseClaimCurrentVersion;
  readonly expenseClaimId: string;
  readonly history?: HrExpenseClaimHistoryPage;
  readonly rootVersion: number;
  readonly workerProfileId: string;
}

export interface HrExpenseClaimListItem {
  readonly createdAt: string;
  readonly currencyCode: string;
  readonly expenseClaimId: string;
  readonly expenseClaimVersionId: string;
  readonly rootVersion: number;
  readonly status: HrExpenseClaimStatus;
  readonly submittedAt: string | null;
  readonly totalAmountMinor: number;
  readonly version: number;
  readonly workerProfileId: string;
  readonly workItemId: string | null;
}

export interface HrExpenseClaimOwnCursor {
  readonly createdAt: string;
  readonly expenseClaimId: string;
}

export interface HrExpenseClaimAssignedCursor {
  readonly expenseClaimVersionId: string;
  readonly submittedAt: string;
}

export type HrExpenseClaimListResponse =
  | Readonly<{
      items: readonly HrExpenseClaimListItem[];
      kind: "own";
      nextCursor: HrExpenseClaimOwnCursor | null;
    }>
  | Readonly<{
      items: readonly HrExpenseClaimListItem[];
      kind: "assigned";
      nextCursor: HrExpenseClaimAssignedCursor | null;
    }>;

const expectedProperties = {
  expectedExpenseClaimVersionId: uuid,
  expectedRootVersion: version,
  expectedVersion: version,
} as const;
const decisionProperties = {
  decisionNote: {
    anyOf: [{ maxLength: 2000, minLength: 1, type: "string" }, { type: "null" }],
  },
  ...expectedProperties,
} as const;
const editLineSchema = {
  additionalProperties: false,
  dependencies: {
    expenseLineId: ["expectedVersion"],
    expectedVersion: ["expenseLineId"],
  },
  properties: {
    amountMinor: amount,
    categoryCode: { maxLength: 64, minLength: 1, pattern: categoryPattern, type: "string" },
    description: { anyOf: [{ maxLength: 500, minLength: 1, type: "string" }, { type: "null" }] },
    expenseDate: date,
    expenseLineId: uuid,
    expectedVersion: version,
  },
  required: ["amountMinor", "categoryCode", "expenseDate"],
  type: "object",
} as const;

export const hrExpenseClaimCreateBodySchema = {
  $id: "HrExpenseCreateRequestV1",
  additionalProperties: false,
  properties: { currencyCode: { enum: currencyCodes, type: "string" } },
  required: ["currencyCode"],
  type: "object",
} as const;

export const hrExpenseClaimEditDraftBodySchema = {
  $id: "HrExpenseEditDraftRequestV1",
  additionalProperties: false,
  properties: {
    ...expectedProperties,
    lines: { items: editLineSchema, maxItems: 50, type: "array" },
  },
  required: ["expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion", "lines"],
  type: "object",
} as const;

export const hrExpenseClaimSubmitBodySchema = {
  $id: "HrExpenseSubmitRequestV1",
  additionalProperties: false,
  properties: expectedProperties,
  required: ["expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion"],
  type: "object",
} as const;

export const hrExpenseClaimCreateCorrectionBodySchema = {
  $id: "HrExpenseCreateCorrectionRequestV1",
  additionalProperties: false,
  properties: expectedProperties,
  required: ["expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion"],
  type: "object",
} as const;

export const hrExpenseClaimApproveBodySchema = {
  $id: "HrExpenseApproveRequestV1",
  additionalProperties: false,
  properties: decisionProperties,
  required: ["expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion"],
  type: "object",
} as const;

export const hrExpenseClaimRejectBodySchema = {
  $id: "HrExpenseRejectRequestV1",
  additionalProperties: false,
  properties: decisionProperties,
  required: ["expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion"],
  type: "object",
} as const;

export const hrExpenseClaimPathSchema = {
  $id: "HrExpenseClaimPathV1",
  additionalProperties: false,
  properties: { expenseClaimId: uuid },
  required: ["expenseClaimId"],
  type: "object",
} as const;

export const hrExpenseClaimOwnListQuerySchema = {
  $id: "HrExpenseOwnListQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorCreatedAt: ["cursorExpenseClaimId"],
    cursorExpenseClaimId: ["cursorCreatedAt"],
  },
  properties: {
    cursorCreatedAt: { format: "date-time", type: "string" },
    cursorExpenseClaimId: uuid,
    pageSize,
  },
  type: "object",
} as const;

export const hrExpenseClaimAssignedListQuerySchema = {
  $id: "HrExpenseAssignedListQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorExpenseClaimVersionId: ["cursorSubmittedAt"],
    cursorSubmittedAt: ["cursorExpenseClaimVersionId"],
  },
  properties: {
    cursorExpenseClaimVersionId: uuid,
    cursorSubmittedAt: { format: "date-time", type: "string" },
    pageSize,
  },
  type: "object",
} as const;

export const hrExpenseClaimDetailQuerySchema = {
  $id: "HrExpenseDetailQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorExpenseClaimVersionId: ["cursorVersion"],
    cursorVersion: ["cursorExpenseClaimVersionId"],
  },
  properties: {
    cursorExpenseClaimVersionId: uuid,
    cursorVersion: version,
    pageSize,
  },
  type: "object",
} as const;

const responseLineSchema = {
  additionalProperties: false,
  properties: {
    amountMinor: amount,
    categoryCode: { maxLength: 64, minLength: 1, pattern: categoryPattern, type: "string" },
    description: { anyOf: [{ maxLength: 500, minLength: 1, type: "string" }, { type: "null" }] },
    expenseDate: date,
    expenseLineId: uuid,
    version,
  },
  required: [
    "amountMinor",
    "categoryCode",
    "description",
    "expenseDate",
    "expenseLineId",
    "version",
  ],
  type: "object",
} as const;

const historyItemSchema = {
  additionalProperties: false,
  properties: {
    assignedApproverWorkerProfileId: { anyOf: [uuid, { type: "null" }] },
    currencyCode: { enum: currencyCodes, type: "string" },
    decidedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
    decisionNote: {
      anyOf: [{ maxLength: 2000, minLength: 1, type: "string" }, { type: "null" }],
    },
    expenseClaimVersionId: uuid,
    rowVersion: version,
    status: { enum: ["approved", "draft", "rejected", "submitted"] },
    submittedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
    supersedesVersionId: { anyOf: [uuid, { type: "null" }] },
    totalAmountMinor: total,
    version,
  },
  required: [
    "assignedApproverWorkerProfileId",
    "currencyCode",
    "decidedAt",
    "decisionNote",
    "expenseClaimVersionId",
    "rowVersion",
    "status",
    "submittedAt",
    "supersedesVersionId",
    "totalAmountMinor",
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
          properties: { expenseClaimVersionId: uuid, version },
          required: ["expenseClaimVersionId", "version"],
          type: "object",
        },
        { type: "null" },
      ],
    },
  },
  required: ["items", "nextCursor"],
  type: "object",
} as const;

export const hrExpenseClaimResponseSchema = {
  $id: "HrExpenseClaimResponseV1",
  additionalProperties: false,
  dependencies: {
    accessScope: ["history"],
    history: ["accessScope"],
  },
  properties: {
    accessScope: { enum: ["assigned", "own"] },
    currentVersion: {
      additionalProperties: false,
      properties: {
        assignedApproverWorkerProfileId: { anyOf: [uuid, { type: "null" }] },
        currencyCode: { enum: currencyCodes, type: "string" },
        expenseClaimVersionId: uuid,
        lines: { items: responseLineSchema, maxItems: 50, type: "array" },
        rowVersion: version,
        status: { enum: ["approved", "draft", "rejected", "submitted"] },
        submittedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
        supersedesVersionId: { anyOf: [uuid, { type: "null" }] },
        totalAmountMinor: total,
        version,
      },
      required: [
        "assignedApproverWorkerProfileId",
        "currencyCode",
        "expenseClaimVersionId",
        "lines",
        "rowVersion",
        "status",
        "submittedAt",
        "supersedesVersionId",
        "totalAmountMinor",
        "version",
      ],
      type: "object",
    },
    expenseClaimId: uuid,
    history: historyPageSchema,
    rootVersion: version,
    workerProfileId: uuid,
  },
  required: ["currentVersion", "expenseClaimId", "rootVersion", "workerProfileId"],
  type: "object",
} as const;

const listItemSchema = {
  additionalProperties: false,
  properties: {
    createdAt: { format: "date-time", type: "string" },
    currencyCode: { enum: currencyCodes, type: "string" },
    expenseClaimId: uuid,
    expenseClaimVersionId: uuid,
    rootVersion: version,
    status: { enum: ["approved", "draft", "rejected", "submitted"] },
    submittedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
    totalAmountMinor: total,
    version,
    workerProfileId: uuid,
    workItemId: { anyOf: [uuid, { type: "null" }] },
  },
  required: [
    "createdAt",
    "currencyCode",
    "expenseClaimId",
    "expenseClaimVersionId",
    "rootVersion",
    "status",
    "submittedAt",
    "totalAmountMinor",
    "version",
    "workerProfileId",
    "workItemId",
  ],
  type: "object",
} as const;
export const hrExpenseClaimListResponseSchema = {
  $id: "HrExpenseListResponseV1",
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        kind: { const: "own" },
        nextCursor: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                createdAt: { format: "date-time", type: "string" },
                expenseClaimId: uuid,
              },
              required: ["createdAt", "expenseClaimId"],
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
                expenseClaimVersionId: uuid,
                submittedAt: { format: "date-time", type: "string" },
              },
              required: ["expenseClaimVersionId", "submittedAt"],
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
  if (typeof value !== "string" || pattern.exec(value)?.[0] !== value) throw new TypeError();
  return value;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647)
    throw new TypeError();
  return Number(value);
}
function boundedAmount(value: unknown, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < (allowZero ? 0 : 1) ||
    Number(value) > 2_147_483_647
  )
    throw new TypeError();
  return Number(value);
}
function currency(value: unknown): string {
  const selected = string(value, /^[A-Z]{3}$/);
  if (!currencyCodeSet.has(selected)) throw new TypeError();
  return selected;
}
function category(value: unknown): string {
  const selected = string(value, /^\S+$/);
  if (selected.length > 64 || selected.includes(",")) throw new TypeError();
  return selected;
}
function calendarDate(value: unknown): string {
  const selected = string(value, dateExpression);
  const year = Number(selected.slice(0, 4));
  const month = Number(selected.slice(5, 7));
  const day = Number(selected.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    throw new TypeError();
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
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : canonicalTimestamp(value);
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : string(value, new RegExp(uuidPattern));
}
const uuidExpression = new RegExp(uuidPattern);
const dateExpression = new RegExp(datePattern);

function expectedBody(value: unknown): HrExpenseClaimExpectedBody {
  const input = record(value);
  exact(input, ["expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion"]);
  return {
    expectedExpenseClaimVersionId: string(input.expectedExpenseClaimVersionId, uuidExpression),
    expectedRootVersion: positive(input.expectedRootVersion),
    expectedVersion: positive(input.expectedVersion),
  };
}

export function parseHrExpenseClaimCreateBody(value: unknown): HrExpenseClaimCreateBody {
  const input = record(value);
  exact(input, ["currencyCode"]);
  return { currencyCode: currency(input.currencyCode) };
}

export function parseHrExpenseClaimEditDraftBody(value: unknown): HrExpenseClaimEditDraftBody {
  const input = record(value);
  exact(input, [
    "expectedExpenseClaimVersionId",
    "expectedRootVersion",
    "expectedVersion",
    "lines",
  ]);
  if (!Array.isArray(input.lines) || input.lines.length > 50) throw new TypeError();
  const lines = input.lines.map((candidate) => {
    const line = record(candidate);
    const allowed = [
      "amountMinor",
      "categoryCode",
      "description",
      "expenseDate",
      "expenseLineId",
      "expectedVersion",
    ];
    if (Object.keys(line).some((key) => !allowed.includes(key))) throw new TypeError();
    const hasId = Object.hasOwn(line, "expenseLineId");
    const hasVersion = Object.hasOwn(line, "expectedVersion");
    if (hasId !== hasVersion) throw new TypeError();
    if (
      line.description !== undefined &&
      line.description !== null &&
      (typeof line.description !== "string" ||
        line.description.length < 1 ||
        line.description.length > 500)
    )
      throw new TypeError();
    return {
      amountMinor: boundedAmount(line.amountMinor),
      categoryCode: category(line.categoryCode),
      ...(line.description === undefined ? {} : { description: line.description }),
      expenseDate: calendarDate(line.expenseDate),
      ...(hasId ? { expenseLineId: string(line.expenseLineId, uuidExpression) } : {}),
      ...(hasVersion ? { expectedVersion: positive(line.expectedVersion) } : {}),
    };
  });
  return {
    expectedExpenseClaimVersionId: string(input.expectedExpenseClaimVersionId, uuidExpression),
    expectedRootVersion: positive(input.expectedRootVersion),
    expectedVersion: positive(input.expectedVersion),
    lines,
  };
}

export function parseHrExpenseClaimSubmitBody(value: unknown): HrExpenseClaimSubmitBody {
  return expectedBody(value);
}
export function parseHrExpenseClaimCreateCorrectionBody(
  value: unknown,
): HrExpenseClaimCreateCorrectionBody {
  return expectedBody(value);
}

function decisionBody(value: unknown): HrExpenseClaimDecisionBody {
  const input = record(value);
  const keys =
    input.decisionNote === undefined
      ? ["expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion"]
      : ["decisionNote", "expectedExpenseClaimVersionId", "expectedRootVersion", "expectedVersion"];
  exact(input, keys);
  if (
    input.decisionNote !== undefined &&
    input.decisionNote !== null &&
    (typeof input.decisionNote !== "string" ||
      input.decisionNote.length < 1 ||
      input.decisionNote.length > 2000)
  )
    throw new TypeError();
  return {
    ...(input.decisionNote === undefined ? {} : { decisionNote: input.decisionNote }),
    ...expectedBody(
      Object.fromEntries(Object.entries(input).filter(([key]) => key !== "decisionNote")),
    ),
  };
}
export function parseHrExpenseClaimApproveBody(value: unknown): HrExpenseClaimApproveBody {
  return decisionBody(value);
}
export function parseHrExpenseClaimRejectBody(value: unknown): HrExpenseClaimRejectBody {
  return decisionBody(value);
}

export function parseHrExpenseClaimPath(value: unknown): HrExpenseClaimPath {
  const input = record(value);
  exact(input, ["expenseClaimId"]);
  return { expenseClaimId: string(input.expenseClaimId, uuidExpression) };
}
function boundedPageSize(value: unknown): number {
  const selected = positive(value);
  if (selected > 50) throw new TypeError();
  return selected;
}

export function parseHrExpenseClaimOwnListQuery(value: unknown): HrExpenseClaimOwnListQuery {
  const input = record(value);
  const allowed = ["cursorCreatedAt", "cursorExpenseClaimId", "pageSize"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError();
  const hasTimestamp = Object.hasOwn(input, "cursorCreatedAt");
  const hasId = Object.hasOwn(input, "cursorExpenseClaimId");
  if (hasTimestamp !== hasId) throw new TypeError();
  return {
    ...(hasTimestamp
      ? {
          cursorCreatedAt: canonicalTimestamp(input.cursorCreatedAt),
          cursorExpenseClaimId: string(input.cursorExpenseClaimId, uuidExpression),
        }
      : {}),
    ...(Object.hasOwn(input, "pageSize") ? { pageSize: boundedPageSize(input.pageSize) } : {}),
  };
}

export function parseHrExpenseClaimAssignedListQuery(
  value: unknown,
): HrExpenseClaimAssignedListQuery {
  const input = record(value);
  const allowed = ["cursorExpenseClaimVersionId", "cursorSubmittedAt", "pageSize"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError();
  const hasTimestamp = Object.hasOwn(input, "cursorSubmittedAt");
  const hasId = Object.hasOwn(input, "cursorExpenseClaimVersionId");
  if (hasTimestamp !== hasId) throw new TypeError();
  return {
    ...(hasTimestamp
      ? {
          cursorExpenseClaimVersionId: string(input.cursorExpenseClaimVersionId, uuidExpression),
          cursorSubmittedAt: canonicalTimestamp(input.cursorSubmittedAt),
        }
      : {}),
    ...(Object.hasOwn(input, "pageSize") ? { pageSize: boundedPageSize(input.pageSize) } : {}),
  };
}

export function parseHrExpenseClaimDetailQuery(value: unknown): HrExpenseClaimDetailQuery {
  const input = record(value);
  const allowed = ["cursorExpenseClaimVersionId", "cursorVersion", "pageSize"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError();
  const hasId = Object.hasOwn(input, "cursorExpenseClaimVersionId");
  const hasVersion = Object.hasOwn(input, "cursorVersion");
  if (hasId !== hasVersion) throw new TypeError();
  return {
    ...(hasId
      ? {
          cursorExpenseClaimVersionId: string(input.cursorExpenseClaimVersionId, uuidExpression),
          cursorVersion: positive(input.cursorVersion),
        }
      : {}),
    ...(Object.hasOwn(input, "pageSize") ? { pageSize: boundedPageSize(input.pageSize) } : {}),
  };
}

function status(value: unknown): HrExpenseClaimStatus {
  if (typeof value !== "string" || !["approved", "draft", "rejected", "submitted"].includes(value))
    throw new TypeError();
  return value as HrExpenseClaimStatus;
}
function decisionNote(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || value.length < 1 || value.length > 2000))
    throw new TypeError();
  return value as string | null;
}
function parseLine(value: unknown): HrExpenseClaimLine {
  const line = record(value);
  exact(line, [
    "amountMinor",
    "categoryCode",
    "description",
    "expenseDate",
    "expenseLineId",
    "version",
  ]);
  if (
    line.description !== null &&
    (typeof line.description !== "string" ||
      line.description.length < 1 ||
      line.description.length > 500)
  )
    throw new TypeError();
  return {
    amountMinor: boundedAmount(line.amountMinor),
    categoryCode: category(line.categoryCode),
    description: line.description as string | null,
    expenseDate: calendarDate(line.expenseDate),
    expenseLineId: string(line.expenseLineId, uuidExpression),
    version: positive(line.version),
  };
}
function parseHistoryItem(value: unknown): HrExpenseClaimHistoryItem {
  const item = record(value);
  exact(item, [
    "assignedApproverWorkerProfileId",
    "currencyCode",
    "decidedAt",
    "decisionNote",
    "expenseClaimVersionId",
    "rowVersion",
    "status",
    "submittedAt",
    "supersedesVersionId",
    "totalAmountMinor",
    "version",
  ]);
  return {
    assignedApproverWorkerProfileId: nullableUuid(item.assignedApproverWorkerProfileId),
    currencyCode: currency(item.currencyCode),
    decidedAt: nullableTimestamp(item.decidedAt),
    decisionNote: decisionNote(item.decisionNote),
    expenseClaimVersionId: string(item.expenseClaimVersionId, uuidExpression),
    rowVersion: positive(item.rowVersion),
    status: status(item.status),
    submittedAt: nullableTimestamp(item.submittedAt),
    supersedesVersionId: nullableUuid(item.supersedesVersionId),
    totalAmountMinor: boundedAmount(item.totalAmountMinor, true),
    version: positive(item.version),
  };
}
function parseHistory(value: unknown): HrExpenseClaimHistoryPage {
  const page = record(value);
  exact(page, ["items", "nextCursor"]);
  if (!Array.isArray(page.items) || page.items.length > 50) throw new TypeError();
  let nextCursor: HrExpenseClaimHistoryCursor | null = null;
  if (page.nextCursor !== null) {
    const cursor = record(page.nextCursor);
    exact(cursor, ["expenseClaimVersionId", "version"]);
    nextCursor = {
      expenseClaimVersionId: string(cursor.expenseClaimVersionId, uuidExpression),
      version: positive(cursor.version),
    };
  }
  return { items: page.items.map(parseHistoryItem), nextCursor };
}

export function parseHrExpenseClaimResponse(value: unknown): HrExpenseClaimResponse {
  const root = record(value);
  const enriched = Object.hasOwn(root, "accessScope") || Object.hasOwn(root, "history");
  if (Object.hasOwn(root, "accessScope") !== Object.hasOwn(root, "history")) throw new TypeError();
  exact(
    root,
    enriched
      ? [
          "accessScope",
          "currentVersion",
          "expenseClaimId",
          "history",
          "rootVersion",
          "workerProfileId",
        ]
      : ["currentVersion", "expenseClaimId", "rootVersion", "workerProfileId"],
  );
  const current = record(root.currentVersion);
  exact(current, [
    "assignedApproverWorkerProfileId",
    "currencyCode",
    "expenseClaimVersionId",
    "lines",
    "rowVersion",
    "status",
    "submittedAt",
    "supersedesVersionId",
    "totalAmountMinor",
    "version",
  ]);
  if (!Array.isArray(current.lines) || current.lines.length > 50) throw new TypeError();
  if (
    enriched &&
    (typeof root.accessScope !== "string" || !["assigned", "own"].includes(root.accessScope))
  )
    throw new TypeError();
  return {
    ...(enriched ? { accessScope: root.accessScope as "assigned" | "own" } : {}),
    currentVersion: {
      assignedApproverWorkerProfileId: nullableUuid(current.assignedApproverWorkerProfileId),
      currencyCode: currency(current.currencyCode),
      expenseClaimVersionId: string(current.expenseClaimVersionId, uuidExpression),
      lines: current.lines.map(parseLine),
      rowVersion: positive(current.rowVersion),
      status: status(current.status),
      submittedAt: nullableTimestamp(current.submittedAt),
      supersedesVersionId: nullableUuid(current.supersedesVersionId),
      totalAmountMinor: boundedAmount(current.totalAmountMinor, true),
      version: positive(current.version),
    },
    expenseClaimId: string(root.expenseClaimId, uuidExpression),
    ...(enriched ? { history: parseHistory(root.history) } : {}),
    rootVersion: positive(root.rootVersion),
    workerProfileId: string(root.workerProfileId, uuidExpression),
  };
}

function parseListItem(value: unknown): HrExpenseClaimListItem {
  const item = record(value);
  exact(item, [
    "createdAt",
    "currencyCode",
    "expenseClaimId",
    "expenseClaimVersionId",
    "rootVersion",
    "status",
    "submittedAt",
    "totalAmountMinor",
    "version",
    "workerProfileId",
    "workItemId",
  ]);
  return {
    createdAt: canonicalTimestamp(item.createdAt),
    currencyCode: currency(item.currencyCode),
    expenseClaimId: string(item.expenseClaimId, uuidExpression),
    expenseClaimVersionId: string(item.expenseClaimVersionId, uuidExpression),
    rootVersion: positive(item.rootVersion),
    status: status(item.status),
    submittedAt: nullableTimestamp(item.submittedAt),
    totalAmountMinor: boundedAmount(item.totalAmountMinor, true),
    version: positive(item.version),
    workerProfileId: string(item.workerProfileId, uuidExpression),
    workItemId: nullableUuid(item.workItemId),
  };
}

export function parseHrExpenseClaimListResponse(value: unknown): HrExpenseClaimListResponse {
  const page = record(value);
  exact(page, ["items", "kind", "nextCursor"]);
  if (!Array.isArray(page.items) || page.items.length > 50) throw new TypeError();
  const items = page.items.map(parseListItem);
  if (page.kind === "own") {
    let nextCursor: HrExpenseClaimOwnCursor | null = null;
    if (page.nextCursor !== null) {
      const cursor = record(page.nextCursor);
      exact(cursor, ["createdAt", "expenseClaimId"]);
      nextCursor = {
        createdAt: canonicalTimestamp(cursor.createdAt),
        expenseClaimId: string(cursor.expenseClaimId, uuidExpression),
      };
    }
    if (items.some((item) => item.workItemId !== null)) throw new TypeError();
    return { items, kind: "own", nextCursor };
  }
  if (page.kind !== "assigned") throw new TypeError();
  let nextCursor: HrExpenseClaimAssignedCursor | null = null;
  if (page.nextCursor !== null) {
    const cursor = record(page.nextCursor);
    exact(cursor, ["expenseClaimVersionId", "submittedAt"]);
    nextCursor = {
      expenseClaimVersionId: string(cursor.expenseClaimVersionId, uuidExpression),
      submittedAt: canonicalTimestamp(cursor.submittedAt),
    };
  }
  if (
    items.some(
      (item) =>
        item.workItemId === null || item.status !== "submitted" || item.submittedAt === null,
    )
  )
    throw new TypeError();
  return { items, kind: "assigned", nextCursor };
}
