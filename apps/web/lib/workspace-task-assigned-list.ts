import "server-only";

import type { WorkspaceTaskCursor } from "@esbla/contracts/workspace-task-api";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildAssignedWorkspaceTaskListPath,
  decodeAssignedWorkspaceTaskListResponse,
} from "./workspace-task-assigned-list-core";

export function getAssignedWorkspaceTasks(cursor?: WorkspaceTaskCursor, signal?: AbortSignal) {
  return decodeAssignedWorkspaceTaskListResponse(
    fetchDevelopmentApi(
      { method: "GET", path: buildAssignedWorkspaceTaskListPath(cursor) },
      signal ? { signal } : {},
    ),
  );
}
