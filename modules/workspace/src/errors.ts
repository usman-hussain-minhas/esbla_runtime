export type WorkspaceTaskErrorCode =
  | "WORKSPACE_TASK_IDEMPOTENCY_CONFLICT"
  | "WORKSPACE_TASK_INPUT_INVALID"
  | "WORKSPACE_TASK_NOT_FOUND"
  | "WORKSPACE_TASK_SERVICE_INACTIVE"
  | "WORKSPACE_TASK_STATE_CONFLICT"
  | "WORKSPACE_TASK_VERSION_CONFLICT";

export class WorkspaceTaskError extends Error {
  readonly code: WorkspaceTaskErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: WorkspaceTaskErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceTaskError";
    this.code = code;
    this.details = details;
  }
}
