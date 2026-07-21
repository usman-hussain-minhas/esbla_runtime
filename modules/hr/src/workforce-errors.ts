export type HrWorkforceProfileErrorCode =
  | "WORKFORCE_INPUT_INVALID"
  | "WORKFORCE_PRINCIPAL_INELIGIBLE"
  | "WORKFORCE_PROFILE_CONFLICT"
  | "WORKFORCE_PROFILE_NOT_FOUND"
  | "WORKFORCE_SERVICE_CONTROL_NOT_FOUND"
  | "WORKFORCE_SERVICE_INACTIVE"
  | "WORKFORCE_VERSION_CONFLICT";

export class HrWorkforceProfileError extends Error {
  constructor(
    readonly code: HrWorkforceProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HrWorkforceProfileError";
  }
}

export const workforceInputInvalid = (message: string) =>
  new HrWorkforceProfileError("WORKFORCE_INPUT_INVALID", message);
export const workforceProfileConflict = (
  message = "Workforce Profile state conflicts with the request",
) => new HrWorkforceProfileError("WORKFORCE_PROFILE_CONFLICT", message);
export const workforceProfileNotFound = (message = "Workforce Profile was not found") =>
  new HrWorkforceProfileError("WORKFORCE_PROFILE_NOT_FOUND", message);
export const workforceVersionConflict = () =>
  new HrWorkforceProfileError(
    "WORKFORCE_VERSION_CONFLICT",
    "Workforce Profile version conflicts with the request",
  );
