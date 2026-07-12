import { type ApiProblemDetails, parseApiProblemDetails } from "@esbla/contracts/hr-leave-api";
import {
  type AssignedWorkspaceTaskPage,
  parseAssignedWorkspaceTaskPage,
  type WorkspaceTaskCursor,
} from "@esbla/contracts/workspace-task-api";
import { AssignedProviderUnavailableError } from "./assigned-provider-core";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class WorkspaceTaskAssignedListError extends Error {
  constructor() {
    super("The assigned workspace-task list is unavailable");
    this.name = "WorkspaceTaskAssignedListError";
  }
}

function mediaTypeEssence(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return null;
  let escaped = false;
  let quoted = false;
  for (const character of contentType) {
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      return null;
    }
  }
  if (quoted || escaped) return null;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

export function buildAssignedWorkspaceTaskListPath(cursor?: WorkspaceTaskCursor): string {
  const parameters = new URLSearchParams({ pageSize: "50" });
  if (cursor) {
    if (
      !UUID_PATTERN.test(cursor.taskId) ||
      !ISO_DATE_TIME_PATTERN.test(cursor.createdAt) ||
      Number.isNaN(Date.parse(cursor.createdAt))
    ) {
      throw new WorkspaceTaskAssignedListError();
    }
    parameters.set("cursorTaskId", cursor.taskId);
    parameters.set("cursorCreatedAt", cursor.createdAt);
  }
  return `/v1/workspace/tasks/assigned?${parameters.toString()}`;
}

export async function decodeAssignedWorkspaceTaskListResponse(
  responsePromise: Promise<Response>,
): Promise<AssignedWorkspaceTaskPage> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkspaceTaskAssignedListError();
  }

  let mediaType: string | null;
  try {
    mediaType = mediaTypeEssence(response);
  } catch {
    throw new WorkspaceTaskAssignedListError();
  }

  if (response.status === 200) {
    if (mediaType !== "application/json") throw new WorkspaceTaskAssignedListError();
    let payload: unknown;
    try {
      payload = await response.json();
      return parseAssignedWorkspaceTaskPage(payload);
    } catch {
      throw new WorkspaceTaskAssignedListError();
    }
  }

  if (mediaType !== "application/problem+json") throw new WorkspaceTaskAssignedListError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WorkspaceTaskAssignedListError();
  }
  let problem: ApiProblemDetails;
  try {
    problem = parseApiProblemDetails(payload);
  } catch {
    throw new WorkspaceTaskAssignedListError();
  }
  if (problem.status !== response.status) throw new WorkspaceTaskAssignedListError();
  if (response.status === 503 && problem.code === "WORKSPACE_TASK_SERVICE_INACTIVE") {
    throw new AssignedProviderUnavailableError("workspace_task_assigned", "inactive");
  }
  throw new WorkspaceTaskAssignedListError();
}
