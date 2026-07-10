import { describe, expect, it } from "vitest";
import {
  buildAssignedWorkspaceTaskListPath,
  decodeAssignedWorkspaceTaskListResponse,
} from "./workspace-task-assigned-list-core";

const cursor = {
  createdAt: "2026-07-10T00:00:00.000Z",
  taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

const assignedItem = {
  createdAt: cursor.createdAt,
  createdByDisplayName: "Creator A",
  description: "Prepare proof",
  dueOn: "2026-07-20",
  taskId: cursor.taskId,
  title: "Prepare workspace proof",
  version: 1,
  workItemId: "11111111-1111-4111-8111-111111111111",
};

describe("assigned workspace-task list boundary", () => {
  it("builds only the bounded assigned-list query without client identity parameters", () => {
    const path = buildAssignedWorkspaceTaskListPath(cursor);
    expect(path).toBe(
      "/v1/workspace/tasks/assigned?pageSize=50&cursorTaskId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee&cursorCreatedAt=2026-07-10T00%3A00%3A00.000Z",
    );
    expect(path).not.toContain("tenant");
    expect(path).not.toContain("principal");
    expect(() => buildAssignedWorkspaceTaskListPath({ ...cursor, taskId: "bad" })).toThrow(
      "unavailable",
    );
  });

  it("accepts only the privacy-minimized page and fails opaquely", async () => {
    const page = { items: [assignedItem], nextCursor: cursor };
    await expect(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(new Response(JSON.stringify(page), { status: 200 })),
      ),
    ).resolves.toEqual(page);
    await expect(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ ...assignedItem, tenantId: "private" }],
              nextCursor: null,
            }),
            { status: 200 },
          ),
        ),
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(new Response("private", { status: 403 })),
      ),
    ).rejects.toThrow("unavailable");
  });
});
