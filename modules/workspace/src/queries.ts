import {
  type OperationContext,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import {
  assertTimestamp,
  assertUuid,
  authorizeTaskView,
  authorizeWorkspaceTaskAction,
  mapWorkspaceTaskRow,
  requireWorkspaceTaskServiceActive,
  validatePageSize,
  WORKSPACE_TASK_COLUMNS,
  type WorkspaceTaskRow,
} from "./internal.js";
import {
  type AssignedWorkspaceTaskSummary,
  WORKSPACE_TASK_SUBJECT_TYPE,
  WORKSPACE_TASK_WORK_TYPE,
  type WorkspaceTask,
  type WorkspaceTaskCursor,
  type WorkspaceTaskDetail,
  type WorkspaceTaskEvidenceEvent,
} from "./types.js";

type AssignedTaskRow = WorkspaceTaskRow & {
  created_by_display_name: string;
  work_item_id: string;
};

function mapAssignedTaskRow(row: AssignedTaskRow): AssignedWorkspaceTaskSummary {
  return {
    createdAt: row.created_at,
    createdByDisplayName: row.created_by_display_name,
    description: row.description,
    dueOn: row.due_on,
    taskId: row.task_id,
    title: row.title,
    version: row.version,
    workItemId: row.work_item_id,
  };
}

async function selectTask(
  transaction: TenantTransaction,
  taskId: string,
): Promise<WorkspaceTaskRow | null> {
  const result = await transaction.client.query<WorkspaceTaskRow>(
    `SELECT ${WORKSPACE_TASK_COLUMNS}
     FROM workspace_tasks
     WHERE tenant_id = $1 AND task_id = $2`,
    [transaction.context.tenantId, taskId],
  );
  return result.rows[0] ?? null;
}

type EvidenceRow = {
  event_type: WorkspaceTaskEvidenceEvent["eventType"];
  new_state: WorkspaceTaskEvidenceEvent["newState"];
  occurred_at: string;
  prior_state: WorkspaceTaskEvidenceEvent["priorState"];
};

function mapEvidenceRow(row: EvidenceRow): WorkspaceTaskEvidenceEvent {
  return {
    eventType: row.event_type,
    newState: row.new_state,
    occurredAt: row.occurred_at,
    priorState: row.prior_state,
  };
}

async function selectEvidence(
  transaction: TenantTransaction,
  taskId: string,
): Promise<readonly WorkspaceTaskEvidenceEvent[]> {
  const result = await transaction.client.query<EvidenceRow>(
    `SELECT event_type, prior_state, new_state,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
     FROM evidence_events
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
     ORDER BY occurred_at ASC, evidence_event_id ASC
     LIMIT 100`,
    [transaction.context.tenantId, WORKSPACE_TASK_SUBJECT_TYPE, taskId],
  );
  return result.rows.map(mapEvidenceRow);
}

export async function getWorkspaceTask(
  pool: Pool,
  context: OperationContext,
  taskId: string,
): Promise<WorkspaceTask | null> {
  assertUuid(taskId, "taskId");
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireWorkspaceTaskServiceActive(transaction);
    const row = await selectTask(transaction, taskId);
    if (!row) return null;
    authorizeTaskView(transaction, row);
    return mapWorkspaceTaskRow(row);
  });
}

export async function getWorkspaceTaskDetail(
  pool: Pool,
  context: OperationContext,
  taskId: string,
): Promise<WorkspaceTaskDetail | null> {
  assertUuid(taskId, "taskId");
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireWorkspaceTaskServiceActive(transaction);
    const row = await selectTask(transaction, taskId);
    if (!row) return null;
    authorizeTaskView(transaction, row);
    return { history: await selectEvidence(transaction, taskId), task: mapWorkspaceTaskRow(row) };
  });
}

export async function listAssignedWorkspaceTasks(
  pool: Pool,
  context: OperationContext,
  options: { readonly cursor?: WorkspaceTaskCursor; readonly pageSize?: number } = {},
): Promise<readonly AssignedWorkspaceTaskSummary[]> {
  const pageSize = validatePageSize(options.pageSize ?? 50, 50);
  if (options.cursor) {
    assertUuid(options.cursor.taskId, "cursor.taskId");
    assertTimestamp(options.cursor.createdAt, "cursor.createdAt");
  }
  return await withTenantTransaction(pool, context, async (transaction) => {
    await requireWorkspaceTaskServiceActive(transaction);
    authorizeWorkspaceTaskAction(transaction, "workspace.task.list_assigned", "assigned", {}, [
      { effect: "allow", id: "assignee_list_assigned_tasks", matches: () => true },
    ]);
    const cursor = options.cursor;
    const result = cursor
      ? await transaction.client.query<AssignedTaskRow>(
          `WITH assigned_tasks AS (
             SELECT task.*, work.work_item_id,
                    principal.display_name AS created_by_display_name
             FROM workspace_tasks task
             JOIN work_items work
               ON work.tenant_id = task.tenant_id
              AND work.subject_id = task.task_id
             JOIN principals principal
               ON principal.principal_id = task.created_by_principal_id
             WHERE task.tenant_id = $1
               AND task.assignee_principal_id = $2
               AND task.status = 'open'
               AND work.assignee_principal_id = $2
               AND work.work_type = $3
               AND work.subject_type = $4
               AND work.status = 'open'
               AND (task.created_at, task.task_id) > ($5::timestamptz, $6::uuid)
             ORDER BY task.created_at ASC, task.task_id ASC
             LIMIT $7
           )
           SELECT ${WORKSPACE_TASK_COLUMNS}, work_item_id, created_by_display_name
           FROM assigned_tasks
           ORDER BY created_at ASC, task_id ASC`,
          [
            transaction.context.tenantId,
            transaction.context.actorPrincipalId,
            WORKSPACE_TASK_WORK_TYPE,
            WORKSPACE_TASK_SUBJECT_TYPE,
            cursor.createdAt,
            cursor.taskId,
            pageSize,
          ],
        )
      : await transaction.client.query<AssignedTaskRow>(
          `WITH assigned_tasks AS (
             SELECT task.*, work.work_item_id,
                    principal.display_name AS created_by_display_name
             FROM workspace_tasks task
             JOIN work_items work
               ON work.tenant_id = task.tenant_id
              AND work.subject_id = task.task_id
             JOIN principals principal
               ON principal.principal_id = task.created_by_principal_id
             WHERE task.tenant_id = $1
               AND task.assignee_principal_id = $2
               AND task.status = 'open'
               AND work.assignee_principal_id = $2
               AND work.work_type = $3
               AND work.subject_type = $4
               AND work.status = 'open'
             ORDER BY task.created_at ASC, task.task_id ASC
             LIMIT $5
           )
           SELECT ${WORKSPACE_TASK_COLUMNS}, work_item_id, created_by_display_name
           FROM assigned_tasks
           ORDER BY created_at ASC, task_id ASC`,
          [
            transaction.context.tenantId,
            transaction.context.actorPrincipalId,
            WORKSPACE_TASK_WORK_TYPE,
            WORKSPACE_TASK_SUBJECT_TYPE,
            pageSize,
          ],
        );
    return result.rows.map(mapAssignedTaskRow);
  });
}
