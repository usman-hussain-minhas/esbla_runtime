import {
  type ApiProblemDetails,
  type HrDecideLeaveRequestBody,
  type HrLeaveRequest,
  parseApiProblemDetails,
  parseHrLeaveRequest,
} from "@esbla/contracts/hr-leave-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_KEYS = ["expectedVersion", "idempotencyKey"] as const;

export type HrLeaveApproveFailureKind =
  | "conflict"
  | "forbidden"
  | "identity_unavailable"
  | "invalid_input"
  | "not_found"
  | "service_inactive"
  | "unavailable";

export interface HrLeaveApproveFormState {
  readonly message?: string;
  readonly status: "error" | "idle";
}

export interface HrLeaveApprovalInput {
  readonly body: HrDecideLeaveRequestBody;
  readonly idempotencyKey: string;
}

export type HrLeaveApprovalValidation =
  | { readonly ok: false; readonly state: HrLeaveApproveFormState }
  | { readonly ok: true; readonly value: HrLeaveApprovalInput };

export type HrLeaveApproveTransport =
  | { readonly leaveRequestId: string; readonly ok: true }
  | { readonly ok: false; readonly state: HrLeaveApproveFormState };

export const INITIAL_HR_LEAVE_APPROVE_STATE: HrLeaveApproveFormState = { status: "idle" };

export class HrLeaveApproveError extends Error {
  constructor(readonly kind: HrLeaveApproveFailureKind) {
    super("The leave request could not be approved");
    this.name = "HrLeaveApproveError";
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

export function validateHrLeaveApproval(payload: unknown): HrLeaveApprovalValidation {
  if (!isRecord(payload) || !hasExactKeys(payload, APPROVAL_KEYS)) {
    return {
      ok: false,
      state: { message: "This approval request is invalid. Refresh My Work.", status: "error" },
    };
  }
  if (!Number.isSafeInteger(payload.expectedVersion) || (payload.expectedVersion as number) < 1) {
    return {
      ok: false,
      state: { message: "This request changed. Refresh My Work.", status: "error" },
    };
  }
  if (typeof payload.idempotencyKey !== "string" || !UUID_PATTERN.test(payload.idempotencyKey)) {
    return {
      ok: false,
      state: { message: "This approval expired. Refresh My Work.", status: "error" },
    };
  }
  return {
    ok: true,
    value: {
      body: { expectedVersion: payload.expectedVersion as number },
      idempotencyKey: payload.idempotencyKey,
    },
  };
}

export function buildApproveLeaveRequestPath(leaveRequestId: string): string {
  if (!UUID_PATTERN.test(leaveRequestId)) throw new HrLeaveApproveError("invalid_input");
  return `/v1/hr/leave-requests/${encodeURIComponent(leaveRequestId)}/approve`;
}

function failureKind(problem: ApiProblemDetails): HrLeaveApproveFailureKind {
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

export async function decodeApproveLeaveRequestResponse(
  responsePromise: Promise<Response>,
  leaveRequestId: string,
  expectedVersion: number,
): Promise<HrLeaveRequest> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrLeaveApproveError("unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HrLeaveApproveError("unavailable");
  }

  if (response.status === 200) {
    try {
      const approved = parseHrLeaveRequest(payload);
      if (
        approved.leaveRequestId !== leaveRequestId ||
        approved.status !== "approved" ||
        approved.version !== expectedVersion + 1 ||
        approved.decidedAt === null ||
        approved.decisionNote !== null
      ) {
        throw new TypeError("Approval response does not prove the requested transition");
      }
      return approved;
    } catch {
      throw new HrLeaveApproveError("unavailable");
    }
  }

  try {
    const problem = parseApiProblemDetails(payload);
    if (problem.status !== response.status) throw new HrLeaveApproveError("unavailable");
    throw new HrLeaveApproveError(failureKind(problem));
  } catch (error) {
    if (error instanceof HrLeaveApproveError) throw error;
    throw new HrLeaveApproveError("unavailable");
  }
}

export function approveFormStateForError(error: unknown): HrLeaveApproveFormState {
  const kind = error instanceof HrLeaveApproveError ? error.kind : "unavailable";
  const messages: Record<HrLeaveApproveFailureKind, string> = {
    conflict: "This request changed or was already decided. Refresh My Work.",
    forbidden: "You are not allowed to approve this request.",
    identity_unavailable: "Your local identity is unavailable. Refresh My Work.",
    invalid_input: "This approval request is invalid. Refresh My Work.",
    not_found: "This request is no longer available.",
    service_inactive: "Leave approvals are not available right now.",
    unavailable: "We could not approve this request. Try again.",
  };
  return { message: messages[kind], status: "error" };
}

function parseFormState(value: unknown): HrLeaveApproveFormState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["message", "status"]) ||
    value.status !== "error" ||
    typeof value.message !== "string"
  ) {
    throw new TypeError("Approval form state is invalid");
  }
  return value as unknown as HrLeaveApproveFormState;
}

export function parseHrLeaveApproveTransport(value: unknown): HrLeaveApproveTransport {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("Approval response is invalid");
  }
  if (value.ok) {
    if (
      !hasExactKeys(value, ["leaveRequestId", "ok"]) ||
      typeof value.leaveRequestId !== "string" ||
      !UUID_PATTERN.test(value.leaveRequestId)
    ) {
      throw new TypeError("Approval response is invalid");
    }
    return { leaveRequestId: value.leaveRequestId, ok: true };
  }
  if (!hasExactKeys(value, ["ok", "state"])) {
    throw new TypeError("Approval response is invalid");
  }
  return { ok: false, state: parseFormState(value.state) };
}
