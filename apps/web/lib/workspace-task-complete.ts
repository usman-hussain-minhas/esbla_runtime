import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  buildCompleteWorkspaceTaskPath,
  decodeCompleteWorkspaceTaskResponse,
  type WorkspaceTaskCompletionInput,
} from "./workspace-task-complete-core";

export function completeAssignedWorkspaceTask(taskId: string, input: WorkspaceTaskCompletionInput) {
  return decodeCompleteWorkspaceTaskResponse(
    fetchDevelopmentApi({
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      method: "POST",
      path: buildCompleteWorkspaceTaskPath(taskId),
    }),
    taskId,
    input.body.expectedVersion,
  );
}
