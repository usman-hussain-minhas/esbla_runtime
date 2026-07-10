import { isSameOriginSubmission } from "../../../../../../lib/hr-leave-submit-core";
import { completeAssignedWorkspaceTask } from "../../../../../../lib/workspace-task-complete";
import {
  completeFormStateForError,
  validateWorkspaceTaskCompletion,
  WorkspaceTaskCompleteError,
} from "../../../../../../lib/workspace-task-complete-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function formResponse(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown) {
  if (!(error instanceof WorkspaceTaskCompleteError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (error.kind === "not_found") return 404;
  if (
    error.kind === "identity_unavailable" ||
    error.kind === "service_inactive" ||
    error.kind === "unavailable"
  ) {
    return 503;
  }
  return 422;
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly taskId: string }> },
) {
  if (
    !isSameOriginSubmission(
      request.url,
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
      request.headers.get("host"),
    )
  ) {
    const error = new WorkspaceTaskCompleteError("forbidden");
    return formResponse({ ok: false, state: completeFormStateForError(error) }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return formResponse(
      {
        ok: false,
        state: completeFormStateForError(new WorkspaceTaskCompleteError("invalid_input")),
      },
      415,
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return formResponse(
      {
        ok: false,
        state: completeFormStateForError(new WorkspaceTaskCompleteError("invalid_input")),
      },
      400,
    );
  }
  const validation = validateWorkspaceTaskCompletion(payload);
  if (!validation.ok) return formResponse({ ok: false, state: validation.state }, 400);

  try {
    const task = await completeAssignedWorkspaceTask((await params).taskId, validation.value);
    return formResponse({ ok: true, taskId: task.taskId }, 200);
  } catch (error) {
    return formResponse(
      { ok: false, state: completeFormStateForError(error) },
      failureStatus(error),
    );
  }
}
