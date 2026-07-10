import { type ApiProblemDetails, parseApiProblemDetails } from "@esbla/contracts/hr-leave-api";
import {
  parseWorkspaceTask,
  type WorkspaceCompleteTaskBody,
  type WorkspaceTask,
} from "@esbla/contracts/workspace-task-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETE_KEYS = ["completionNote", "expectedVersion", "idempotencyKey"] as const;

export type WorkspaceTaskCompleteFailureKind =
  | "conflict"
  | "forbidden"
  | "identity_unavailable"
  | "invalid_input"
  | "not_found"
  | "service_inactive"
  | "unavailable";

export interface WorkspaceTaskCompleteFormState {
  readonly fieldErrors: Readonly<Partial<Record<"completionNote", string>>>;
  readonly message?: string;
  readonly status: "error" | "idle";
}

export interface WorkspaceTaskCompletionInput {
  readonly body: WorkspaceCompleteTaskBody;
  readonly idempotencyKey: string;
}

export type WorkspaceTaskCompletionValidation =
  | { readonly ok: false; readonly state: WorkspaceTaskCompleteFormState }
  | { readonly ok: true; readonly value: WorkspaceTaskCompletionInput };

export type WorkspaceTaskCompleteTransport =
  | { readonly ok: false; readonly state: WorkspaceTaskCompleteFormState }
  | { readonly ok: true; readonly taskId: string };

export const INITIAL_WORKSPACE_TASK_COMPLETE_STATE: WorkspaceTaskCompleteFormState = {
  fieldErrors: {},
  status: "idle",
};

export class WorkspaceTaskCompleteError extends Error {
  constructor(readonly kind: WorkspaceTaskCompleteFailureKind) {
    super("The workspace task could not be completed");
    this.name = "WorkspaceTaskCompleteError";
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

export function validateWorkspaceTaskCompletion(
  payload: unknown,
): WorkspaceTaskCompletionValidation {
  if (!isRecord(payload) || !hasExactKeys(payload, COMPLETE_KEYS)) {
    return {
      ok: false,
      state: { fieldErrors: {}, message: "This completion request is invalid.", status: "error" },
    };
  }
  if (!Number.isSafeInteger(payload.expectedVersion) || (payload.expectedVersion as number) < 1) {
    return {
      ok: false,
      state: { fieldErrors: {}, message: "This task changed. Refresh My Work.", status: "error" },
    };
  }
  if (typeof payload.idempotencyKey !== "string" || !UUID_PATTERN.test(payload.idempotencyKey)) {
    return {
      ok: false,
      state: { fieldErrors: {}, message: "This action expired. Refresh My Work.", status: "error" },
    };
  }
  const completionNote =
    typeof payload.completionNote === "string" ? payload.completionNote.trim() : null;
  if (completionNote !== null && completionNote.length > 2000) {
    return {
      ok: false,
      state: {
        fieldErrors: { completionNote: "Completion note must be 2,000 characters or fewer." },
        message: "Review the highlighted field.",
        status: "error",
      },
    };
  }
  return {
    ok: true,
    value: {
      body: {
        ...(completionNote ? { completionNote } : {}),
        expectedVersion: payload.expectedVersion as number,
      },
      idempotencyKey: payload.idempotencyKey,
    },
  };
}

export function buildCompleteWorkspaceTaskPath(taskId: string): string {
  if (!UUID_PATTERN.test(taskId)) throw new WorkspaceTaskCompleteError("invalid_input");
  return `/v1/workspace/tasks/${encodeURIComponent(taskId)}/complete`;
}

function failureKind(problem: ApiProblemDetails): WorkspaceTaskCompleteFailureKind {
  if (problem.code === "WORKSPACE_TASK_NOT_FOUND" || problem.status === 404) return "not_found";
  if (problem.code === "WORKSPACE_TASK_SERVICE_INACTIVE") return "service_inactive";
  if (problem.code.startsWith("AUTH_") || problem.status === 401) return "identity_unavailable";
  if (problem.code === "POLICY_DENIED" || problem.status === 403) return "forbidden";
  if (
    problem.code === "WORKSPACE_TASK_IDEMPOTENCY_CONFLICT" ||
    problem.code === "WORKSPACE_TASK_STATE_CONFLICT" ||
    problem.code === "WORKSPACE_TASK_VERSION_CONFLICT" ||
    problem.status === 409
  ) {
    return "conflict";
  }
  if (
    problem.code === "WORKSPACE_TASK_INPUT_INVALID" ||
    problem.code === "REQUEST_VALIDATION_FAILED" ||
    problem.status === 400
  ) {
    return "invalid_input";
  }
  return "unavailable";
}

export async function decodeCompleteWorkspaceTaskResponse(
  responsePromise: Promise<Response>,
  taskId: string,
  expectedVersion: number,
): Promise<WorkspaceTask> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkspaceTaskCompleteError("unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WorkspaceTaskCompleteError("unavailable");
  }

  if (response.status === 200) {
    try {
      const completed = parseWorkspaceTask(payload);
      if (
        completed.taskId !== taskId ||
        completed.status !== "completed" ||
        completed.version !== expectedVersion + 1 ||
        completed.completedAt === null
      ) {
        throw new TypeError("Completion response does not prove the requested transition");
      }
      return completed;
    } catch {
      throw new WorkspaceTaskCompleteError("unavailable");
    }
  }

  try {
    const problem = parseApiProblemDetails(payload);
    if (problem.status !== response.status) throw new WorkspaceTaskCompleteError("unavailable");
    throw new WorkspaceTaskCompleteError(failureKind(problem));
  } catch (error) {
    if (error instanceof WorkspaceTaskCompleteError) throw error;
    throw new WorkspaceTaskCompleteError("unavailable");
  }
}

export function completeFormStateForError(error: unknown): WorkspaceTaskCompleteFormState {
  const kind = error instanceof WorkspaceTaskCompleteError ? error.kind : "unavailable";
  const messages: Record<WorkspaceTaskCompleteFailureKind, string> = {
    conflict: "This task changed or was already completed. Refresh My Work.",
    forbidden: "You are not allowed to complete this task.",
    identity_unavailable: "Your local identity is unavailable. Refresh My Work.",
    invalid_input: "This completion request is invalid. Refresh My Work.",
    not_found: "This task is no longer available.",
    service_inactive: "Workspace tasks are not available right now.",
    unavailable: "We could not complete this task. Try again.",
  };
  return { fieldErrors: {}, message: messages[kind], status: "error" };
}

function parseFormState(value: unknown): WorkspaceTaskCompleteFormState {
  if (!isRecord(value) || !hasExactKeys(value, ["fieldErrors", "message", "status"])) {
    throw new TypeError("Completion form state is invalid");
  }
  if (
    value.status !== "error" ||
    typeof value.message !== "string" ||
    !isRecord(value.fieldErrors)
  ) {
    throw new TypeError("Completion form state is invalid");
  }
  for (const [key, message] of Object.entries(value.fieldErrors)) {
    if (key !== "completionNote" || typeof message !== "string") {
      throw new TypeError("Completion form field errors are invalid");
    }
  }
  return value as unknown as WorkspaceTaskCompleteFormState;
}

export function parseWorkspaceTaskCompleteTransport(
  value: unknown,
): WorkspaceTaskCompleteTransport {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("Completion response is invalid");
  }
  if (value.ok) {
    if (
      !hasExactKeys(value, ["ok", "taskId"]) ||
      typeof value.taskId !== "string" ||
      !UUID_PATTERN.test(value.taskId)
    ) {
      throw new TypeError("Completion response is invalid");
    }
    return { ok: true, taskId: value.taskId };
  }
  if (!hasExactKeys(value, ["ok", "state"])) {
    throw new TypeError("Completion response is invalid");
  }
  return { ok: false, state: parseFormState(value.state) };
}
