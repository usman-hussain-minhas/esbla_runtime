import {
  type OperationContext,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import {
  assertTimestamp,
  assertUuid,
  authorizeLeaveAction,
  authorizeView,
  LEAVE_COLUMNS,
  type LeaveRow,
  mapLeaveRow,
  requireLeaveServiceActive,
  validatePageSize,
} from "./internal.js";
import {
  HR_LEAVE_SUBJECT_TYPE,
  type LeaveEvidenceCursor,
  type LeaveEvidenceEvent,
  type LeaveListCursor,
  type LeaveRequest,
} from "./types.js";

async function selectLeave(
  transaction: TenantTransaction,
  leaveRequestId: string,
): Promise<LeaveRow | null> {
  const result = await transaction.client.query<LeaveRow>(
    `SELECT ${LEAVE_COLUMNS}
     FROM hr_leave_requests
     WHERE tenant_id = $1 AND leave_request_id = $2`,
    [transaction.context.tenantId, leaveRequestId],
  );
  return result.rows[0] ?? null;
}

export async function getLeaveRequest(
  pool: Pool,
  context: OperationContext,
  leaveRequestId: string,
): Promise<LeaveRequest | null> {
  assertUuid(leaveRequestId, "leaveRequestId");
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireLeaveServiceActive(transaction);
    const row = await selectLeave(transaction, leaveRequestId);
    if (!row) return null;
    authorizeView(transaction, row);
    return mapLeaveRow(row);
  });
}

export async function listOwnLeaveRequests(
  pool: Pool,
  context: OperationContext,
  options: { readonly cursor?: LeaveListCursor; readonly pageSize?: number } = {},
): Promise<readonly LeaveRequest[]> {
  const pageSize = validatePageSize(options.pageSize ?? 50, 50);
  if (options.cursor) {
    assertUuid(options.cursor.leaveRequestId, "cursor.leaveRequestId");
    assertTimestamp(options.cursor.submittedAt, "cursor.submittedAt");
  }
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireLeaveServiceActive(transaction);
    authorizeLeaveAction(transaction, "hr.leave.list_own", "own", {}, [
      { effect: "allow", id: "employee_list_own", matches: () => true },
    ]);
    const cursor = options.cursor;
    const result = cursor
      ? await transaction.client.query<LeaveRow>(
          `SELECT ${LEAVE_COLUMNS}
           FROM hr_leave_requests
           WHERE tenant_id = $1 AND employee_principal_id = $2
             AND (submitted_at, leave_request_id) < ($3::timestamptz, $4::uuid)
           ORDER BY submitted_at DESC, leave_request_id DESC
           LIMIT $5`,
          [
            transaction.context.tenantId,
            transaction.context.actorPrincipalId,
            cursor.submittedAt,
            cursor.leaveRequestId,
            pageSize,
          ],
        )
      : await transaction.client.query<LeaveRow>(
          `SELECT ${LEAVE_COLUMNS}
           FROM hr_leave_requests
           WHERE tenant_id = $1 AND employee_principal_id = $2
           ORDER BY submitted_at DESC, leave_request_id DESC
           LIMIT $3`,
          [transaction.context.tenantId, transaction.context.actorPrincipalId, pageSize],
        );
    return result.rows.map(mapLeaveRow);
  });
}

export async function listAssignedLeaveRequests(
  pool: Pool,
  context: OperationContext,
  options: { readonly cursor?: LeaveListCursor; readonly pageSize?: number } = {},
): Promise<readonly LeaveRequest[]> {
  const pageSize = validatePageSize(options.pageSize ?? 50, 50);
  if (options.cursor) {
    assertUuid(options.cursor.leaveRequestId, "cursor.leaveRequestId");
    assertTimestamp(options.cursor.submittedAt, "cursor.submittedAt");
  }
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireLeaveServiceActive(transaction);
    authorizeLeaveAction(transaction, "hr.leave.list_assigned", "assigned", {}, [
      {
        effect: "allow",
        id: "manager_list_assigned",
        matches: (_input, actor) => actor.roleKey === "manager",
      },
    ]);
    const cursor = options.cursor;
    const result = cursor
      ? await transaction.client.query<LeaveRow>(
          `SELECT ${LEAVE_COLUMNS}
           FROM hr_leave_requests
           WHERE tenant_id = $1 AND approver_principal_id = $2 AND status = 'submitted'
             AND (submitted_at, leave_request_id) > ($3::timestamptz, $4::uuid)
           ORDER BY submitted_at ASC, leave_request_id ASC
           LIMIT $5`,
          [
            transaction.context.tenantId,
            transaction.context.actorPrincipalId,
            cursor.submittedAt,
            cursor.leaveRequestId,
            pageSize,
          ],
        )
      : await transaction.client.query<LeaveRow>(
          `SELECT ${LEAVE_COLUMNS}
           FROM hr_leave_requests
           WHERE tenant_id = $1 AND approver_principal_id = $2 AND status = 'submitted'
           ORDER BY submitted_at ASC, leave_request_id ASC
           LIMIT $3`,
          [transaction.context.tenantId, transaction.context.actorPrincipalId, pageSize],
        );
    return result.rows.map(mapLeaveRow);
  });
}

export async function listLeaveEvidence(
  pool: Pool,
  context: OperationContext,
  leaveRequestId: string,
  options: { readonly cursor?: LeaveEvidenceCursor; readonly pageSize?: number } = {},
): Promise<readonly LeaveEvidenceEvent[]> {
  const pageSize = validatePageSize(options.pageSize ?? 100, 100);
  assertUuid(leaveRequestId, "leaveRequestId");
  if (options.cursor) {
    assertUuid(options.cursor.evidenceEventId, "cursor.evidenceEventId");
    assertTimestamp(options.cursor.occurredAt, "cursor.occurredAt");
  }
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireLeaveServiceActive(transaction);
    const request = await selectLeave(transaction, leaveRequestId);
    if (!request) return [];
    authorizeView(transaction, request);
    const cursor = options.cursor;
    const result = cursor
      ? await transaction.client.query<{
          actor_principal_id: string;
          correlation_id: string;
          event_type: string;
          evidence_event_id: string;
          new_state: string;
          occurred_at: string;
          prior_state: string | null;
        }>(
          `SELECT evidence_event_id, event_type, actor_principal_id, correlation_id,
                  prior_state, new_state,
                  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
           FROM evidence_events
           WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
             AND (occurred_at, evidence_event_id) > ($4::timestamptz, $5::uuid)
           ORDER BY occurred_at ASC, evidence_event_id ASC
           LIMIT $6`,
          [
            transaction.context.tenantId,
            HR_LEAVE_SUBJECT_TYPE,
            leaveRequestId,
            cursor.occurredAt,
            cursor.evidenceEventId,
            pageSize,
          ],
        )
      : await transaction.client.query<{
          actor_principal_id: string;
          correlation_id: string;
          event_type: string;
          evidence_event_id: string;
          new_state: string;
          occurred_at: string;
          prior_state: string | null;
        }>(
          `SELECT evidence_event_id, event_type, actor_principal_id, correlation_id,
                  prior_state, new_state,
                  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
           FROM evidence_events
           WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
           ORDER BY occurred_at ASC, evidence_event_id ASC
           LIMIT $4`,
          [transaction.context.tenantId, HR_LEAVE_SUBJECT_TYPE, leaveRequestId, pageSize],
        );
    return result.rows.map((row) => ({
      actorPrincipalId: row.actor_principal_id,
      correlationId: row.correlation_id,
      eventType: row.event_type,
      evidenceEventId: row.evidence_event_id,
      newState: row.new_state,
      occurredAt: row.occurred_at,
      priorState: row.prior_state,
    }));
  });
}
