import { type ApiProblemDetails, parseApiProblemDetails } from "@esbla/contracts/hr-leave-api";
import {
  parseWorkspaceTask,
  type WorkspaceCreateTaskBody,
  type WorkspaceTask,
} from "@esbla/contracts/workspace-task-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CREATE_KEYS = ["assigneePrincipalId", "description", "dueOn", "idempotencyKey", "title"];
const CREATE_FIELDS = new Set<WorkspaceTaskCreateField>([
  "assigneePrincipalId",
  "description",
  "dueOn",
  "title",
]);

export type WorkspaceTaskCreateField = "assigneePrincipalId" | "description" | "dueOn" | "title";
export type WorkspaceTaskCreateFailureKind =
  | "conflict"
  | "forbidden"
  | "identity_unavailable"
  | "invalid_input"
  | "service_inactive"
  | "unavailable";

export interface WorkspaceTaskCreateFormState {
  readonly fieldErrors: Readonly<Partial<Record<WorkspaceTaskCreateField, string>>>;
  readonly message?: string;
  readonly status: "error" | "idle";
}

export interface WorkspaceTaskCreationInput {
  readonly body: WorkspaceCreateTaskBody;
  readonly idempotencyKey: string;
}

export type WorkspaceTaskCreationValidation =
  | { readonly ok: false; readonly state: WorkspaceTaskCreateFormState }
  | { readonly ok: true; readonly value: WorkspaceTaskCreationInput };

export type WorkspaceTaskCreateTransport =
  | { readonly ok: false; readonly state: WorkspaceTaskCreateFormState }
  | { readonly ok: true; readonly taskId: string };

export const INITIAL_WORKSPACE_TASK_CREATE_STATE: WorkspaceTaskCreateFormState = {
  fieldErrors: {},
  status: "idle",
};

export class WorkspaceTaskCreateError extends Error {
  constructor(readonly kind: WorkspaceTaskCreateFailureKind) {
    super("The workspace task could not be created");
    this.name = "WorkspaceTaskCreateError";
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

function readText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : null;
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

export function validateWorkspaceTaskCreation(payload: unknown): WorkspaceTaskCreationValidation {
  if (!isRecord(payload) || !hasExactKeys(payload, CREATE_KEYS)) {
    return {
      ok: false,
      state: { fieldErrors: {}, message: "Review your task and try again.", status: "error" },
    };
  }
  const assigneePrincipalId = readText(payload, "assigneePrincipalId");
  const description = readText(payload, "description");
  const dueOn = readText(payload, "dueOn");
  const idempotencyKey = readText(payload, "idempotencyKey");
  const title = readText(payload, "title");
  const fieldErrors: Partial<Record<WorkspaceTaskCreateField, string>> = {};

  if (!assigneePrincipalId || !UUID_PATTERN.test(assigneePrincipalId)) {
    fieldErrors.assigneePrincipalId = "Enter an active assignee principal ID.";
  }
  if (!title || title.length > 160) fieldErrors.title = "Enter a task title.";
  if (description !== null && description.length > 2000) {
    fieldErrors.description = "Description must be 2,000 characters or fewer.";
  }
  if (dueOn !== null && dueOn !== "" && !isCalendarDate(dueOn)) {
    fieldErrors.dueOn = "Enter a valid due date.";
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
        assigneePrincipalId: assigneePrincipalId as string,
        ...(description ? { description } : {}),
        ...(dueOn ? { dueOn } : {}),
        title: title as string,
      },
      idempotencyKey,
    },
  };
}

function failureKind(problem: ApiProblemDetails): WorkspaceTaskCreateFailureKind {
  if (problem.code === "WORKSPACE_TASK_SERVICE_INACTIVE") return "service_inactive";
  if (problem.code.startsWith("AUTH_") || problem.status === 401) return "identity_unavailable";
  if (problem.code === "POLICY_DENIED" || problem.status === 403) return "forbidden";
  if (problem.code === "WORKSPACE_TASK_IDEMPOTENCY_CONFLICT" || problem.status === 409) {
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

export async function decodeCreateWorkspaceTaskResponse(
  responsePromise: Promise<Response>,
): Promise<WorkspaceTask> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkspaceTaskCreateError("unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WorkspaceTaskCreateError("unavailable");
  }

  if (response.status === 200 || response.status === 201) {
    try {
      const task = parseWorkspaceTask(payload);
      if (task.status !== "open" || task.completedAt !== null || task.completionNote !== null) {
        throw new TypeError("Create response does not prove an open task");
      }
      return task;
    } catch {
      throw new WorkspaceTaskCreateError("unavailable");
    }
  }

  try {
    const problem = parseApiProblemDetails(payload);
    if (problem.status !== response.status) throw new WorkspaceTaskCreateError("unavailable");
    throw new WorkspaceTaskCreateError(failureKind(problem));
  } catch (error) {
    if (error instanceof WorkspaceTaskCreateError) throw error;
    throw new WorkspaceTaskCreateError("unavailable");
  }
}

export function createFormStateForError(error: unknown): WorkspaceTaskCreateFormState {
  const kind = error instanceof WorkspaceTaskCreateError ? error.kind : "unavailable";
  const messages: Record<WorkspaceTaskCreateFailureKind, string> = {
    conflict: "This form could not be safely replayed. Refresh the page and try again.",
    forbidden: "You do not have permission to create this task.",
    identity_unavailable: "Your local identity is unavailable. Refresh the page and try again.",
    invalid_input: "Review your task and try again.",
    service_inactive: "Workspace tasks are not available right now.",
    unavailable: "We could not create this task. Try again.",
  };
  return { fieldErrors: {}, message: messages[kind], status: "error" };
}

function parseFormState(value: unknown): WorkspaceTaskCreateFormState {
  if (!isRecord(value) || !hasExactKeys(value, ["fieldErrors", "message", "status"])) {
    throw new TypeError("Create form state is invalid");
  }
  if (
    value.status !== "error" ||
    typeof value.message !== "string" ||
    !isRecord(value.fieldErrors)
  ) {
    throw new TypeError("Create form state is invalid");
  }
  for (const [key, message] of Object.entries(value.fieldErrors)) {
    if (!CREATE_FIELDS.has(key as WorkspaceTaskCreateField) || typeof message !== "string") {
      throw new TypeError("Create form field errors are invalid");
    }
  }
  return value as unknown as WorkspaceTaskCreateFormState;
}

export function parseWorkspaceTaskCreateTransport(value: unknown): WorkspaceTaskCreateTransport {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("Create response is invalid");
  }
  if (value.ok) {
    if (
      !hasExactKeys(value, ["ok", "taskId"]) ||
      typeof value.taskId !== "string" ||
      !UUID_PATTERN.test(value.taskId)
    ) {
      throw new TypeError("Create response is invalid");
    }
    return { ok: true, taskId: value.taskId };
  }
  if (!hasExactKeys(value, ["ok", "state"])) throw new TypeError("Create response is invalid");
  return { ok: false, state: parseFormState(value.state) };
}
