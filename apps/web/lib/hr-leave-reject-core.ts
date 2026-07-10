import {
  type ApiProblemDetails,
  type HrDecideLeaveRequestBody,
  type HrLeaveRequest,
  parseApiProblemDetails,
  parseHrLeaveRequest,
} from "@esbla/contracts/hr-leave-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REJECTION_KEYS = ["decisionNote", "expectedVersion", "idempotencyKey"] as const;
const REJECTION_FIELDS = new Set<HrLeaveRejectField>(["decisionNote"]);

export type HrLeaveRejectField = "decisionNote";
export type HrLeaveRejectFailureKind =
  | "conflict"
  | "forbidden"
  | "identity_unavailable"
  | "invalid_input"
  | "not_found"
  | "note_required"
  | "service_inactive"
  | "unavailable";

export interface HrLeaveRejectFormState {
  readonly fieldErrors: Readonly<Partial<Record<HrLeaveRejectField, string>>>;
  readonly message?: string;
  readonly status: "error" | "idle";
}

export interface HrLeaveRejectionInput {
  readonly body: HrDecideLeaveRequestBody;
  readonly idempotencyKey: string;
}

export type HrLeaveRejectionValidation =
  | { readonly ok: false; readonly state: HrLeaveRejectFormState }
  | { readonly ok: true; readonly value: HrLeaveRejectionInput };

export type HrLeaveRejectTransport =
  | { readonly leaveRequestId: string; readonly ok: true }
  | { readonly ok: false; readonly state: HrLeaveRejectFormState };

export const INITIAL_HR_LEAVE_REJECT_STATE: HrLeaveRejectFormState = {
  fieldErrors: {},
  status: "idle",
};

export class HrLeaveRejectError extends Error {
  constructor(readonly kind: HrLeaveRejectFailureKind) {
    super("The leave request could not be rejected");
    this.name = "HrLeaveRejectError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateHrLeaveRejection(payload: unknown): HrLeaveRejectionValidation {
  if (!isRecord(payload) || !hasExactKeys(payload, REJECTION_KEYS)) {
    return {
      ok: false,
      state: {
        fieldErrors: {},
        message: "This rejection request is invalid. Refresh My Work.",
        status: "error",
      },
    };
  }
  if (!Number.isSafeInteger(payload.expectedVersion) || (payload.expectedVersion as number) < 1) {
    return {
      ok: false,
      state: {
        fieldErrors: {},
        message: "This request changed. Refresh My Work.",
        status: "error",
      },
    };
  }
  if (typeof payload.idempotencyKey !== "string" || !UUID_PATTERN.test(payload.idempotencyKey)) {
    return {
      ok: false,
      state: {
        fieldErrors: {},
        message: "This rejection expired. Refresh My Work.",
        status: "error",
      },
    };
  }
  if (typeof payload.decisionNote !== "string") {
    return {
      ok: false,
      state: {
        fieldErrors: { decisionNote: "Enter a valid decision note." },
        message: "Review the highlighted field.",
        status: "error",
      },
    };
  }
  const decisionNote = payload.decisionNote.trim();
  if (decisionNote.length > 2000) {
    return {
      ok: false,
      state: {
        fieldErrors: { decisionNote: "Decision note must be 2,000 characters or fewer." },
        message: "Review the highlighted field.",
        status: "error",
      },
    };
  }
  return {
    ok: true,
    value: {
      body: {
        ...(decisionNote ? { decisionNote } : {}),
        expectedVersion: payload.expectedVersion as number,
      },
      idempotencyKey: payload.idempotencyKey,
    },
  };
}

export function buildRejectLeaveRequestPath(leaveRequestId: string): string {
  if (!UUID_PATTERN.test(leaveRequestId)) throw new HrLeaveRejectError("invalid_input");
  return `/v1/hr/leave-requests/${encodeURIComponent(leaveRequestId)}/reject`;
}

function failureKind(problem: ApiProblemDetails): HrLeaveRejectFailureKind {
  if (
    problem.code === "LEAVE_INPUT_INVALID" &&
    problem.detail === "Rejection note is required by tenant policy"
  ) {
    return "note_required";
  }
  if (problem.code === "LEAVE_NOT_FOUND" || problem.status === 404) return "not_found";
  if (problem.code === "LEAVE_SERVICE_INACTIVE") return "service_inactive";
  if (problem.code.startsWith("AUTH_") || problem.status === 401) return "identity_unavailable";
  if (problem.code === "POLICY_DENIED" || problem.status === 403) return "forbidden";
  if (
    problem.code === "LEAVE_IDEMPOTENCY_CONFLICT" ||
    problem.code === "LEAVE_STATE_CONFLICT" ||
    problem.code === "LEAVE_VERSION_CONFLICT" ||
    problem.status === 409
  ) {
    return "conflict";
  }
  if (
    problem.code === "LEAVE_INPUT_INVALID" ||
    problem.code === "REQUEST_VALIDATION_FAILED" ||
    problem.status === 400
  ) {
    return "invalid_input";
  }
  return "unavailable";
}

export async function decodeRejectLeaveRequestResponse(
  responsePromise: Promise<Response>,
  leaveRequestId: string,
  expectedVersion: number,
  expectedDecisionNote: string | null,
): Promise<HrLeaveRequest> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrLeaveRejectError("unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HrLeaveRejectError("unavailable");
  }

  if (response.status === 200) {
    try {
      const rejected = parseHrLeaveRequest(payload);
      if (
        rejected.leaveRequestId !== leaveRequestId ||
        rejected.status !== "rejected" ||
        rejected.version !== expectedVersion + 1 ||
        rejected.decidedAt === null ||
        rejected.decisionNote !== expectedDecisionNote
      ) {
        throw new TypeError("Rejection response does not prove the requested transition");
      }
      return rejected;
    } catch {
      throw new HrLeaveRejectError("unavailable");
    }
  }

  try {
    const problem = parseApiProblemDetails(payload);
    if (problem.status !== response.status) throw new HrLeaveRejectError("unavailable");
    throw new HrLeaveRejectError(failureKind(problem));
  } catch (error) {
    if (error instanceof HrLeaveRejectError) throw error;
    throw new HrLeaveRejectError("unavailable");
  }
}

export function rejectFormStateForError(error: unknown): HrLeaveRejectFormState {
  const kind = error instanceof HrLeaveRejectError ? error.kind : "unavailable";
  if (kind === "note_required") {
    return {
      fieldErrors: { decisionNote: "A decision note is required by your tenant policy." },
      message: "Review the highlighted field.",
      status: "error",
    };
  }
  const messages: Record<Exclude<HrLeaveRejectFailureKind, "note_required">, string> = {
    conflict: "This request changed or was already decided. Refresh My Work.",
    forbidden: "You are not allowed to reject this request.",
    identity_unavailable: "Your local identity is unavailable. Refresh My Work.",
    invalid_input: "Review the rejection and try again.",
    not_found: "This request is no longer available.",
    service_inactive: "Leave decisions are not available right now.",
    unavailable: "We could not reject this request. Try again.",
  };
  return { fieldErrors: {}, message: messages[kind], status: "error" };
}

function parseFormState(value: unknown): HrLeaveRejectFormState {
  if (!isRecord(value) || !hasExactKeys(value, ["fieldErrors", "message", "status"])) {
    throw new TypeError("Rejection form state is invalid");
  }
  if (
    value.status !== "error" ||
    typeof value.message !== "string" ||
    !isRecord(value.fieldErrors)
  ) {
    throw new TypeError("Rejection form state is invalid");
  }
  for (const [key, message] of Object.entries(value.fieldErrors)) {
    if (!REJECTION_FIELDS.has(key as HrLeaveRejectField) || typeof message !== "string") {
      throw new TypeError("Rejection form field errors are invalid");
    }
  }
  return value as unknown as HrLeaveRejectFormState;
}

export function parseHrLeaveRejectTransport(value: unknown): HrLeaveRejectTransport {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("Rejection response is invalid");
  }
  if (value.ok) {
    if (
      !hasExactKeys(value, ["leaveRequestId", "ok"]) ||
      typeof value.leaveRequestId !== "string" ||
      !UUID_PATTERN.test(value.leaveRequestId)
    ) {
      throw new TypeError("Rejection response is invalid");
    }
    return { leaveRequestId: value.leaveRequestId, ok: true };
  }
  if (!hasExactKeys(value, ["ok", "state"])) {
    throw new TypeError("Rejection response is invalid");
  }
  return { ok: false, state: parseFormState(value.state) };
}
