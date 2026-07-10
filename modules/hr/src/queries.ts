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
  type AssignedLeaveRequestSummary,
  HR_LEAVE_APPROVAL_WORK_TYPE,
  HR_LEAVE_SUBJECT_TYPE,
  type LeaveEvidenceCursor,
  type LeaveEvidenceEvent,
  type LeaveEvidenceSummary,
  type LeaveListCursor,
  type LeaveRequest,
  type LeaveRequestDetail,
  type LeaveRequestDetailRequest,
} from "./types.js";

type AssignedLeaveRow = LeaveRow & {
  employee_display_name: string;
  work_item_id: string;
};

function mapAssignedLeaveRow(row: AssignedLeaveRow): AssignedLeaveRequestSummary {
  return {
    categoryCode: row.category_code,
    employeeDisplayName: row.employee_display_name,
    endDate: row.end_date,
    leaveRequestId: row.leave_request_id,
    reason: row.reason,
    startDate: row.start_date,
    submittedAt: row.submitted_at,
    version: row.version,
    workItemId: row.work_item_id,
  };
}

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

type EvidenceRow = {
  actor_principal_id: string;
  correlation_id: string;
  event_type: string;
  evidence_event_id: string;
  new_state: string;
  occurred_at: string;
  prior_state: string | null;
};

function mapEvidenceRow(row: EvidenceRow): LeaveEvidenceEvent {
  return {
    actorPrincipalId: row.actor_principal_id,
    correlationId: row.correlation_id,
    eventType: row.event_type,
    evidenceEventId: row.evidence_event_id,
    newState: row.new_state,
    occurredAt: row.occurred_at,
    priorState: row.prior_state,
  };
}

function mapEvidenceSummary(event: LeaveEvidenceEvent): LeaveEvidenceSummary {
  return {
    eventType: event.eventType,
    newState: event.newState,
    occurredAt: event.occurredAt,
    priorState: event.priorState,
  };
}

function mapLeaveDetailRequest(
  row: LeaveRow,
  employeeDisplayName: string,
): LeaveRequestDetailRequest {
  return {
    categoryCode: row.category_code,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    employeeDisplayName,
    endDate: row.end_date,
    leaveRequestId: row.leave_request_id,
    reason: row.reason,
    startDate: row.start_date,
    status: row.status,
    submittedAt: row.submitted_at,
    version: row.version,
  };
}

async function selectEmployeeDisplayName(
  transaction: TenantTransaction,
  employeePrincipalId: string,
): Promise<string> {
  const result = await transaction.client.query<{ display_name: string }>(
    `SELECT principal.display_name
     FROM memberships membership
     JOIN principals principal ON principal.principal_id = membership.principal_id
     WHERE membership.tenant_id = $1 AND membership.principal_id = $2`,
    [transaction.context.tenantId, employeePrincipalId],
  );
  const displayName = result.rows[0]?.display_name;
  if (!displayName) throw new Error("Leave request employee display name is unavailable");
  return displayName;
}

async function selectEvidence(
  transaction: TenantTransaction,
  leaveRequestId: string,
  pageSize: number,
  cursor?: LeaveEvidenceCursor,
): Promise<readonly LeaveEvidenceEvent[]> {
  const result = cursor
    ? await transaction.client.query<EvidenceRow>(
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
    : await transaction.client.query<EvidenceRow>(
        `SELECT evidence_event_id, event_type, actor_principal_id, correlation_id,
                prior_state, new_state,
                to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
         FROM evidence_events
         WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
         ORDER BY occurred_at ASC, evidence_event_id ASC
         LIMIT $4`,
        [transaction.context.tenantId, HR_LEAVE_SUBJECT_TYPE, leaveRequestId, pageSize],
      );
  return result.rows.map(mapEvidenceRow);
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

export async function getLeaveRequestDetail(
  pool: Pool,
  context: OperationContext,
  leaveRequestId: string,
): Promise<LeaveRequestDetail | null> {
  assertUuid(leaveRequestId, "leaveRequestId");
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireLeaveServiceActive(transaction);
    const row = await selectLeave(transaction, leaveRequestId);
    if (!row) return null;
    authorizeView(transaction, row);
    const history = await selectEvidence(transaction, leaveRequestId, 100);
    return {
      history: history.map(mapEvidenceSummary),
      request: mapLeaveDetailRequest(
        row,
        await selectEmployeeDisplayName(transaction, row.employee_principal_id),
      ),
    };
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
): Promise<readonly AssignedLeaveRequestSummary[]> {
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
      ? await transaction.client.query<AssignedLeaveRow>(
          `WITH assigned_leave AS (
             SELECT request.*, work.work_item_id,
                    principal.display_name AS employee_display_name
             FROM hr_leave_requests request
             JOIN work_items work
               ON work.tenant_id = request.tenant_id
              AND work.subject_id = request.leave_request_id
             JOIN principals principal
               ON principal.principal_id = request.employee_principal_id
             WHERE request.tenant_id = $1
               AND request.approver_principal_id = $2
               AND request.status = 'submitted'
               AND work.assignee_principal_id = $2
               AND work.work_type = $3
               AND work.subject_type = $4
               AND work.status = 'open'
               AND (request.submitted_at, request.leave_request_id)
                 > ($5::timestamptz, $6::uuid)
             ORDER BY request.submitted_at ASC, request.leave_request_id ASC
             LIMIT $7
           )
           SELECT ${LEAVE_COLUMNS}, work_item_id, employee_display_name
           FROM assigned_leave
           ORDER BY submitted_at ASC, leave_request_id ASC`,
          [
            transaction.context.tenantId,
            transaction.context.actorPrincipalId,
            HR_LEAVE_APPROVAL_WORK_TYPE,
            HR_LEAVE_SUBJECT_TYPE,
            cursor.submittedAt,
            cursor.leaveRequestId,
            pageSize,
          ],
        )
      : await transaction.client.query<AssignedLeaveRow>(
          `WITH assigned_leave AS (
             SELECT request.*, work.work_item_id,
                    principal.display_name AS employee_display_name
             FROM hr_leave_requests request
             JOIN work_items work
               ON work.tenant_id = request.tenant_id
              AND work.subject_id = request.leave_request_id
             JOIN principals principal
               ON principal.principal_id = request.employee_principal_id
             WHERE request.tenant_id = $1
               AND request.approver_principal_id = $2
               AND request.status = 'submitted'
               AND work.assignee_principal_id = $2
               AND work.work_type = $3
               AND work.subject_type = $4
               AND work.status = 'open'
             ORDER BY request.submitted_at ASC, request.leave_request_id ASC
             LIMIT $5
           )
           SELECT ${LEAVE_COLUMNS}, work_item_id, employee_display_name
           FROM assigned_leave
           ORDER BY submitted_at ASC, leave_request_id ASC`,
          [
            transaction.context.tenantId,
            transaction.context.actorPrincipalId,
            HR_LEAVE_APPROVAL_WORK_TYPE,
            HR_LEAVE_SUBJECT_TYPE,
            pageSize,
          ],
        );
    return result.rows.map(mapAssignedLeaveRow);
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
    return await selectEvidence(transaction, leaveRequestId, pageSize, options.cursor);
  });
}
