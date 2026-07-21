export type HrWorkforceProfileErrorCode =
  | "WORKFORCE_PROFILE_IDEMPOTENCY_CONFLICT"
  | "WORKFORCE_PROFILE_INPUT_INVALID"
  | "WORKFORCE_PROFILE_NOT_FOUND"
  | "WORKFORCE_PROFILE_PRINCIPAL_UNAVAILABLE"
  | "WORKFORCE_PROFILE_SERVICE_INACTIVE"
  | "WORKFORCE_PROFILE_STATE_CONFLICT"
  | "WORKFORCE_PROFILE_VERSION_CONFLICT";

export class HrWorkforceProfileError extends Error {
  readonly code: HrWorkforceProfileErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: HrWorkforceProfileErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HrWorkforceProfileError";
    this.code = code;
    this.details = details;
  }
}
