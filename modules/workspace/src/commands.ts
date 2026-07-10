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
import { WorkspaceTaskError } from "./errors.js";
import {
  assertUuid,
  authorizeWorkspaceTaskAction,
  mapWorkspaceTaskRow,
  normalizeOptionalDate,
  normalizeOptionalText,
  normalizeRequiredText,
  requireWorkspaceTaskServiceActive,
  selectTaskForUpdate,
  WORKSPACE_TASK_COLUMNS,
  type WorkspaceTaskRow,
} from "./internal.js";
import { workspaceTaskSettings } from "./settings.js";
import {
  type CompleteWorkspaceTaskInput,
  type CreateWorkspaceTaskInput,
  WORKSPACE_TASK_BILLING_STATE,
  WORKSPACE_TASK_SUBJECT_TYPE,
  WORKSPACE_TASK_WORK_TYPE,
  type WorkspaceTaskCommandResult,
} from "./types.js";

function commandResult(row: WorkspaceTaskRow, replayed: boolean): WorkspaceTaskCommandResult {
  return { billingState: WORKSPACE_TASK_BILLING_STATE, replayed, task: mapWorkspaceTaskRow(row) };
}

function assertSameCreate(
  row: WorkspaceTaskRow,
  input: CreateWorkspaceTaskInput,
  title: string,
  description: string | null,
  dueOn: string | null,
): void {
  if (
    row.assignee_principal_id !== input.assigneePrincipalId ||
    row.title !== title ||
    row.description !== description ||
    row.due_on !== dueOn
  ) {
    throw new WorkspaceTaskError(
      "WORKSPACE_TASK_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used with different task data",
      { taskId: row.task_id },
    );
  }
}

async function findExistingCreate(
  transaction: TenantTransaction,
  input: CreateWorkspaceTaskInput,
  title: string,
  description: string | null,
  dueOn: string | null,
): Promise<WorkspaceTaskRow | null> {
  const existing = await transaction.client.query<WorkspaceTaskRow>(
    `SELECT ${WORKSPACE_TASK_COLUMNS}
     FROM workspace_tasks
     WHERE tenant_id = $1 AND created_by_principal_id = $2 AND idempotency_key = $3`,
    [
      transaction.context.tenantId,
      transaction.context.actorPrincipalId,
      input.idempotencyKey.trim(),
    ],
  );
  const row = existing.rows[0] ?? null;
  if (row) assertSameCreate(row, input, title, description, dueOn);
  return row;
}

export async function createWorkspaceTask(
  pool: Pool,
  context: OperationContext,
  input: CreateWorkspaceTaskInput,
): Promise<WorkspaceTaskCommandResult> {
  if (input.taskId) assertUuid(input.taskId, "taskId");
  assertUuid(input.assigneePrincipalId, "assigneePrincipalId");
  const title = normalizeRequiredText(input.title, "title", 160);
  const description = normalizeOptionalText(input.description, "description", 2000);
  const dueOn = normalizeOptionalDate(input.dueOn, "dueOn");
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0 || idempotencyKey.length > 128) {
    throw new WorkspaceTaskError(
      "WORKSPACE_TASK_INPUT_INVALID",
      "Idempotency key must contain 1 to 128 characters",
    );
  }

  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireWorkspaceTaskServiceActive(transaction);
    const replay = await findExistingCreate(transaction, input, title, description, dueOn);
    if (replay) return commandResult(replay, true);

    authorizeWorkspaceTaskAction(
      transaction,
      "workspace.task.create",
      input.taskId ?? "new",
      { assigneePrincipalId: input.assigneePrincipalId },
      [
        {
          effect: "allow",
          id: "tenant_member_create_task",
          matches: () => true,
        },
      ],
    );

    const assignee = await transaction.client.query<{ principal_id: string }>(
      `SELECT principal_id
       FROM memberships
       WHERE tenant_id = $1 AND principal_id = $2 AND status = 'active'`,
      [transaction.context.tenantId, input.assigneePrincipalId],
    );
    if (!assignee.rows[0]) {
      throw new WorkspaceTaskError(
        "WORKSPACE_TASK_INPUT_INVALID",
        "Assignee must be an active tenant member",
      );
    }

    const taskId = input.taskId ?? randomUUID();
    const inserted = await transaction.client.query<WorkspaceTaskRow>(
      `INSERT INTO workspace_tasks
         (task_id, tenant_id, created_by_principal_id, assignee_principal_id,
          title, description, due_on, idempotency_key, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, created_by_principal_id, idempotency_key) DO NOTHING
       RETURNING ${WORKSPACE_TASK_COLUMNS}`,
      [
        taskId,
        transaction.context.tenantId,
        transaction.context.actorPrincipalId,
        input.assigneePrincipalId,
        title,
        description,
        dueOn,
        idempotencyKey,
        transaction.context.correlationId,
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      const concurrentReplay = await findExistingCreate(
        transaction,
        input,
        title,
        description,
        dueOn,
      );
      if (!concurrentReplay) {
        throw new WorkspaceTaskError(
          "WORKSPACE_TASK_IDEMPOTENCY_CONFLICT",
          "Concurrent task creation was not visible",
        );
      }
      return commandResult(concurrentReplay, true);
    }

    await createWorkItem(transaction, {
      assigneePrincipalId: row.assignee_principal_id,
      subjectId: row.task_id,
      subjectType: WORKSPACE_TASK_SUBJECT_TYPE,
      workType: WORKSPACE_TASK_WORK_TYPE,
    });
    await recordMutationProof(transaction, {
      evidence: {
        eventType: "evidence.workspace.task.created",
        newState: "open",
        priorState: null,
        subjectId: row.task_id,
        subjectType: WORKSPACE_TASK_SUBJECT_TYPE,
      },
      outbox: {
        aggregateId: row.task_id,
        aggregateType: WORKSPACE_TASK_SUBJECT_TYPE,
        aggregateVersion: row.version,
        eventType: "workspace.task.created",
        payload: {
          assigneePrincipalId: row.assignee_principal_id,
          taskId: row.task_id,
          title: row.title,
          version: row.version,
        },
      },
    });
    return commandResult(row, false);
  });
}

async function findCompleteReplay(
  transaction: TenantTransaction,
  row: WorkspaceTaskRow,
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
       AND e.event_type = 'evidence.workspace.task.completed'
       AND e.correlation_id = $4 AND e.actor_principal_id = $5
       AND e.prior_state = 'open' AND e.new_state = 'completed'
       AND o.event_type = 'workspace.task.completed' AND o.aggregate_version = $6`,
    [
      transaction.context.tenantId,
      WORKSPACE_TASK_SUBJECT_TYPE,
      row.task_id,
      transaction.context.correlationId,
      transaction.context.actorPrincipalId,
      row.version,
    ],
  );
  return result.rowCount === 1;
}

export async function completeWorkspaceTask(
  pool: Pool,
  context: OperationContext,
  input: CompleteWorkspaceTaskInput,
): Promise<WorkspaceTaskCommandResult> {
  assertUuid(input.taskId, "taskId");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new WorkspaceTaskError(
      "WORKSPACE_TASK_INPUT_INVALID",
      "Expected version must be a positive integer",
    );
  }
  const completionNote = normalizeOptionalText(input.completionNote, "completion note", 2000);

  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireWorkspaceTaskServiceActive(transaction);
    const row = await selectTaskForUpdate(transaction, input.taskId);
    authorizeWorkspaceTaskAction(transaction, "workspace.task.complete", row.task_id, row, [
      {
        effect: "allow",
        id: "assignee_complete_task",
        matches: (task, actor) => task.assignee_principal_id === actor.principalId,
      },
    ]);

    if (row.status === "completed" && (await findCompleteReplay(transaction, row))) {
      if (row.completion_note !== completionNote) {
        throw new WorkspaceTaskError(
          "WORKSPACE_TASK_IDEMPOTENCY_CONFLICT",
          "Completion retry changed the completion note",
        );
      }
      return commandResult(row, true);
    }
    if (row.status !== "open") {
      throw new WorkspaceTaskError("WORKSPACE_TASK_STATE_CONFLICT", "Completed task is immutable", {
        status: row.status,
      });
    }
    if (row.version !== input.expectedVersion) {
      throw new WorkspaceTaskError("WORKSPACE_TASK_VERSION_CONFLICT", "Task version is stale", {
        actualVersion: row.version,
        expectedVersion: input.expectedVersion,
      });
    }
    const noteRequired = await resolveSetting(
      transaction,
      workspaceTaskSettings.completionNoteRequired,
    );
    if (noteRequired.value && completionNote === null) {
      throw new WorkspaceTaskError(
        "WORKSPACE_TASK_INPUT_INVALID",
        "Completion note is required by tenant policy",
      );
    }

    const updated = await transaction.client.query<WorkspaceTaskRow>(
      `UPDATE workspace_tasks
       SET status = 'completed', completion_note = $3, completed_at = now(),
           updated_at = now(), version = version + 1
       WHERE tenant_id = $1 AND task_id = $2 AND status = 'open' AND version = $4
       RETURNING ${WORKSPACE_TASK_COLUMNS}`,
      [transaction.context.tenantId, row.task_id, completionNote, input.expectedVersion],
    );
    const completed = updated.rows[0];
    if (!completed) {
      throw new WorkspaceTaskError("WORKSPACE_TASK_VERSION_CONFLICT", "Task changed concurrently");
    }
    const workItem = await transaction.client.query<{ work_item_id: string }>(
      `SELECT work_item_id
       FROM work_items
       WHERE tenant_id = $1 AND work_type = $2 AND subject_type = $3 AND subject_id = $4`,
      [
        transaction.context.tenantId,
        WORKSPACE_TASK_WORK_TYPE,
        WORKSPACE_TASK_SUBJECT_TYPE,
        row.task_id,
      ],
    );
    const workItemId = workItem.rows[0]?.work_item_id;
    if (!workItemId) {
      throw new WorkspaceTaskError("WORKSPACE_TASK_STATE_CONFLICT", "Task work item is missing");
    }
    await completeWorkItem(transaction, workItemId);
    await recordMutationProof(transaction, {
      evidence: {
        eventType: "evidence.workspace.task.completed",
        newState: "completed",
        priorState: "open",
        subjectId: row.task_id,
        subjectType: WORKSPACE_TASK_SUBJECT_TYPE,
      },
      outbox: {
        aggregateId: row.task_id,
        aggregateType: WORKSPACE_TASK_SUBJECT_TYPE,
        aggregateVersion: completed.version,
        eventType: "workspace.task.completed",
        payload: {
          status: "completed",
          taskId: row.task_id,
          version: completed.version,
        },
      },
    });
    return commandResult(completed, false);
  });
}
