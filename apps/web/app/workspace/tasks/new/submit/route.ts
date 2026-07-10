import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";
import { createWorkspaceTask } from "../../../../../lib/workspace-task-create";
import {
  createFormStateForError,
  validateWorkspaceTaskCreation,
  WorkspaceTaskCreateError,
} from "../../../../../lib/workspace-task-create-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function formResponse(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown) {
  if (!(error instanceof WorkspaceTaskCreateError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (
    error.kind === "identity_unavailable" ||
    error.kind === "service_inactive" ||
    error.kind === "unavailable"
  ) {
    return 503;
  }
  return 422;
}

export async function POST(request: Request) {
  if (
    !isSameOriginSubmission(
      request.url,
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
      request.headers.get("host"),
    )
  ) {
    const error = new WorkspaceTaskCreateError("forbidden");
    return formResponse({ ok: false, state: createFormStateForError(error) }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return formResponse(
      { ok: false, state: createFormStateForError(new WorkspaceTaskCreateError("invalid_input")) },
      415,
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return formResponse(
      { ok: false, state: createFormStateForError(new WorkspaceTaskCreateError("invalid_input")) },
      400,
    );
  }
  const validation = validateWorkspaceTaskCreation(payload);
  if (!validation.ok) return formResponse({ ok: false, state: validation.state }, 400);

  try {
    const task = await createWorkspaceTask(validation.value);
    return formResponse({ ok: true, taskId: task.taskId }, 201);
  } catch (error) {
    return formResponse({ ok: false, state: createFormStateForError(error) }, failureStatus(error));
  }
}
