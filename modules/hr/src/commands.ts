import { randomUUID } from "node:crypto";
import {
  completeWorkItem,
  createWorkItem,
  type OperationContext,
  recordMutationProof,
  resolveSetting,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import { HrLeaveError } from "./errors.js";
import {
  assertUuid,
  authorizeLeaveAction,
  isCurrentAssignedManager,
  LEAVE_COLUMNS,
  type LeaveRow,
  mapLeaveRow,
  normalizeOptionalText,
  requireLeaveServiceActive,
  selectLeaveForUpdate,
  validateSubmissionInput,
} from "./internal.js";
import { hrLeaveSettings } from "./settings.js";
import {
  type DecideLeaveRequestInput,
  HR_LEAVE_APPROVAL_WORK_TYPE,
  HR_LEAVE_BILLING_STATE,
  HR_LEAVE_SUBJECT_TYPE,
  type LeaveCommandResult,
  type LeaveRequestStatus,
  type SubmitLeaveRequestInput,
} from "./types.js";

function commandResult(row: LeaveRow, replayed: boolean): LeaveCommandResult {
  return { billingState: HR_LEAVE_BILLING_STATE, replayed, request: mapLeaveRow(row) };
}

function assertSameSubmission(
  row: LeaveRow,
  input: SubmitLeaveRequestInput,
  reason: string | null,
): void {
  if (
    row.category_code !== input.categoryCode ||
    row.start_date !== input.startDate ||
    row.end_date !== input.endDate ||
    row.reason !== reason
  ) {
    throw new HrLeaveError(
      "LEAVE_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used with different leave request data",
      { leaveRequestId: row.leave_request_id },
    );
  }
}

async function findExistingSubmission(
  transaction: TenantTransaction,
  input: SubmitLeaveRequestInput,
  reason: string | null,
): Promise<LeaveRow | null> {
  const existing = await transaction.client.query<LeaveRow>(
    `SELECT ${LEAVE_COLUMNS}
     FROM hr_leave_requests
     WHERE tenant_id = $1 AND employee_principal_id = $2 AND idempotency_key = $3`,
    [
      transaction.context.tenantId,
      transaction.context.actorPrincipalId,
      input.idempotencyKey.trim(),
    ],
  );
  const row = existing.rows[0] ?? null;
  if (row) assertSameSubmission(row, input, reason);
  return row;
}

export async function submitLeaveRequest(
  pool: Pool,
  context: OperationContext,
  input: SubmitLeaveRequestInput,
): Promise<LeaveCommandResult> {
  validateSubmissionInput(input);
  if (input.leaveRequestId) assertUuid(input.leaveRequestId, "leaveRequestId");
  const reason = normalizeOptionalText(input.reason, "reason");

  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireLeaveServiceActive(transaction);
    const replay = await findExistingSubmission(transaction, input, reason);
    if (replay) return commandResult(replay, true);

    await resolveSetting(transaction, hrLeaveSettings.requestUnit);
    const reasonRequired = await resolveSetting(transaction, hrLeaveSettings.requireReason);
    await resolveSetting(transaction, hrLeaveSettings.allowSelfApproval);
    if (reasonRequired.value && reason === null) {
      throw new HrLeaveError("LEAVE_INPUT_INVALID", "Leave reason is required by tenant policy");
    }

    const membership = await transaction.client.query<{ manager_principal_id: string | null }>(
      `SELECT employee.manager_principal_id
       FROM memberships employee
       LEFT JOIN memberships manager
        ON manager.tenant_id = employee.tenant_id
        AND manager.principal_id = employee.manager_principal_id
        AND manager.role_key = 'manager'
        AND manager.status = 'active'
       WHERE employee.tenant_id = $1 AND employee.principal_id = $2
         AND employee.status = 'active' AND manager.principal_id IS NOT NULL`,
      [transaction.context.tenantId, transaction.context.actorPrincipalId],
    );
    const approverPrincipalId = membership.rows[0]?.manager_principal_id;
    if (!approverPrincipalId) {
      throw new HrLeaveError("LEAVE_MANAGER_REQUIRED", "Employee has no active assigned manager");
    }

    const leaveRequestId = input.leaveRequestId ?? randomUUID();
    authorizeLeaveAction(
      transaction,
      "hr.leave.submit",
      leaveRequestId,
      { approverPrincipalId, employeePrincipalId: transaction.context.actorPrincipalId },
      [
        {
          effect: "deny",
          id: "deny_self_approval_assignment",
          matches: (request) => request.approverPrincipalId === request.employeePrincipalId,
        },
        {
          effect: "allow",
          id: "employee_submit_own",
          matches: (request, actor) => request.employeePrincipalId === actor.principalId,
        },
      ],
    );

    const inserted = await transaction.client.query<LeaveRow>(
      `INSERT INTO hr_leave_requests
         (leave_request_id, tenant_id, employee_principal_id, approver_principal_id,
          category_code, start_date, end_date, reason, idempotency_key, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, employee_principal_id, idempotency_key) DO NOTHING
       RETURNING ${LEAVE_COLUMNS}`,
      [
        leaveRequestId,
        transaction.context.tenantId,
        transaction.context.actorPrincipalId,
        approverPrincipalId,
        input.categoryCode,
        input.startDate,
        input.endDate,
        reason,
        input.idempotencyKey.trim(),
        transaction.context.correlationId,
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      const concurrentReplay = await findExistingSubmission(transaction, input, reason);
      if (!concurrentReplay) {
        throw new HrLeaveError(
          "LEAVE_IDEMPOTENCY_CONFLICT",
          "Concurrent submission was not visible",
        );
      }
      return commandResult(concurrentReplay, true);
    }

    await createWorkItem(transaction, {
      assigneePrincipalId: approverPrincipalId,
      subjectId: row.leave_request_id,
      subjectType: HR_LEAVE_SUBJECT_TYPE,
      workType: HR_LEAVE_APPROVAL_WORK_TYPE,
    });
    await recordMutationProof(transaction, {
      evidence: {
        eventType: "evidence.hr.leave_request.submitted",
        newState: "submitted",
        priorState: null,
        subjectId: row.leave_request_id,
        subjectType: HR_LEAVE_SUBJECT_TYPE,
      },
      outbox: {
        aggregateId: row.leave_request_id,
        aggregateType: HR_LEAVE_SUBJECT_TYPE,
        aggregateVersion: row.version,
        eventType: "hr.leave_request.submitted",
        payload: {
          approverPrincipalId,
          categoryCode: row.category_code,
          employeePrincipalId: row.employee_principal_id,
          endDate: row.end_date,
          leaveRequestId: row.leave_request_id,
          startDate: row.start_date,
          status: row.status,
          version: row.version,
        },
      },
    });
    return commandResult(row, false);
  });
}

async function findDecisionReplay(
  transaction: TenantTransaction,
  row: LeaveRow,
  targetState: Exclude<LeaveRequestStatus, "submitted">,
  evidenceEventType: string,
  outboxEventType: string,
): Promise<boolean> {
  const result = await transaction.client.query(
    `SELECT 1
     FROM evidence_events e
     JOIN outbox_events o
       ON o.tenant_id = e.tenant_id
      AND o.aggregate_type = e.subject_type
      AND o.aggregate_id = e.subject_id
      AND o.correlation_id = e.correlation_id
     WHERE e.tenant_id = $1 AND e.subject_type = $2 AND e.subject_id = $3
       AND e.event_type = $4 AND e.correlation_id = $5
       AND e.actor_principal_id = $6 AND e.new_state = $7
       AND o.event_type = $8 AND o.aggregate_version = $9`,
    [
      transaction.context.tenantId,
      HR_LEAVE_SUBJECT_TYPE,
      row.leave_request_id,
      evidenceEventType,
      transaction.context.correlationId,
      transaction.context.actorPrincipalId,
      targetState,
      outboxEventType,
      row.version,
    ],
  );
  return result.rowCount === 1;
}

async function decideLeaveRequest(
  pool: Pool,
  context: OperationContext,
  input: DecideLeaveRequestInput,
  targetState: Exclude<LeaveRequestStatus, "submitted">,
): Promise<LeaveCommandResult> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", "Expected version must be a positive integer");
  }
  assertUuid(input.leaveRequestId, "leaveRequestId");
  const decisionNote = normalizeOptionalText(input.decisionNote, "decision note");
  const action = targetState === "approved" ? "approve" : "reject";
  const evidenceEventType = `evidence.hr.leave_request.${targetState}`;
  const outboxEventType = `hr.leave_request.${targetState}`;

  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireLeaveServiceActive(transaction);
    const row = await selectLeaveForUpdate(transaction, input.leaveRequestId);
    authorizeLeaveAction(transaction, `hr.leave.${action}`, row.leave_request_id, row, [
      {
        effect: "deny",
        id: `deny_self_${action}`,
        matches: (request, actor) => request.employee_principal_id === actor.principalId,
      },
      {
        effect: "allow",
        id: `manager_${action}_assigned`,
        matches: isCurrentAssignedManager,
      },
    ]);

    if (
      row.status === targetState &&
      (await findDecisionReplay(transaction, row, targetState, evidenceEventType, outboxEventType))
    ) {
      if (row.decision_note !== decisionNote) {
        throw new HrLeaveError(
          "LEAVE_IDEMPOTENCY_CONFLICT",
          "Decision retry changed the decision note",
        );
      }
      return commandResult(row, true);
    }
    if (row.status !== "submitted") {
      throw new HrLeaveError("LEAVE_STATE_CONFLICT", "Terminal leave request cannot be changed", {
        status: row.status,
      });
    }
    if (row.version !== input.expectedVersion) {
      throw new HrLeaveError("LEAVE_VERSION_CONFLICT", "Leave request version is stale", {
        actualVersion: row.version,
        expectedVersion: input.expectedVersion,
      });
    }

    await resolveSetting(transaction, hrLeaveSettings.allowSelfApproval);
    if (targetState === "rejected") {
      const noteRequired = await resolveSetting(transaction, hrLeaveSettings.rejectNoteRequired);
      if (noteRequired.value && decisionNote === null) {
        throw new HrLeaveError(
          "LEAVE_INPUT_INVALID",
          "Rejection note is required by tenant policy",
        );
      }
    }

    const updated = await transaction.client.query<LeaveRow>(
      `UPDATE hr_leave_requests
       SET status = $3, decision_note = $4, decided_at = now(),
           updated_at = now(), version = version + 1
       WHERE tenant_id = $1 AND leave_request_id = $2
         AND status = 'submitted' AND version = $5
       RETURNING ${LEAVE_COLUMNS}`,
      [
        transaction.context.tenantId,
        row.leave_request_id,
        targetState,
        decisionNote,
        input.expectedVersion,
      ],
    );
    const decided = updated.rows[0];
    if (!decided) {
      throw new HrLeaveError("LEAVE_VERSION_CONFLICT", "Leave request changed concurrently");
    }
    const workItem = await transaction.client.query<{ work_item_id: string }>(
      `SELECT work_item_id
       FROM work_items
       WHERE tenant_id = $1 AND work_type = $2 AND subject_type = $3 AND subject_id = $4`,
      [
        transaction.context.tenantId,
        HR_LEAVE_APPROVAL_WORK_TYPE,
        HR_LEAVE_SUBJECT_TYPE,
        row.leave_request_id,
      ],
    );
    const workItemId = workItem.rows[0]?.work_item_id;
    if (!workItemId) {
      throw new HrLeaveError("LEAVE_STATE_CONFLICT", "Approval work item is missing");
    }
    await completeWorkItem(transaction, workItemId);
    await recordMutationProof(transaction, {
      evidence: {
        eventType: evidenceEventType,
        newState: targetState,
        priorState: "submitted",
        subjectId: row.leave_request_id,
        subjectType: HR_LEAVE_SUBJECT_TYPE,
      },
      outbox: {
        aggregateId: row.leave_request_id,
        aggregateType: HR_LEAVE_SUBJECT_TYPE,
        aggregateVersion: decided.version,
        eventType: outboxEventType,
        payload: {
          leaveRequestId: row.leave_request_id,
          status: targetState,
          version: decided.version,
        },
      },
    });
    return commandResult(decided, false);
  });
}

export async function approveLeaveRequest(
  pool: Pool,
  context: OperationContext,
  input: DecideLeaveRequestInput,
): Promise<LeaveCommandResult> {
  return await decideLeaveRequest(pool, context, input, "approved");
}

export async function rejectLeaveRequest(
  pool: Pool,
  context: OperationContext,
  input: DecideLeaveRequestInput,
): Promise<LeaveCommandResult> {
  return await decideLeaveRequest(pool, context, input, "rejected");
}
