import {
  type ApiProblemDetails,
  type HrLeaveCategoryCode,
  type HrLeaveRequest,
  type HrSubmitLeaveRequestBody,
  parseApiProblemDetails,
  parseHrLeaveRequest,
} from "@esbla/contracts/hr-leave-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = new Set<HrLeaveCategoryCode>(["annual", "other", "sick", "unpaid"]);
const SUBMISSION_KEYS = ["categoryCode", "endDate", "idempotencyKey", "reason", "startDate"];
const SUBMISSION_FIELDS = new Set<HrLeaveSubmitField>([
  "categoryCode",
  "endDate",
  "reason",
  "startDate",
]);

export type HrLeaveSubmitField = "categoryCode" | "endDate" | "reason" | "startDate";
export type HrLeaveSubmitFailureKind =
  | "conflict"
  | "forbidden"
  | "identity_unavailable"
  | "invalid_input"
  | "manager_required"
  | "reason_required"
  | "service_inactive"
  | "unavailable";

export interface HrLeaveSubmitFormState {
  readonly fieldErrors: Readonly<Partial<Record<HrLeaveSubmitField, string>>>;
  readonly message?: string;
  readonly status: "error" | "idle";
}

export interface HrLeaveSubmissionInput {
  readonly body: HrSubmitLeaveRequestBody;
  readonly idempotencyKey: string;
}

export type HrLeaveSubmissionValidation =
  | { readonly ok: false; readonly state: HrLeaveSubmitFormState }
  | { readonly ok: true; readonly value: HrLeaveSubmissionInput };

export type HrLeaveSubmitTransport =
  | { readonly ok: false; readonly state: HrLeaveSubmitFormState }
  | { readonly ok: true };

export const INITIAL_HR_LEAVE_SUBMIT_STATE: HrLeaveSubmitFormState = {
  fieldErrors: {},
  status: "idle",
};

export class HrLeaveSubmitError extends Error {
  constructor(readonly kind: HrLeaveSubmitFailureKind) {
    super("The leave request could not be submitted");
    this.name = "HrLeaveSubmitError";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : null;
}

export function validateHrLeaveSubmission(payload: unknown): HrLeaveSubmissionValidation {
  if (!isRecord(payload) || !hasExactKeys(payload, SUBMISSION_KEYS)) {
    return {
      ok: false,
      state: { fieldErrors: {}, message: "Review your request and try again.", status: "error" },
    };
  }
  const categoryCode = readText(payload, "categoryCode");
  const endDate = readText(payload, "endDate");
  const idempotencyKey = readText(payload, "idempotencyKey");
  const reason = readText(payload, "reason");
  const startDate = readText(payload, "startDate");
  const fieldErrors: Partial<Record<HrLeaveSubmitField, string>> = {};

  if (!categoryCode || !CATEGORIES.has(categoryCode as HrLeaveCategoryCode)) {
    fieldErrors.categoryCode = "Choose a leave type.";
  }
  if (!startDate || !isCalendarDate(startDate)) {
    fieldErrors.startDate = "Enter a valid start date.";
  }
  if (!endDate || !isCalendarDate(endDate)) {
    fieldErrors.endDate = "Enter a valid end date.";
  } else if (startDate && isCalendarDate(startDate) && endDate < startDate) {
    fieldErrors.endDate = "End date cannot be before start date.";
  }
  if (reason !== null && reason.length > 2000) {
    fieldErrors.reason = "Reason must be 2,000 characters or fewer.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      state: { fieldErrors, message: "Review the highlighted fields.", status: "error" },
    };
  }
  if (!idempotencyKey || !UUID_PATTERN.test(idempotencyKey)) {
    return {
      ok: false,
      state: {
        fieldErrors: {},
        message: "This form expired. Refresh the page and try again.",
        status: "error",
      },
    };
  }

  return {
    ok: true,
    value: {
      body: {
        categoryCode: categoryCode as HrLeaveCategoryCode,
        endDate: endDate as string,
        ...(reason ? { reason } : {}),
        startDate: startDate as string,
      },
      idempotencyKey,
    },
  };
}

function failureKind(problem: ApiProblemDetails): HrLeaveSubmitFailureKind {
  if (
    problem.code === "LEAVE_INPUT_INVALID" &&
    problem.detail === "Leave reason is required by tenant policy"
  ) {
    return "reason_required";
  }
  if (problem.code === "LEAVE_INPUT_INVALID" || problem.code === "REQUEST_VALIDATION_FAILED") {
    return "invalid_input";
  }
  if (problem.code === "LEAVE_MANAGER_REQUIRED") return "manager_required";
  if (problem.code === "LEAVE_SERVICE_INACTIVE") return "service_inactive";
  if (problem.code === "AUTH_REQUIRED") return "identity_unavailable";
  if (problem.code === "POLICY_DENIED" || problem.status === 403) return "forbidden";
  if (problem.code === "LEAVE_IDEMPOTENCY_CONFLICT" || problem.status === 409) return "conflict";
  return "unavailable";
}

export async function decodeSubmitLeaveRequestResponse(
  responsePromise: Promise<Response>,
): Promise<HrLeaveRequest> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrLeaveSubmitError("unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HrLeaveSubmitError("unavailable");
  }

  if (response.status === 200 || response.status === 201) {
    try {
      return parseHrLeaveRequest(payload);
    } catch {
      throw new HrLeaveSubmitError("unavailable");
    }
  }

  try {
    const problem = parseApiProblemDetails(payload);
    if (problem.status !== response.status) throw new HrLeaveSubmitError("unavailable");
    throw new HrLeaveSubmitError(failureKind(problem));
  } catch (error) {
    if (error instanceof HrLeaveSubmitError) throw error;
    throw new HrLeaveSubmitError("unavailable");
  }
}

export function submitFormStateForError(error: unknown): HrLeaveSubmitFormState {
  const kind = error instanceof HrLeaveSubmitError ? error.kind : "unavailable";
  if (kind === "reason_required") {
    return {
      fieldErrors: { reason: "Reason is required by your tenant policy." },
      message: "Review the highlighted field.",
      status: "error",
    };
  }
  const messages: Record<Exclude<HrLeaveSubmitFailureKind, "reason_required">, string> = {
    conflict: "This form could not be safely replayed. Refresh the page and try again.",
    forbidden: "You do not have permission to submit this request.",
    identity_unavailable: "Your local identity is unavailable. Refresh the page and try again.",
    invalid_input: "Review your request and try again.",
    manager_required: "An active manager must be assigned before you can submit.",
    service_inactive: "Leave requests are not available right now.",
    unavailable: "We could not submit your request. Try again.",
  };
  return { fieldErrors: {}, message: messages[kind], status: "error" };
}

export function isSameOriginSubmission(
  requestUrl: string,
  origin: string | null,
  fetchSite: string | null,
  host: string | null = null,
): boolean {
  if (!origin || (fetchSite !== null && fetchSite !== "same-origin")) return false;
  try {
    const originUrl = new URL(origin);
    return (
      originUrl.origin === new URL(requestUrl).origin || originUrl.host === host?.toLowerCase()
    );
  } catch {
    return false;
  }
}

function parseFormState(value: unknown): HrLeaveSubmitFormState {
  if (!isRecord(value) || !hasExactKeys(value, ["fieldErrors", "message", "status"])) {
    throw new TypeError("Submit form state is invalid");
  }
  if (
    value.status !== "error" ||
    typeof value.message !== "string" ||
    !isRecord(value.fieldErrors)
  ) {
    throw new TypeError("Submit form state is invalid");
  }
  for (const [key, message] of Object.entries(value.fieldErrors)) {
    if (!SUBMISSION_FIELDS.has(key as HrLeaveSubmitField) || typeof message !== "string") {
      throw new TypeError("Submit form field errors are invalid");
    }
  }
  return value as unknown as HrLeaveSubmitFormState;
}

export function parseHrLeaveSubmitTransport(value: unknown): HrLeaveSubmitTransport {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("Submit response is invalid");
  }
  if (value.ok) {
    if (!hasExactKeys(value, ["ok"])) throw new TypeError("Submit response is invalid");
    return { ok: true };
  }
  if (!hasExactKeys(value, ["ok", "state"])) throw new TypeError("Submit response is invalid");
  return { ok: false, state: parseFormState(value.state) };
}
