import {
  assertPolicyAllowed,
  evaluatePolicy,
  getServiceActivation,
  type PolicyRule,
  type TenantTransaction,
} from "@esbla/platform-core";
import { WorkspaceTaskError } from "./errors.js";
import {
  WORKSPACE_TASK_SERVICE_KEY,
  type WorkspaceTask,
  type WorkspaceTaskStatus,
} from "./types.js";

export interface WorkspaceTaskRow {
  assignee_principal_id: string;
  completed_at: string | null;
  completion_note: string | null;
  correlation_id: string;
  created_at: string;
  created_by_principal_id: string;
  description: string | null;
  due_on: string | null;
  idempotency_key: string;
  status: WorkspaceTaskStatus;
  task_id: string;
  tenant_id: string;
  title: string;
  updated_at: string;
  version: number;
}

export const WORKSPACE_TASK_COLUMNS = `task_id, tenant_id, created_by_principal_id,
  assignee_principal_id, title, description, status, due_on::text AS due_on,
  completion_note, idempotency_key, correlation_id, version,
  CASE WHEN completed_at IS NULL THEN NULL ELSE
    to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS completed_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mapWorkspaceTaskRow(row: WorkspaceTaskRow): WorkspaceTask {
  return {
    assigneePrincipalId: row.assignee_principal_id,
    completedAt: row.completed_at,
    completionNote: row.completion_note,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    createdByPrincipalId: row.created_by_principal_id,
    description: row.description,
    dueOn: row.due_on,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    taskId: row.task_id,
    tenantId: row.tenant_id,
    title: row.title,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new WorkspaceTaskError("WORKSPACE_TASK_INPUT_INVALID", `${field} must be a UUID`, {
      field,
    });
  }
}

export function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new WorkspaceTaskError(
      "WORKSPACE_TASK_INPUT_INVALID",
      `${field} must be an ISO timestamp`,
      { field },
    );
  }
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function normalizeRequiredText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new WorkspaceTaskError(
      "WORKSPACE_TASK_INPUT_INVALID",
      `${field} must contain 1 to ${maximum} characters`,
      { field },
    );
  }
  return normalized;
}

export function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeRequiredText(value, field, maximum);
}

export function normalizeOptionalDate(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (!isCalendarDate(normalized)) {
    throw new WorkspaceTaskError("WORKSPACE_TASK_INPUT_INVALID", `${field} must be a date`, {
      field,
    });
  }
  return normalized;
}

export async function requireWorkspaceTaskServiceActive(
  transaction: TenantTransaction,
): Promise<void> {
  const activation = await getServiceActivation(transaction, WORKSPACE_TASK_SERVICE_KEY);
  if (activation?.state !== "active") {
    throw new WorkspaceTaskError(
      "WORKSPACE_TASK_SERVICE_INACTIVE",
      "Workspace Task service is inactive",
    );
  }
}

export function authorizeWorkspaceTaskAction<Input>(
  transaction: TenantTransaction,
  actionKey: string,
  resourceKey: string,
  input: Input,
  rules: readonly PolicyRule<Input>[],
): void {
  assertPolicyAllowed(
    evaluatePolicy({ actionKey, input, resourceKey, transaction }, rules),
    transaction,
    actionKey,
    resourceKey,
  );
}

export async function selectTaskForUpdate(
  transaction: TenantTransaction,
  taskId: string,
): Promise<WorkspaceTaskRow> {
  const result = await transaction.client.query<WorkspaceTaskRow>(
    `SELECT ${WORKSPACE_TASK_COLUMNS}
     FROM workspace_tasks
     WHERE tenant_id = $1 AND task_id = $2
     FOR UPDATE`,
    [transaction.context.tenantId, taskId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new WorkspaceTaskError("WORKSPACE_TASK_NOT_FOUND", "Workspace task was not found");
  }
  return row;
}

export function authorizeTaskView(transaction: TenantTransaction, row: WorkspaceTaskRow): void {
  authorizeWorkspaceTaskAction(transaction, "workspace.task.view", row.task_id, row, [
    {
      effect: "allow",
      id: "creator_view_task",
      matches: (task, actor) => task.created_by_principal_id === actor.principalId,
    },
    {
      effect: "allow",
      id: "assignee_view_task",
      matches: (task, actor) => task.assignee_principal_id === actor.principalId,
    },
  ]);
}

export function validatePageSize(pageSize: number, maximum: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maximum) {
    throw new WorkspaceTaskError(
      "WORKSPACE_TASK_INPUT_INVALID",
      `Page size must be between 1 and ${maximum}`,
    );
  }
  return pageSize;
}
