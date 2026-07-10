export type HrLeaveErrorCode =
  | "LEAVE_IDEMPOTENCY_CONFLICT"
  | "LEAVE_INPUT_INVALID"
  | "LEAVE_MANAGER_REQUIRED"
  | "LEAVE_NOT_FOUND"
  | "LEAVE_SERVICE_INACTIVE"
  | "LEAVE_STATE_CONFLICT"
  | "LEAVE_VERSION_CONFLICT";

export class HrLeaveError extends Error {
  readonly code: HrLeaveErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: HrLeaveErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HrLeaveError";
    this.code = code;
    this.details = details;
  }
}
