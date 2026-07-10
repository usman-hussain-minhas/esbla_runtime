export const WORKSPACE_TASK_SERVICE_KEY = "workspace.task";
export const WORKSPACE_TASK_SUBJECT_TYPE = "workspace.task";
export const WORKSPACE_TASK_WORK_TYPE = "workspace.task.assignment";
export const WORKSPACE_TASK_BILLING_STATE = "non_billable" as const;

export type WorkspaceTaskStatus = "completed" | "open";

export interface WorkspaceTask {
  readonly assigneePrincipalId: string;
  readonly completedAt: string | null;
  readonly completionNote: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly description: string | null;
  readonly dueOn: string | null;
  readonly idempotencyKey: string;
  readonly status: WorkspaceTaskStatus;
  readonly taskId: string;
  readonly tenantId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CreateWorkspaceTaskInput {
  readonly assigneePrincipalId: string;
  readonly description?: string | null;
  readonly dueOn?: string | null;
  readonly idempotencyKey: string;
  readonly taskId?: string;
  readonly title: string;
}

export interface CompleteWorkspaceTaskInput {
  readonly completionNote?: string | null;
  readonly expectedVersion: number;
  readonly taskId: string;
}

export interface WorkspaceTaskCommandResult {
  readonly billingState: typeof WORKSPACE_TASK_BILLING_STATE;
  readonly replayed: boolean;
  readonly task: WorkspaceTask;
}

export interface WorkspaceTaskCursor {
  readonly createdAt: string;
  readonly taskId: string;
}

export interface AssignedWorkspaceTaskSummary {
  readonly createdAt: string;
  readonly createdByDisplayName: string;
  readonly description: string | null;
  readonly dueOn: string | null;
  readonly taskId: string;
  readonly title: string;
  readonly version: number;
  readonly workItemId: string;
}

export interface WorkspaceTaskEvidenceEvent {
  readonly eventType: "evidence.workspace.task.completed" | "evidence.workspace.task.created";
  readonly newState: WorkspaceTaskStatus;
  readonly occurredAt: string;
  readonly priorState: "open" | null;
}

export interface WorkspaceTaskDetail {
  readonly history: readonly WorkspaceTaskEvidenceEvent[];
  readonly task: WorkspaceTask;
}
