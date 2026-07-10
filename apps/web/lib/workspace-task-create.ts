import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  decodeCreateWorkspaceTaskResponse,
  type WorkspaceTaskCreationInput,
} from "./workspace-task-create-core";

export function createWorkspaceTask(input: WorkspaceTaskCreationInput) {
  return decodeCreateWorkspaceTaskResponse(
    fetchDevelopmentApi({
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      method: "POST",
      path: "/v1/workspace/tasks",
    }),
  );
}
