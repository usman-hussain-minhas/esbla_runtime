import {
  type MarkAllOwnNotificationsReadBody,
  type MarkAllOwnNotificationsReadResponse,
  type MarkOwnNotificationReadBody,
  type MarkOwnNotificationReadResponse,
  NOTIFICATION_BILLING_STATE,
  NOTIFICATION_DEFAULT_PAGE_SIZE,
  NOTIFICATION_MARK_ALL_BATCH_SIZE,
  NOTIFICATION_MAXIMUM_PAGE_SIZE,
  NOTIFICATION_POLICY_V1,
  type PlatformNotification,
  type PlatformNotificationListQuery,
  type PlatformNotificationPage,
  type PlatformNotificationTargetKind,
  platformNotificationTargetKinds,
} from "@esbla/contracts";
import type { Pool, PoolClient } from "pg";
import { type OperationContext, type TenantTransaction, withTenantTransaction } from "./context.js";
import { PlatformError } from "./errors.js";
import { appendEvidence, deriveStableUuid } from "./proof.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOUNDED_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const INTENT_REDACTION = JSON.stringify({ redacted: true });

export interface NotificationIntentInput {
  readonly category: string;
  readonly recipientPrincipalId: string;
  readonly safeSummary: string;
  readonly sourceEventId: string;
  readonly sourceServiceKey: string;
  readonly targetKind: PlatformNotificationTargetKind;
  readonly targetResourceId: string | null;
  readonly title: string;
}

export interface NotificationTargetVerificationInput {
  readonly recipientPrincipalId: string;
  readonly referenceId: string;
  readonly targetKind: PlatformNotificationTargetKind;
  readonly targetResourceId: string | null;
}

export interface NotificationTargetVerificationResult {
  readonly outcome: "allowed" | "denied" | "missing";
  readonly referenceId: string;
}

export type NotificationTargetVerifier = (
  client: PoolClient,
  tenantId: string,
  targets: readonly NotificationTargetVerificationInput[],
) => Promise<readonly NotificationTargetVerificationResult[]>;

interface RegisteredNotificationTarget {
  readonly href: (resourceId: string | null) => string;
  readonly readCapabilityId: string;
  readonly resourceRequired: boolean;
  readonly serviceKey: string;
}

const TARGETS = Object.freeze({
  "hr.attendance.detail": {
    href: (resourceId) => `/workspace/hr/attendance/by-id/${resourceId}`,
    readCapabilityId: "hr.attendance.view_detail",
    resourceRequired: true,
    serviceKey: "attendance",
  },
  "hr.employment_record.detail": {
    href: (resourceId) => `/workspace/hr/employment/by-id/${resourceId}`,
    readCapabilityId: "hr.employment.view_detail",
    resourceRequired: true,
    serviceKey: "employment_record",
  },
  "hr.expense_claim.detail": {
    href: (resourceId) => `/workspace/hr/expenses/by-id/${resourceId}`,
    readCapabilityId: "hr.expense.view_detail",
    resourceRequired: true,
    serviceKey: "expense_claim_boundary",
  },
  "hr.leave_request.detail": {
    href: (resourceId) => `/workspace/hr/leave/${resourceId}`,
    readCapabilityId: "hr.leave.view",
    resourceRequired: true,
    serviceKey: "hr.leave_request",
  },
  "hr.shift_assignment.detail": {
    href: (resourceId) => `/workspace/hr/shifts/by-id/${resourceId}`,
    readCapabilityId: "hr.shift.view_detail",
    resourceRequired: true,
    serviceKey: "shift_assignment",
  },
  "hr.shift_assignment.own_shifts": {
    href: () => "/workspace/hr/shifts",
    readCapabilityId: "hr.shift.list_roster",
    resourceRequired: false,
    serviceKey: "shift_assignment",
  },
  "hr.timesheet.detail": {
    href: (resourceId) => `/workspace/hr/timesheets/by-id/${resourceId}`,
    readCapabilityId: "hr.timesheet.view_detail",
    resourceRequired: true,
    serviceKey: "timesheet",
  },
  "hr.workforce_profile.detail": {
    href: (resourceId) => `/workspace/hr/profile/by-id/${resourceId}`,
    readCapabilityId: "hr.workforce.view_authorized_detail",
    resourceRequired: true,
    serviceKey: "workforce_profile",
  },
  "hr.workforce_profile.direct_reports": {
    href: () => "/workspace/hr/profile/direct-reports",
    readCapabilityId: "hr.workforce.list_authorized",
    resourceRequired: false,
    serviceKey: "workforce_profile",
  },
}) satisfies Readonly<Record<PlatformNotificationTargetKind, RegisteredNotificationTarget>>;

interface IntentPayload {
  readonly category: string;
  readonly safeSummary: string;
  readonly targetHref: string;
  readonly targetKind: PlatformNotificationTargetKind;
  readonly targetReadCapabilityId: string;
  readonly targetResourceId: string | null;
  readonly title: string;
}

interface ClaimedIntent {
  readonly attempt_count: number;
  readonly intent_id: string;
  readonly intent_payload: unknown;
  readonly occurred_at: Date;
  readonly recipient_principal_id: string;
  readonly source_event_id: string;
  readonly source_service_key: string;
  readonly tenant_id: string;
}

interface ProjectionRow {
  readonly category: string;
  readonly created_at: Date;
  readonly notification_id: string;
  readonly occurred_at: Date;
  readonly read_at: Date | null;
  readonly recipient_principal_id: string;
  readonly retention_status: "active";
  readonly row_version: number;
  readonly safe_summary: string;
  readonly source_service_key: string;
  readonly target_href: string;
  readonly target_kind: PlatformNotificationTargetKind;
  readonly target_resource_id: string | null;
  readonly title: string;
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", `${field} must be a UUID`);
  }
}

function assertBoundedKey(value: string, field: string): void {
  if (!BOUNDED_KEY_PATTERN.test(value)) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", `${field} is not registered`);
  }
}

function assertBoundedCopy(value: string, maximum: number, field: string): void {
  if (value.trim() !== value || value.length < 1 || value.length > maximum) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", `${field} is invalid`);
  }
}

function targetDefinition(
  targetKind: PlatformNotificationTargetKind,
  resourceId: string | null,
): RegisteredNotificationTarget & { readonly hrefValue: string } {
  if (!platformNotificationTargetKinds.includes(targetKind)) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", "Notification target is not registered");
  }
  const definition = TARGETS[targetKind];
  if (
    (definition.resourceRequired && (resourceId === null || !UUID_PATTERN.test(resourceId))) ||
    (!definition.resourceRequired && resourceId !== null)
  ) {
    throw new PlatformError(
      "NOTIFICATION_INPUT_INVALID",
      "Notification target identity is invalid",
    );
  }
  return { ...definition, hrefValue: definition.href(resourceId) };
}

function intentPayload(input: NotificationIntentInput): IntentPayload {
  assertUuid(input.sourceEventId, "sourceEventId");
  assertUuid(input.recipientPrincipalId, "recipientPrincipalId");
  assertBoundedKey(input.sourceServiceKey, "sourceServiceKey");
  assertBoundedKey(input.category, "category");
  assertBoundedCopy(input.title, 160, "title");
  assertBoundedCopy(input.safeSummary, 240, "safeSummary");
  const target = targetDefinition(input.targetKind, input.targetResourceId);
  if (target.serviceKey !== input.sourceServiceKey) {
    throw new PlatformError(
      "NOTIFICATION_INPUT_INVALID",
      "Notification source and target service do not match",
    );
  }
  return {
    category: input.category,
    safeSummary: input.safeSummary,
    targetHref: target.hrefValue,
    targetKind: input.targetKind,
    targetReadCapabilityId: target.readCapabilityId,
    targetResourceId: input.targetResourceId,
    title: input.title,
  };
}

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

function parseIntentPayload(value: unknown): IntentPayload {
  if (
    !exactRecord(value, [
      "category",
      "safeSummary",
      "targetHref",
      "targetKind",
      "targetReadCapabilityId",
      "targetResourceId",
      "title",
    ]) ||
    typeof value.category !== "string" ||
    !BOUNDED_KEY_PATTERN.test(value.category) ||
    typeof value.safeSummary !== "string" ||
    value.safeSummary.trim() !== value.safeSummary ||
    value.safeSummary.length < 1 ||
    value.safeSummary.length > 240 ||
    typeof value.targetHref !== "string" ||
    typeof value.targetKind !== "string" ||
    !platformNotificationTargetKinds.includes(value.targetKind as PlatformNotificationTargetKind) ||
    (value.targetResourceId !== null &&
      (typeof value.targetResourceId !== "string" || !UUID_PATTERN.test(value.targetResourceId))) ||
    typeof value.targetReadCapabilityId !== "string" ||
    !BOUNDED_KEY_PATTERN.test(value.targetReadCapabilityId) ||
    typeof value.title !== "string" ||
    value.title.trim() !== value.title ||
    value.title.length < 1 ||
    value.title.length > 160
  ) {
    throw new Error("INVALID_INTENT_PAYLOAD");
  }
  const targetKind = value.targetKind as PlatformNotificationTargetKind;
  const definition = targetDefinition(targetKind, value.targetResourceId as string | null);
  if (
    definition.hrefValue !== value.targetHref ||
    definition.readCapabilityId !== value.targetReadCapabilityId
  ) {
    throw new Error("INVALID_INTENT_PAYLOAD");
  }
  return {
    category: value.category,
    safeSummary: value.safeSummary,
    targetHref: value.targetHref,
    targetKind,
    targetReadCapabilityId: value.targetReadCapabilityId,
    targetResourceId: value.targetResourceId as string | null,
    title: value.title,
  };
}

export async function appendNotificationIntent(
  transaction: TenantTransaction,
  input: NotificationIntentInput,
): Promise<{ readonly intentId: string; readonly replayed: boolean }> {
  const payload = intentPayload(input);
  const source = await transaction.client.query<{
    occurred_at: Date;
    tenant_id: string;
  }>(
    `SELECT tenant_id,occurred_at
     FROM outbox_events
     WHERE tenant_id=$1 AND event_id=$2`,
    [transaction.context.tenantId, input.sourceEventId],
  );
  const sourceRow = source.rows[0];
  if (!sourceRow || sourceRow.tenant_id !== transaction.context.tenantId) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", "Notification source event is invalid");
  }
  const intentId = deriveStableUuid(
    "platform.notification.intent.v1",
    transaction.context.tenantId,
    input.sourceEventId,
    input.recipientPrincipalId,
  );
  const inserted = await transaction.client.query<{ intent_id: string }>(
    `INSERT INTO notification_intents
       (intent_id,tenant_id,source_event_id,recipient_principal_id,
        source_service_key,intent_payload,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (tenant_id,source_event_id,recipient_principal_id) DO NOTHING
     RETURNING intent_id`,
    [
      intentId,
      transaction.context.tenantId,
      input.sourceEventId,
      input.recipientPrincipalId,
      input.sourceServiceKey,
      JSON.stringify(payload),
      sourceRow.occurred_at,
    ],
  );
  if (inserted.rows[0]) return { intentId, replayed: false };
  const existing = await transaction.client.query<{
    intent_id: string;
    intent_payload: unknown;
    occurred_at: Date;
    source_service_key: string;
  }>(
    `SELECT intent_id,intent_payload,occurred_at,source_service_key
     FROM notification_intents
     WHERE tenant_id=$1 AND source_event_id=$2 AND recipient_principal_id=$3`,
    [transaction.context.tenantId, input.sourceEventId, input.recipientPrincipalId],
  );
  const row = existing.rows[0];
  let existingPayload: IntentPayload | undefined;
  try {
    existingPayload = row ? parseIntentPayload(row.intent_payload) : undefined;
  } catch {
    existingPayload = undefined;
  }
  if (
    !row ||
    row.intent_id !== intentId ||
    row.source_service_key !== input.sourceServiceKey ||
    row.occurred_at.getTime() !== sourceRow.occurred_at.getTime() ||
    JSON.stringify(existingPayload) !== JSON.stringify(payload)
  ) {
    throw new PlatformError(
      "IDEMPOTENCY_CONFLICT",
      "Notification intent retry changed its semantics",
    );
  }
  return { intentId, replayed: true };
}

async function requireCurrentCapability(
  transaction: TenantTransaction,
  capabilityId: string,
): Promise<void> {
  const result = await transaction.client.query<{ capability_current: boolean }>(
    `SELECT public.esbla_lock_membership_capability($1,$2,$3) AS capability_current`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityId],
  );
  if (result.rows[0]?.capability_current !== true) {
    throw new PlatformError("POLICY_DENIED", "Notification capability is not current");
  }
}

async function lockOwnNotificationReadState(transaction: TenantTransaction): Promise<void> {
  await transaction.client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('platform.notifications.read-state:' || $1 || ':' || $2, 0)
     )`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId],
  );
}

function iso(value: Date): string {
  return value.toISOString();
}

function projectionToNotification(
  row: ProjectionRow,
  targetOutcome: "allowed" | "denied" | "missing",
): PlatformNotification {
  return {
    category: row.category,
    createdAt: iso(row.created_at),
    notificationId: row.notification_id,
    occurredAt: iso(row.occurred_at),
    readAt: row.read_at ? iso(row.read_at) : null,
    retentionStatus: row.retention_status,
    rowVersion: row.row_version,
    sourceService: row.source_service_key,
    summary: row.safe_summary,
    target:
      targetOutcome === "allowed"
        ? {
            available: true,
            href: row.target_href,
            kind: row.target_kind,
            resourceId: row.target_resource_id,
          }
        : { available: false, href: null, kind: null, resourceId: null },
    title: row.title,
  };
}

function verifyTargetResults(
  inputs: readonly NotificationTargetVerificationInput[],
  results: readonly NotificationTargetVerificationResult[],
): ReadonlyMap<string, "allowed" | "denied" | "missing"> {
  const expected = new Set(inputs.map(({ referenceId }) => referenceId));
  const output = new Map<string, "allowed" | "denied" | "missing">();
  for (const result of results) {
    if (
      !expected.has(result.referenceId) ||
      output.has(result.referenceId) ||
      !["allowed", "denied", "missing"].includes(result.outcome)
    ) {
      throw new Error("INVALID_TARGET_VERIFIER_RESULT");
    }
    output.set(result.referenceId, result.outcome);
  }
  if (output.size !== expected.size) throw new Error("INVALID_TARGET_VERIFIER_RESULT");
  return output;
}

async function verifyProjectionRows(
  client: PoolClient,
  tenantId: string,
  rows: readonly ProjectionRow[],
  verifyTargets: NotificationTargetVerifier,
): Promise<ReadonlyMap<string, "allowed" | "denied" | "missing">> {
  const inputs = rows.map(
    (row): NotificationTargetVerificationInput => ({
      recipientPrincipalId: row.recipient_principal_id,
      referenceId: row.notification_id,
      targetKind: row.target_kind,
      targetResourceId: row.target_resource_id,
    }),
  );
  return verifyTargetResults(inputs, await verifyTargets(client, tenantId, inputs));
}

export async function listOwnNotifications(
  pool: Pool,
  context: OperationContext,
  query: PlatformNotificationListQuery,
  verifyTargets: NotificationTargetVerifier,
): Promise<PlatformNotificationPage> {
  const pageSize = query.pageSize ?? NOTIFICATION_DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > NOTIFICATION_MAXIMUM_PAGE_SIZE ||
    Boolean(query.cursorNotificationId) !== Boolean(query.cursorOccurredAt) ||
    (query.cursorNotificationId !== undefined &&
      (!UUID_PATTERN.test(query.cursorNotificationId) ||
        !Number.isFinite(Date.parse(query.cursorOccurredAt ?? ""))))
  ) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", "Notification cursor is invalid");
  }
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireCurrentCapability(transaction, "platform.notifications.list_own");
    const result = await transaction.client.query<ProjectionRow>(
      `SELECT projection.notification_id,projection.source_service_key,
              projection.recipient_principal_id,projection.category,projection.title,projection.safe_summary,
              projection.target_kind,projection.target_resource_id,projection.target_href,
              projection.occurred_at,projection.created_at,projection.read_at,
              projection.retention_status,projection.row_version
       FROM notification_projections projection
       JOIN service_activations activation
         ON activation.tenant_id=projection.tenant_id
        AND activation.service_key=projection.source_service_key
        AND activation.state='active'
       JOIN membership_capabilities target_capability
         ON target_capability.tenant_id=projection.tenant_id
        AND target_capability.principal_id=projection.recipient_principal_id
        AND target_capability.capability_id=projection.target_read_capability_id
       WHERE projection.tenant_id=$1
         AND projection.recipient_principal_id=$2
         AND projection.retention_status='active'
         AND projection.occurred_at >= clock_timestamp() - interval '90 days'
         AND (
           $3::timestamptz IS NULL
           OR (projection.occurred_at,projection.notification_id) < ($3,$4::uuid)
         )
       ORDER BY projection.occurred_at DESC,projection.notification_id DESC
       LIMIT $5`,
      [
        context.tenantId,
        context.actorPrincipalId,
        query.cursorOccurredAt ?? null,
        query.cursorNotificationId ?? null,
        pageSize + 1,
      ],
    );
    const pageRows = result.rows.slice(0, pageSize);
    const targets = await verifyProjectionRows(
      transaction.client,
      context.tenantId,
      pageRows,
      verifyTargets,
    );
    const unread = await transaction.client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM notification_projections projection
       JOIN service_activations activation
         ON activation.tenant_id=projection.tenant_id
        AND activation.service_key=projection.source_service_key
        AND activation.state='active'
       JOIN membership_capabilities target_capability
         ON target_capability.tenant_id=projection.tenant_id
        AND target_capability.principal_id=projection.recipient_principal_id
        AND target_capability.capability_id=projection.target_read_capability_id
       WHERE projection.tenant_id=$1
         AND projection.recipient_principal_id=$2
         AND projection.retention_status='active'
         AND projection.read_at IS NULL
         AND projection.occurred_at >= clock_timestamp() - interval '90 days'`,
      [context.tenantId, context.actorPrincipalId],
    );
    const last = result.rows.length > pageSize ? pageRows.at(-1) : undefined;
    return {
      items: pageRows.map((row) =>
        projectionToNotification(row, targets.get(row.notification_id) ?? "missing"),
      ),
      nextCursor: last
        ? { notificationId: last.notification_id, occurredAt: iso(last.occurred_at) }
        : null,
      unreadCount: unread.rows[0]?.count ?? 0,
    };
  });
}

async function selectOwnVisibleProjectionForUpdate(
  transaction: TenantTransaction,
  notificationId: string,
): Promise<ProjectionRow> {
  const result = await transaction.client.query<ProjectionRow>(
    `SELECT projection.notification_id,projection.source_service_key,
            projection.recipient_principal_id,projection.category,projection.title,projection.safe_summary,
            projection.target_kind,projection.target_resource_id,projection.target_href,
            projection.occurred_at,projection.created_at,projection.read_at,
            projection.retention_status,projection.row_version
     FROM notification_projections projection
     JOIN service_activations activation
       ON activation.tenant_id=projection.tenant_id
      AND activation.service_key=projection.source_service_key
      AND activation.state='active'
     JOIN membership_capabilities target_capability
       ON target_capability.tenant_id=projection.tenant_id
      AND target_capability.principal_id=projection.recipient_principal_id
      AND target_capability.capability_id=projection.target_read_capability_id
     WHERE projection.tenant_id=$1
       AND projection.recipient_principal_id=$2
       AND projection.notification_id=$3
       AND projection.retention_status='active'
       AND projection.occurred_at >= clock_timestamp() - interval '90 days'
     FOR UPDATE OF projection`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, notificationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new PlatformError("NOTIFICATION_NOT_FOUND", "Notification was not found");
  }
  return row;
}

export async function markOwnNotificationRead(
  pool: Pool,
  context: OperationContext,
  notificationId: string,
  body: MarkOwnNotificationReadBody,
  verifyTargets: NotificationTargetVerifier,
): Promise<MarkOwnNotificationReadResponse> {
  assertUuid(notificationId, "notificationId");
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", "Expected version is invalid");
  }
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireCurrentCapability(transaction, "platform.notifications.list_own");
    await requireCurrentCapability(transaction, "platform.notifications.mark_read_own");
    await lockOwnNotificationReadState(transaction);
    let row = await selectOwnVisibleProjectionForUpdate(transaction, notificationId);
    const targetResults = await verifyProjectionRows(
      transaction.client,
      context.tenantId,
      [row],
      verifyTargets,
    );
    const targetOutcome = targetResults.get(row.notification_id) ?? "missing";
    const exactReplay = await transaction.client.query<{
      evidence_event_id: string;
      prior_state: string | null;
    }>(
      `SELECT evidence_event_id,prior_state
       FROM evidence_events
       WHERE tenant_id=$1 AND subject_type='platform.notification'
         AND subject_id=$2
         AND event_type='evidence.platform.notifications.mark_read_own'
         AND correlation_id=$3 AND actor_principal_id=$4`,
      [context.tenantId, notificationId, context.correlationId, context.actorPrincipalId],
    );
    const replayEvidence = exactReplay.rows[0];
    if (replayEvidence) {
      const priorVersion = /^(?:read|unread):version:(\d+)$/.exec(
        replayEvidence.prior_state ?? "",
      )?.[1];
      if (Number(priorVersion) !== body.expectedVersion) {
        throw new PlatformError(
          "IDEMPOTENCY_CONFLICT",
          "Notification read retry changed its semantics",
        );
      }
      return {
        billingState: NOTIFICATION_BILLING_STATE,
        evidenceEventId: replayEvidence.evidence_event_id,
        notification: projectionToNotification(row, targetOutcome),
        replayed: true,
      };
    }
    if (row.row_version !== body.expectedVersion) {
      throw new PlatformError("NOTIFICATION_VERSION_CONFLICT", "Notification version is stale");
    }
    const priorState = `${row.read_at === null ? "unread" : "read"}:version:${row.row_version}`;
    if (row.read_at === null) {
      const updated = await transaction.client.query<ProjectionRow>(
        `UPDATE notification_projections
         SET read_at=clock_timestamp(),row_version=row_version+1
         WHERE tenant_id=$1 AND recipient_principal_id=$2
           AND notification_id=$3 AND row_version=$4 AND read_at IS NULL
         RETURNING notification_id,recipient_principal_id,source_service_key,category,title,safe_summary,
                   target_kind,target_resource_id,target_href,occurred_at,created_at,
                   read_at,retention_status,row_version`,
        [context.tenantId, context.actorPrincipalId, notificationId, body.expectedVersion],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new PlatformError(
          "NOTIFICATION_VERSION_CONFLICT",
          "Notification changed concurrently",
        );
      }
      row = updatedRow;
    }
    const evidence = await appendEvidence(transaction, {
      eventType: "evidence.platform.notifications.mark_read_own",
      newState: `read:version:${row.row_version}`,
      priorState,
      subjectId: notificationId,
      subjectType: "platform.notification",
    });
    return {
      billingState: NOTIFICATION_BILLING_STATE,
      evidenceEventId: evidence.evidenceEventId,
      notification: projectionToNotification(row, targetOutcome),
      replayed: false,
    };
  });
}

function parseMarkAllEvidence(value: string): {
  readonly remainingUnreadCount: number;
  readonly updatedCount: number;
} | null {
  const match = /^updated:(\d+);remaining:(\d+)$/.exec(value);
  if (!match) return null;
  const updatedCount = Number(match[1]);
  const remainingUnreadCount = Number(match[2]);
  if (
    !Number.isSafeInteger(updatedCount) ||
    updatedCount < 0 ||
    updatedCount > NOTIFICATION_MARK_ALL_BATCH_SIZE ||
    !Number.isSafeInteger(remainingUnreadCount) ||
    remainingUnreadCount < 0
  ) {
    return null;
  }
  return { remainingUnreadCount, updatedCount };
}

export async function markAllOwnNotificationsRead(
  pool: Pool,
  context: OperationContext,
  body: MarkAllOwnNotificationsReadBody,
): Promise<MarkAllOwnNotificationsReadResponse> {
  if (
    !Number.isFinite(Date.parse(body.beforeOccurredAt)) ||
    !Number.isSafeInteger(body.expectedUnreadCount) ||
    body.expectedUnreadCount < 0
  ) {
    throw new PlatformError("NOTIFICATION_INPUT_INVALID", "Mark-all filter is invalid");
  }
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireCurrentCapability(transaction, "platform.notifications.list_own");
    await requireCurrentCapability(transaction, "platform.notifications.mark_all_read_own");
    await lockOwnNotificationReadState(transaction);
    const commandState = JSON.stringify({
      beforeOccurredAt: body.beforeOccurredAt,
      expectedUnreadCount: body.expectedUnreadCount,
    });
    const subjectId = deriveStableUuid(
      "platform.notification.mark_all.v1",
      context.tenantId,
      context.actorPrincipalId,
      context.correlationId,
    );
    const exactReplay = await transaction.client.query<{
      evidence_event_id: string;
      new_state: string;
      prior_state: string | null;
    }>(
      `SELECT evidence_event_id,new_state,prior_state
       FROM evidence_events
       WHERE tenant_id=$1
         AND subject_type='platform.notifications.mark_all_read_own'
         AND subject_id=$2
         AND event_type='evidence.platform.notifications.mark_all_read_own'
         AND correlation_id=$3 AND actor_principal_id=$4`,
      [context.tenantId, subjectId, context.correlationId, context.actorPrincipalId],
    );
    const replayRow = exactReplay.rows[0];
    if (replayRow) {
      if (replayRow.prior_state !== commandState) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Mark-all retry changed its semantics");
      }
      const replayState = parseMarkAllEvidence(replayRow.new_state);
      if (!replayState) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Mark-all evidence is invalid");
      }
      return {
        billingState: NOTIFICATION_BILLING_STATE,
        evidenceEventId: replayRow.evidence_event_id,
        ...replayState,
        replayed: true,
      };
    }
    const current = await transaction.client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM notification_projections projection
       JOIN service_activations activation
         ON activation.tenant_id=projection.tenant_id
        AND activation.service_key=projection.source_service_key
        AND activation.state='active'
       JOIN membership_capabilities target_capability
         ON target_capability.tenant_id=projection.tenant_id
        AND target_capability.principal_id=projection.recipient_principal_id
        AND target_capability.capability_id=projection.target_read_capability_id
       WHERE projection.tenant_id=$1
         AND projection.recipient_principal_id=$2
         AND projection.retention_status='active'
         AND projection.read_at IS NULL
         AND projection.occurred_at <= $3
         AND projection.occurred_at >= clock_timestamp() - interval '90 days'`,
      [context.tenantId, context.actorPrincipalId, body.beforeOccurredAt],
    );
    const currentCount = current.rows[0]?.count ?? 0;
    if (currentCount !== body.expectedUnreadCount) {
      throw new PlatformError("NOTIFICATION_VERSION_CONFLICT", "Unread notification count changed");
    }
    const updated = await transaction.client.query<{ notification_id: string }>(
      `WITH selected AS (
         SELECT projection.notification_id
         FROM notification_projections projection
         JOIN service_activations activation
           ON activation.tenant_id=projection.tenant_id
          AND activation.service_key=projection.source_service_key
          AND activation.state='active'
         JOIN membership_capabilities target_capability
           ON target_capability.tenant_id=projection.tenant_id
          AND target_capability.principal_id=projection.recipient_principal_id
          AND target_capability.capability_id=projection.target_read_capability_id
         WHERE projection.tenant_id=$1
           AND projection.recipient_principal_id=$2
           AND projection.retention_status='active'
           AND projection.read_at IS NULL
           AND projection.occurred_at <= $3
           AND projection.occurred_at >= clock_timestamp() - interval '90 days'
         ORDER BY projection.occurred_at,projection.notification_id
         LIMIT $4
         FOR UPDATE OF projection SKIP LOCKED
       )
       UPDATE notification_projections projection
       SET read_at=clock_timestamp(),row_version=row_version+1
       FROM selected
       WHERE projection.tenant_id=$1
         AND projection.recipient_principal_id=$2
         AND projection.notification_id=selected.notification_id
       RETURNING projection.notification_id`,
      [
        context.tenantId,
        context.actorPrincipalId,
        body.beforeOccurredAt,
        NOTIFICATION_MARK_ALL_BATCH_SIZE,
      ],
    );
    const updatedCount = updated.rowCount ?? updated.rows.length;
    const remainingUnreadCount = currentCount - updatedCount;
    const evidence = await appendEvidence(transaction, {
      eventType: "evidence.platform.notifications.mark_all_read_own",
      newState: `updated:${updatedCount};remaining:${remainingUnreadCount}`,
      priorState: commandState,
      subjectId,
      subjectType: "platform.notifications.mark_all_read_own",
    });
    return {
      billingState: NOTIFICATION_BILLING_STATE,
      evidenceEventId: evidence.evidenceEventId,
      remainingUnreadCount,
      replayed: false,
      updatedCount,
    };
  });
}

interface ProjectorCurrentness {
  readonly capability_current: boolean;
  readonly intent_id: string;
  readonly membership_current: boolean;
  readonly service_current: boolean;
}

type TerminalProjectionOutcome =
  | "projected"
  | "withheld_membership"
  | "withheld_service_inactive"
  | "withheld_target_denied"
  | "withheld_target_missing";

export interface NotificationProjectionBatchResult {
  readonly claimed: number;
  readonly poisoned: number;
  readonly projected: number;
  readonly retried: number;
  readonly withheld: number;
}

function sanitizedFailureCode(error: unknown): string {
  if (error instanceof Error && FAILURE_CODE_PATTERN.test(error.message)) return error.message;
  return "PROJECTOR_OPERATION_FAILED";
}

async function appendProjectorEvidence(
  client: PoolClient,
  intent: ClaimedIntent,
  eventType:
    | "platform.notifications.poisoned"
    | "platform.notifications.projected"
    | "platform.notifications.retry_scheduled"
    | "platform.notifications.withheld",
  resultCode: string,
): Promise<void> {
  await client.query(
    `INSERT INTO notification_projector_evidence
       (tenant_id,intent_id,source_event_id,event_type,result_code)
     VALUES ($1,$2,$3,$4,$5)`,
    [intent.tenant_id, intent.intent_id, intent.source_event_id, eventType, resultCode],
  );
}

async function scheduleProjectionRetry(
  client: PoolClient,
  intent: ClaimedIntent,
  failureCode: string,
): Promise<"poisoned" | "retried"> {
  const attemptCount = intent.attempt_count + 1;
  if (attemptCount >= NOTIFICATION_POLICY_V1.maximumAttempts) {
    await client.query(
      `UPDATE notification_intents
       SET state='poisoned',attempt_count=$3,last_failure_code=$4,
           terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
           row_version=row_version+1
       WHERE tenant_id=$1 AND intent_id=$2
         AND state IN ('pending','retrying')`,
      [intent.tenant_id, intent.intent_id, attemptCount, failureCode],
    );
    await appendProjectorEvidence(client, intent, "platform.notifications.poisoned", failureCode);
    return "poisoned";
  }
  const backoffSeconds = Math.min(
    2 ** Math.max(0, attemptCount - 1),
    NOTIFICATION_POLICY_V1.backoffCapSeconds,
  );
  await client.query(
    `UPDATE notification_intents
     SET state='retrying',attempt_count=$3,last_failure_code=$4,
         next_attempt_at=clock_timestamp() + ($5::text || ' seconds')::interval,
         updated_at=clock_timestamp(),row_version=row_version+1
     WHERE tenant_id=$1 AND intent_id=$2
       AND state IN ('pending','retrying')`,
    [intent.tenant_id, intent.intent_id, attemptCount, failureCode, backoffSeconds],
  );
  await appendProjectorEvidence(
    client,
    intent,
    "platform.notifications.retry_scheduled",
    failureCode,
  );
  return "retried";
}

async function terminallyWithhold(
  client: PoolClient,
  intent: ClaimedIntent,
  outcome: Exclude<TerminalProjectionOutcome, "projected">,
): Promise<void> {
  await client.query(
    `INSERT INTO notification_projection_receipts
       (tenant_id,consumer_key,consumer_version,source_event_id,
        recipient_principal_id,intent_id,notification_id,outcome)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)`,
    [
      intent.tenant_id,
      NOTIFICATION_POLICY_V1.consumerKey,
      NOTIFICATION_POLICY_V1.consumerVersion,
      intent.source_event_id,
      intent.recipient_principal_id,
      intent.intent_id,
      outcome,
    ],
  );
  await client.query(
    `UPDATE notification_intents
     SET state=$3,intent_payload=$4::jsonb,terminal_at=clock_timestamp(),
         payload_redacted_at=clock_timestamp(),last_failure_code=NULL,
         updated_at=clock_timestamp(),row_version=row_version+1
     WHERE tenant_id=$1 AND intent_id=$2
       AND state IN ('pending','retrying')`,
    [intent.tenant_id, intent.intent_id, outcome, INTENT_REDACTION],
  );
  await appendProjectorEvidence(
    client,
    intent,
    "platform.notifications.withheld",
    outcome.toUpperCase(),
  );
}

async function projectIntent(
  client: PoolClient,
  intent: ClaimedIntent,
  payload: IntentPayload,
): Promise<void> {
  const projection = await client.query<{ notification_id: string }>(
    `INSERT INTO notification_projections
       (tenant_id,recipient_principal_id,intent_id,source_event_id,
        source_service_key,category,title,safe_summary,target_kind,
        target_resource_id,target_href,target_read_capability_id,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING notification_id`,
    [
      intent.tenant_id,
      intent.recipient_principal_id,
      intent.intent_id,
      intent.source_event_id,
      intent.source_service_key,
      payload.category,
      payload.title,
      payload.safeSummary,
      payload.targetKind,
      payload.targetResourceId,
      payload.targetHref,
      payload.targetReadCapabilityId,
      intent.occurred_at,
    ],
  );
  const notificationId = projection.rows[0]?.notification_id;
  if (!notificationId) throw new Error("PROJECTION_INSERT_FAILED");
  await client.query(
    `INSERT INTO notification_projection_receipts
       (tenant_id,consumer_key,consumer_version,source_event_id,
        recipient_principal_id,intent_id,notification_id,outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'projected')`,
    [
      intent.tenant_id,
      NOTIFICATION_POLICY_V1.consumerKey,
      NOTIFICATION_POLICY_V1.consumerVersion,
      intent.source_event_id,
      intent.recipient_principal_id,
      intent.intent_id,
      notificationId,
    ],
  );
  await client.query(
    `UPDATE notification_intents
     SET state='projected',intent_payload=$3::jsonb,terminal_at=clock_timestamp(),
         payload_redacted_at=clock_timestamp(),last_failure_code=NULL,
         updated_at=clock_timestamp(),row_version=row_version+1
     WHERE tenant_id=$1 AND intent_id=$2
       AND state IN ('pending','retrying')`,
    [intent.tenant_id, intent.intent_id, INTENT_REDACTION],
  );
  await appendProjectorEvidence(client, intent, "platform.notifications.projected", "PROJECTED");
}

async function currentnessForTenant(
  client: PoolClient,
  tenantId: string,
  intents: readonly { readonly intent: ClaimedIntent; readonly payload: IntentPayload }[],
): Promise<ReadonlyMap<string, ProjectorCurrentness>> {
  const input = intents.map(({ intent, payload }) => ({
    capability_id: payload.targetReadCapabilityId,
    intent_id: intent.intent_id,
    recipient_principal_id: intent.recipient_principal_id,
    service_key: intent.source_service_key,
  }));
  const result = await client.query<ProjectorCurrentness>(
    `SELECT item.intent_id,
            EXISTS (
              SELECT 1 FROM memberships membership
              WHERE membership.tenant_id=$1
                AND membership.principal_id=item.recipient_principal_id
                AND membership.status='active'
            ) AS membership_current,
            EXISTS (
              SELECT 1 FROM service_activations activation
              WHERE activation.tenant_id=$1
                AND activation.service_key=item.service_key
                AND activation.state='active'
            ) AS service_current,
            EXISTS (
              SELECT 1 FROM membership_capabilities capability
              WHERE capability.tenant_id=$1
                AND capability.principal_id=item.recipient_principal_id
                AND capability.capability_id=item.capability_id
            ) AS capability_current
     FROM jsonb_to_recordset($2::jsonb)
       AS item(intent_id uuid,recipient_principal_id uuid,service_key text,capability_id text)`,
    [tenantId, JSON.stringify(input)],
  );
  return new Map(result.rows.map((row) => [row.intent_id, row]));
}

async function processClaimedIntents(
  client: PoolClient,
  claimed: readonly ClaimedIntent[],
  verifyTargets: NotificationTargetVerifier,
): Promise<Omit<NotificationProjectionBatchResult, "claimed">> {
  let poisoned = 0;
  let projected = 0;
  let retried = 0;
  let withheld = 0;
  const valid: { readonly intent: ClaimedIntent; readonly payload: IntentPayload }[] = [];
  for (const intent of claimed) {
    try {
      valid.push({ intent, payload: parseIntentPayload(intent.intent_payload) });
    } catch (error) {
      await client.query("SAVEPOINT notification_intent");
      try {
        const result = await scheduleProjectionRetry(client, intent, sanitizedFailureCode(error));
        if (result === "poisoned") poisoned += 1;
        else retried += 1;
        await client.query("RELEASE SAVEPOINT notification_intent");
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT notification_intent");
        throw new Error("PROJECTOR_RETRY_RECORD_FAILED");
      }
    }
  }
  const byTenant = new Map<
    string,
    { readonly intent: ClaimedIntent; readonly payload: IntentPayload }[]
  >();
  for (const item of valid) {
    const group = byTenant.get(item.intent.tenant_id) ?? [];
    group.push(item);
    byTenant.set(item.intent.tenant_id, group);
  }
  for (const [tenantId, group] of byTenant) {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    let currentness: ReadonlyMap<string, ProjectorCurrentness>;
    await client.query("SAVEPOINT notification_currentness");
    try {
      currentness = await currentnessForTenant(client, tenantId, group);
      await client.query("RELEASE SAVEPOINT notification_currentness");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT notification_currentness");
      for (const { intent } of group) {
        const result = await scheduleProjectionRetry(
          client,
          intent,
          "PROJECTOR_CURRENTNESS_CHECK_FAILED",
        );
        if (result === "poisoned") poisoned += 1;
        else retried += 1;
      }
      continue;
    }
    const targetInputs = group
      .filter(({ intent }) => {
        const state = currentness.get(intent.intent_id);
        return (
          state?.membership_current === true &&
          state.service_current === true &&
          state.capability_current === true
        );
      })
      .map(
        ({ intent, payload }): NotificationTargetVerificationInput => ({
          recipientPrincipalId: intent.recipient_principal_id,
          referenceId: intent.intent_id,
          targetKind: payload.targetKind,
          targetResourceId: payload.targetResourceId,
        }),
      );
    let targetResults = new Map<string, "allowed" | "denied" | "missing">();
    if (targetInputs.length > 0) {
      await client.query("SAVEPOINT notification_target_verification");
      try {
        targetResults = new Map(
          verifyTargetResults(targetInputs, await verifyTargets(client, tenantId, targetInputs)),
        );
        await client.query("RELEASE SAVEPOINT notification_target_verification");
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT notification_target_verification");
        for (const { intent } of group) {
          const state = currentness.get(intent.intent_id);
          if (
            state?.membership_current === true &&
            state.service_current === true &&
            state.capability_current === true
          ) {
            const result = await scheduleProjectionRetry(
              client,
              intent,
              "PROJECTOR_TARGET_CHECK_FAILED",
            );
            if (result === "poisoned") poisoned += 1;
            else retried += 1;
          }
        }
      }
    }
    for (const { intent, payload } of group) {
      const state = currentness.get(intent.intent_id);
      let outcome: TerminalProjectionOutcome | "retry_already_recorded";
      if (!state?.membership_current) outcome = "withheld_membership";
      else if (!state.service_current) outcome = "withheld_service_inactive";
      else if (!state.capability_current) outcome = "withheld_target_denied";
      else {
        const target = targetResults.get(intent.intent_id);
        if (target === undefined) outcome = "retry_already_recorded";
        else if (target === "missing") outcome = "withheld_target_missing";
        else if (target === "denied") outcome = "withheld_target_denied";
        else outcome = "projected";
      }
      if (outcome === "retry_already_recorded") continue;
      await client.query("SAVEPOINT notification_projection");
      try {
        if (outcome === "projected") {
          await projectIntent(client, intent, payload);
          projected += 1;
        } else {
          await terminallyWithhold(client, intent, outcome);
          withheld += 1;
        }
        await client.query("RELEASE SAVEPOINT notification_projection");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT notification_projection");
        const result = await scheduleProjectionRetry(client, intent, sanitizedFailureCode(error));
        if (result === "poisoned") poisoned += 1;
        else retried += 1;
      }
    }
  }
  return { poisoned, projected, retried, withheld };
}

async function processNotificationProjectionBatch(
  pool: Pool,
  verifyTargets: NotificationTargetVerifier,
  lifecycle?: {
    readonly activeClient: (client: PoolClient | undefined) => void;
    readonly clientDestroyed: (client: PoolClient) => boolean;
  },
): Promise<NotificationProjectionBatchResult> {
  const client = await pool.connect();
  lifecycle?.activeClient(client);
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SET LOCAL search_path TO pg_catalog,public,pg_temp");
    const claimed = await client.query<ClaimedIntent>(
      `SELECT intent_id,tenant_id,source_event_id,recipient_principal_id,
              source_service_key,intent_payload,occurred_at,attempt_count
       FROM notification_intents
       WHERE state IN ('pending','retrying')
         AND next_attempt_at <= clock_timestamp()
       ORDER BY occurred_at,source_event_id,recipient_principal_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [NOTIFICATION_POLICY_V1.batchSize],
    );
    const result = await processClaimedIntents(client, claimed.rows, verifyTargets);
    await client.query("COMMIT");
    began = false;
    return { claimed: claimed.rowCount ?? claimed.rows.length, ...result };
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    lifecycle?.activeClient(undefined);
    if (!lifecycle?.clientDestroyed(client)) client.release();
  }
}

export async function projectPendingNotificationIntentsOnce(
  pool: Pool,
  verifyTargets: NotificationTargetVerifier,
): Promise<NotificationProjectionBatchResult> {
  return await processNotificationProjectionBatch(pool, verifyTargets);
}

export interface NotificationProjectorSnapshot {
  readonly oldestPendingAgeSeconds: number | null;
  readonly pending: number;
  readonly poisoned: number;
  readonly retrying: number;
}

async function inspectProjector(pool: Pool): Promise<NotificationProjectorSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      oldest_pending_age_seconds: number | null;
      pending: number;
      poisoned: number;
      retrying: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE state='pending')::integer AS pending,
         count(*) FILTER (WHERE state='retrying')::integer AS retrying,
         count(*) FILTER (WHERE state='poisoned')::integer AS poisoned,
         CASE
           WHEN count(*) FILTER (WHERE state IN ('pending','retrying'))=0 THEN NULL
           ELSE floor(extract(epoch FROM (
             clock_timestamp() - min(occurred_at)
               FILTER (WHERE state IN ('pending','retrying'))
           )))::integer
         END AS oldest_pending_age_seconds
       FROM notification_intents`,
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    return {
      oldestPendingAgeSeconds: row?.oldest_pending_age_seconds ?? null,
      pending: row?.pending ?? 0,
      poisoned: row?.poisoned ?? 0,
      retrying: row?.retrying ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface NotificationProjector {
  readonly inspect: () => Promise<NotificationProjectorSnapshot>;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly wake: () => void;
}

export function createNotificationProjector(
  pool: Pool,
  verifyTargets: NotificationTargetVerifier,
  options: {
    readonly onDiagnostic?: (diagnostic: {
      readonly code: "NOTIFICATION_PROJECTOR_BATCH_FAILED" | "NOTIFICATION_PROJECTOR_STOP_TIMEOUT";
    }) => void;
    readonly shutdownJoinMs?: number;
  } = {},
): NotificationProjector {
  const shutdownJoinMs = options.shutdownJoinMs ?? NOTIFICATION_POLICY_V1.shutdownJoinMs;
  if (
    !Number.isSafeInteger(shutdownJoinMs) ||
    shutdownJoinMs < 1 ||
    shutdownJoinMs > NOTIFICATION_POLICY_V1.shutdownJoinMs
  ) {
    throw new Error("Invalid notification projector shutdown bound");
  }
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let activeClient: PoolClient | undefined;
  let activeWake: AbortController | undefined;
  let restartBlocked = false;
  let wakePending = false;
  const destroyedClients = new WeakSet<PoolClient>();
  const lifecycle = {
    activeClient: (client: PoolClient | undefined) => {
      activeClient = client;
    },
    clientDestroyed: (client: PoolClient) => destroyedClients.has(client),
  };

  async function run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const result = await processNotificationProjectionBatch(pool, verifyTargets, lifecycle);
        if (signal.aborted) return;
        if (result.claimed > 0) continue;
      } catch {
        options.onDiagnostic?.({ code: "NOTIFICATION_PROJECTOR_BATCH_FAILED" });
      }
      if (wakePending) {
        wakePending = false;
        continue;
      }
      activeWake = new AbortController();
      await abortableDelay(
        NOTIFICATION_POLICY_V1.idlePollMs,
        AbortSignal.any([signal, activeWake.signal]),
      );
      activeWake = undefined;
      wakePending = false;
    }
  }

  return {
    inspect: async () => await inspectProjector(pool),
    start: () => {
      if (restartBlocked) {
        throw new Error("Notification projector cannot restart after forced shutdown");
      }
      if (loop) return;
      controller = new AbortController();
      loop = run(controller.signal);
    },
    stop: async () => {
      if (!loop || !controller) return;
      const stoppingLoop = loop;
      controller.abort();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        stoppingLoop.then(() => false),
        new Promise<true>((resolve) => {
          timeout = setTimeout(() => resolve(true), shutdownJoinMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (timedOut && activeClient && !destroyedClients.has(activeClient)) {
        options.onDiagnostic?.({ code: "NOTIFICATION_PROJECTOR_STOP_TIMEOUT" });
        destroyedClients.add(activeClient);
        activeClient.release(true);
      }
      if (timedOut) {
        restartBlocked = true;
        void stoppingLoop.catch(() => undefined);
      } else {
        await stoppingLoop.catch(() => undefined);
      }
      loop = undefined;
      controller = undefined;
      activeClient = undefined;
      activeWake = undefined;
      wakePending = false;
    },
    wake: () => {
      wakePending = true;
      activeWake?.abort();
    },
  };
}
