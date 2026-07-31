export const NOTIFICATION_BILLING_STATE = "non_billable" as const;
export const NOTIFICATION_MAXIMUM_PAGE_SIZE = 50;
export const NOTIFICATION_DEFAULT_PAGE_SIZE = 20;
export const NOTIFICATION_MARK_ALL_BATCH_SIZE = 100;

export const NOTIFICATION_POLICY_V1 = Object.freeze({
  backoffCapSeconds: 900,
  batchSize: 100,
  consumerKey: "platform.notifications.projector",
  consumerVersion: 1,
  idlePollMs: 1_000,
  maximumAttempts: 8,
  projectionRetentionDays: 90,
  shutdownJoinMs: 10_000,
});

export const platformNotificationTargetKinds = [
  "hr.attendance.detail",
  "hr.employment_record.detail",
  "hr.expense_claim.detail",
  "hr.leave_request.detail",
  "hr.shift_assignment.detail",
  "hr.shift_assignment.own_shifts",
  "hr.timesheet.detail",
  "hr.workforce_profile.detail",
  "hr.workforce_profile.direct_reports",
] as const;

export type PlatformNotificationTargetKind = (typeof platformNotificationTargetKinds)[number];

const platformNotificationResourceFreeTargetKinds = [
  "hr.shift_assignment.own_shifts",
  "hr.workforce_profile.direct_reports",
] as const satisfies readonly PlatformNotificationTargetKind[];

export interface PlatformNotificationAvailableTarget {
  readonly available: true;
  readonly href: string;
  readonly kind: PlatformNotificationTargetKind;
  readonly resourceId: string | null;
}

export interface PlatformNotificationUnavailableTarget {
  readonly available: false;
  readonly href: null;
  readonly kind: null;
  readonly resourceId: null;
}

export type PlatformNotificationTarget =
  | PlatformNotificationAvailableTarget
  | PlatformNotificationUnavailableTarget;

export interface PlatformNotification {
  readonly category: string;
  readonly createdAt: string;
  readonly notificationId: string;
  readonly occurredAt: string;
  readonly readAt: string | null;
  readonly retentionStatus: "active";
  readonly rowVersion: number;
  readonly sourceService: string;
  readonly summary: string;
  readonly target: PlatformNotificationTarget;
  readonly title: string;
}

export interface PlatformNotificationCursor {
  readonly notificationId: string;
  readonly occurredAt: string;
}

export interface PlatformNotificationPage {
  readonly items: readonly PlatformNotification[];
  readonly nextCursor: PlatformNotificationCursor | null;
  readonly unreadCount: number;
}

export interface PlatformNotificationListQuery {
  readonly cursorNotificationId?: string;
  readonly cursorOccurredAt?: string;
  readonly pageSize?: number;
}

export interface MarkOwnNotificationReadBody {
  readonly expectedVersion: number;
}

export interface PlatformNotificationPath {
  readonly notificationId: string;
}

export interface MarkOwnNotificationReadResponse {
  readonly billingState: typeof NOTIFICATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly notification: PlatformNotification;
  readonly replayed: boolean;
}

export interface MarkAllOwnNotificationsReadBody {
  readonly beforeOccurredAt: string;
  readonly expectedUnreadCount: number;
}

export interface MarkAllOwnNotificationsReadResponse {
  readonly billingState: typeof NOTIFICATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly remainingUnreadCount: number;
  readonly replayed: boolean;
  readonly updatedCount: number;
}

const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const uuidExpression = new RegExp(uuidPattern);
const dateTimeExpression = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const internalHrefExpression = /^\/(?!\/)[^\s?#]*(?:\?[^#\s]*)?$/;
const boundedKeyExpression = /^[a-z][a-z0-9_.-]{0,127}$/;
const maximumVersion = 2_147_483_647;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function isNonNegativeInteger(value: unknown, maximum = maximumVersion): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function isPositiveVersion(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    dateTimeExpression.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseTarget(value: unknown): PlatformNotificationTarget {
  if (!exactRecord(value, ["available", "href", "kind", "resourceId"])) {
    throw new Error("Invalid platform notification target");
  }
  if (value.available === false) {
    if (value.href !== null || value.kind !== null || value.resourceId !== null) {
      throw new Error("Invalid platform notification target");
    }
    return { available: false, href: null, kind: null, resourceId: null };
  }
  if (
    value.available !== true ||
    typeof value.href !== "string" ||
    !internalHrefExpression.test(value.href) ||
    typeof value.kind !== "string" ||
    !platformNotificationTargetKinds.includes(value.kind as PlatformNotificationTargetKind) ||
    (value.resourceId !== null &&
      (typeof value.resourceId !== "string" || !uuidExpression.test(value.resourceId)))
  ) {
    throw new Error("Invalid platform notification target");
  }
  const resourceFree = platformNotificationResourceFreeTargetKinds.includes(
    value.kind as (typeof platformNotificationResourceFreeTargetKinds)[number],
  );
  if (resourceFree && value.resourceId !== null) {
    throw new Error("Invalid platform notification target");
  }
  if (!resourceFree && value.resourceId === null) {
    throw new Error("Invalid platform notification target");
  }
  return {
    available: true,
    href: value.href,
    kind: value.kind as PlatformNotificationTargetKind,
    resourceId: value.resourceId,
  };
}

export function parsePlatformNotification(value: unknown): PlatformNotification {
  if (
    !exactRecord(value, [
      "category",
      "createdAt",
      "notificationId",
      "occurredAt",
      "readAt",
      "retentionStatus",
      "rowVersion",
      "sourceService",
      "summary",
      "target",
      "title",
    ]) ||
    typeof value.category !== "string" ||
    !boundedKeyExpression.test(value.category) ||
    !isDateTime(value.createdAt) ||
    typeof value.notificationId !== "string" ||
    !uuidExpression.test(value.notificationId) ||
    !isDateTime(value.occurredAt) ||
    (value.readAt !== null && !isDateTime(value.readAt)) ||
    value.retentionStatus !== "active" ||
    !isPositiveVersion(value.rowVersion) ||
    typeof value.sourceService !== "string" ||
    !boundedKeyExpression.test(value.sourceService) ||
    typeof value.summary !== "string" ||
    value.summary.length < 1 ||
    value.summary.length > 240 ||
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > 160
  ) {
    throw new Error("Invalid platform notification");
  }
  return {
    category: value.category,
    createdAt: value.createdAt,
    notificationId: value.notificationId,
    occurredAt: value.occurredAt,
    readAt: value.readAt,
    retentionStatus: "active",
    rowVersion: value.rowVersion,
    sourceService: value.sourceService,
    summary: value.summary,
    target: parseTarget(value.target),
    title: value.title,
  };
}

export function parseNotificationListQuery(value: unknown): PlatformNotificationListQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid platform notification list query");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const allowed = new Set(["cursorNotificationId", "cursorOccurredAt", "pageSize"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Invalid platform notification list query");
  }
  const hasId = Object.hasOwn(record, "cursorNotificationId");
  const hasTime = Object.hasOwn(record, "cursorOccurredAt");
  if (
    hasId !== hasTime ||
    (hasId &&
      (typeof record.cursorNotificationId !== "string" ||
        !uuidExpression.test(record.cursorNotificationId) ||
        !isDateTime(record.cursorOccurredAt))) ||
    (Object.hasOwn(record, "pageSize") &&
      (!isNonNegativeInteger(record.pageSize, NOTIFICATION_MAXIMUM_PAGE_SIZE) ||
        record.pageSize < 1))
  ) {
    throw new Error("Invalid platform notification list query");
  }
  return {
    ...(hasId
      ? {
          cursorNotificationId: record.cursorNotificationId as string,
          cursorOccurredAt: record.cursorOccurredAt as string,
        }
      : {}),
    ...(Object.hasOwn(record, "pageSize") ? { pageSize: record.pageSize as number } : {}),
  };
}

export function parseNotificationPage(value: unknown): PlatformNotificationPage {
  if (
    !exactRecord(value, ["items", "nextCursor", "unreadCount"]) ||
    !Array.isArray(value.items) ||
    value.items.length > NOTIFICATION_MAXIMUM_PAGE_SIZE ||
    !isNonNegativeInteger(value.unreadCount)
  ) {
    throw new Error("Invalid platform notification page");
  }
  const items = value.items.map(parsePlatformNotification);
  let nextCursor: PlatformNotificationCursor | null = null;
  if (value.nextCursor !== null) {
    if (
      !exactRecord(value.nextCursor, ["notificationId", "occurredAt"]) ||
      typeof value.nextCursor.notificationId !== "string" ||
      !uuidExpression.test(value.nextCursor.notificationId) ||
      !isDateTime(value.nextCursor.occurredAt)
    ) {
      throw new Error("Invalid platform notification page");
    }
    nextCursor = {
      notificationId: value.nextCursor.notificationId,
      occurredAt: value.nextCursor.occurredAt,
    };
  }
  return { items, nextCursor, unreadCount: value.unreadCount };
}

export function parseMarkOwnNotificationReadBody(value: unknown): MarkOwnNotificationReadBody {
  if (!exactRecord(value, ["expectedVersion"]) || !isPositiveVersion(value.expectedVersion)) {
    throw new Error("Invalid platform notification mark-read command");
  }
  return { expectedVersion: value.expectedVersion };
}

export function parsePlatformNotificationPath(value: unknown): PlatformNotificationPath {
  if (
    !exactRecord(value, ["notificationId"]) ||
    typeof value.notificationId !== "string" ||
    !uuidExpression.test(value.notificationId)
  ) {
    throw new Error("Invalid platform notification path");
  }
  return { notificationId: value.notificationId };
}

export function parseMarkOwnNotificationReadResponse(
  value: unknown,
): MarkOwnNotificationReadResponse {
  if (
    !exactRecord(value, ["billingState", "evidenceEventId", "notification", "replayed"]) ||
    value.billingState !== NOTIFICATION_BILLING_STATE ||
    typeof value.evidenceEventId !== "string" ||
    !uuidExpression.test(value.evidenceEventId) ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("Invalid platform notification mark-read response");
  }
  return {
    billingState: NOTIFICATION_BILLING_STATE,
    evidenceEventId: value.evidenceEventId,
    notification: parsePlatformNotification(value.notification),
    replayed: value.replayed,
  };
}

export function parseMarkAllOwnNotificationsReadBody(
  value: unknown,
): MarkAllOwnNotificationsReadBody {
  if (
    !exactRecord(value, ["beforeOccurredAt", "expectedUnreadCount"]) ||
    !isDateTime(value.beforeOccurredAt) ||
    !isNonNegativeInteger(value.expectedUnreadCount)
  ) {
    throw new Error("Invalid platform notification mark-all command");
  }
  return {
    beforeOccurredAt: value.beforeOccurredAt,
    expectedUnreadCount: value.expectedUnreadCount,
  };
}

export function parseMarkAllOwnNotificationsReadResponse(
  value: unknown,
): MarkAllOwnNotificationsReadResponse {
  if (
    !exactRecord(value, [
      "billingState",
      "evidenceEventId",
      "remainingUnreadCount",
      "replayed",
      "updatedCount",
    ]) ||
    value.billingState !== NOTIFICATION_BILLING_STATE ||
    typeof value.evidenceEventId !== "string" ||
    !uuidExpression.test(value.evidenceEventId) ||
    !isNonNegativeInteger(value.remainingUnreadCount) ||
    typeof value.replayed !== "boolean" ||
    !isNonNegativeInteger(value.updatedCount, NOTIFICATION_MARK_ALL_BATCH_SIZE)
  ) {
    throw new Error("Invalid platform notification mark-all response");
  }
  return {
    billingState: NOTIFICATION_BILLING_STATE,
    evidenceEventId: value.evidenceEventId,
    remainingUnreadCount: value.remainingUnreadCount,
    replayed: value.replayed,
    updatedCount: value.updatedCount,
  };
}

const dateTimeSchema = { format: "date-time", type: "string" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;
const unavailableTargetSchema = {
  additionalProperties: false,
  properties: {
    available: { const: false },
    href: { type: "null" },
    kind: { type: "null" },
    resourceId: { type: "null" },
  },
  required: ["available", "href", "kind", "resourceId"],
  type: "object",
} as const;
const availableTargetSchema = {
  additionalProperties: false,
  properties: {
    available: { const: true },
    href: { pattern: internalHrefExpression.source, type: "string" },
    kind: { enum: platformNotificationTargetKinds },
    resourceId: {
      anyOf: [{ pattern: uuidPattern, type: "string" }, { type: "null" }],
    },
  },
  required: ["available", "href", "kind", "resourceId"],
  type: "object",
} as const;

export const platformNotificationListQuerySchema = {
  $id: "PlatformNotificationListQueryV1",
  additionalProperties: false,
  dependencies: {
    cursorNotificationId: ["cursorOccurredAt"],
    cursorOccurredAt: ["cursorNotificationId"],
  },
  properties: {
    cursorNotificationId: { pattern: uuidPattern, type: "string" },
    cursorOccurredAt: dateTimeSchema,
    pageSize: {
      default: NOTIFICATION_DEFAULT_PAGE_SIZE,
      maximum: NOTIFICATION_MAXIMUM_PAGE_SIZE,
      minimum: 1,
      type: "integer",
    },
  },
  type: "object",
} as const;

const platformNotificationSchema = {
  additionalProperties: false,
  properties: {
    category: { maxLength: 128, minLength: 1, type: "string" },
    createdAt: dateTimeSchema,
    notificationId: { pattern: uuidPattern, type: "string" },
    occurredAt: dateTimeSchema,
    readAt: nullableDateTimeSchema,
    retentionStatus: { const: "active" },
    rowVersion: { minimum: 1, type: "integer" },
    sourceService: { maxLength: 128, minLength: 1, type: "string" },
    summary: { maxLength: 240, minLength: 1, type: "string" },
    target: { anyOf: [availableTargetSchema, unavailableTargetSchema] },
    title: { maxLength: 160, minLength: 1, type: "string" },
  },
  required: [
    "category",
    "createdAt",
    "notificationId",
    "occurredAt",
    "readAt",
    "retentionStatus",
    "rowVersion",
    "sourceService",
    "summary",
    "target",
    "title",
  ],
  type: "object",
} as const;

export const platformNotificationPageSchema = {
  $id: "PlatformNotificationPageV1",
  additionalProperties: false,
  properties: {
    items: {
      items: platformNotificationSchema,
      maxItems: NOTIFICATION_MAXIMUM_PAGE_SIZE,
      type: "array",
    },
    nextCursor: {
      anyOf: [
        {
          additionalProperties: false,
          properties: {
            notificationId: { pattern: uuidPattern, type: "string" },
            occurredAt: dateTimeSchema,
          },
          required: ["notificationId", "occurredAt"],
          type: "object",
        },
        { type: "null" },
      ],
    },
    unreadCount: { minimum: 0, type: "integer" },
  },
  required: ["items", "nextCursor", "unreadCount"],
  type: "object",
} as const;

export const platformNotificationMarkReadBodySchema = {
  $id: "PlatformNotificationMarkReadBodyV1",
  additionalProperties: false,
  properties: { expectedVersion: { minimum: 1, type: "integer" } },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const platformNotificationPathSchema = {
  $id: "PlatformNotificationPathV1",
  additionalProperties: false,
  properties: {
    notificationId: { pattern: uuidPattern, type: "string" },
  },
  required: ["notificationId"],
  type: "object",
} as const;

export const platformNotificationMarkReadResponseSchema = {
  $id: "PlatformNotificationMarkReadResponseV1",
  additionalProperties: false,
  properties: {
    billingState: { const: NOTIFICATION_BILLING_STATE },
    evidenceEventId: { pattern: uuidPattern, type: "string" },
    notification: platformNotificationSchema,
    replayed: { type: "boolean" },
  },
  required: ["billingState", "evidenceEventId", "notification", "replayed"],
  type: "object",
} as const;

export const platformNotificationMarkAllReadBodySchema = {
  $id: "PlatformNotificationMarkAllReadBodyV1",
  additionalProperties: false,
  properties: {
    beforeOccurredAt: dateTimeSchema,
    expectedUnreadCount: { minimum: 0, type: "integer" },
  },
  required: ["beforeOccurredAt", "expectedUnreadCount"],
  type: "object",
} as const;

export const platformNotificationMarkAllReadResponseSchema = {
  $id: "PlatformNotificationMarkAllReadResponseV1",
  additionalProperties: false,
  properties: {
    billingState: { const: NOTIFICATION_BILLING_STATE },
    evidenceEventId: { pattern: uuidPattern, type: "string" },
    remainingUnreadCount: { minimum: 0, type: "integer" },
    replayed: { type: "boolean" },
    updatedCount: { maximum: NOTIFICATION_MARK_ALL_BATCH_SIZE, minimum: 0, type: "integer" },
  },
  required: ["billingState", "evidenceEventId", "remainingUnreadCount", "replayed", "updatedCount"],
  type: "object",
} as const;
