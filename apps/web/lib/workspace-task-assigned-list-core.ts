import {
  type AssignedWorkspaceTaskPage,
  parseAssignedWorkspaceTaskPage,
  type WorkspaceTaskCursor,
} from "@esbla/contracts/workspace-task-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class WorkspaceTaskAssignedListError extends Error {
  constructor() {
    super("The assigned workspace-task list is unavailable");
    this.name = "WorkspaceTaskAssignedListError";
  }
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
  if (!response.ok) throw new WorkspaceTaskAssignedListError();
  try {
    return parseAssignedWorkspaceTaskPage(await response.json());
  } catch {
    throw new WorkspaceTaskAssignedListError();
  }
}
