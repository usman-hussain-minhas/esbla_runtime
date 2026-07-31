export type PlatformErrorCode =
  | "ACTIVATION_CONFLICT"
  | "ACTIVATION_DEPENDENCY_BLOCKED"
  | "ACTOR_NOT_ACTIVE_MEMBER"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_OPERATION_CONTEXT"
  | "INVALID_SERVICE_KEY"
  | "NOTIFICATION_INPUT_INVALID"
  | "NOTIFICATION_NOT_FOUND"
  | "NOTIFICATION_VERSION_CONFLICT"
  | "POLICY_DENIED"
  | "SETTING_INVALID"
  | "SETTING_OVERRIDE_NOT_ALLOWED"
  | "WORK_ITEM_CONFLICT";

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PlatformErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.details = details;
  }
}
