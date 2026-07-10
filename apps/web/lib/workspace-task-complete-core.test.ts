import { describe, expect, it } from "vitest";
import {
  buildCompleteWorkspaceTaskPath,
  decodeCompleteWorkspaceTaskResponse,
  parseWorkspaceTaskCompleteTransport,
  validateWorkspaceTaskCompletion,
} from "./workspace-task-complete-core";

const task = {
  assigneePrincipalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  completedAt: "2026-07-10T00:05:00.000Z",
  completionNote: "Done",
  correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  createdAt: "2026-07-10T00:00:00.000Z",
  createdByPrincipalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  description: "Prepare proof",
  dueOn: "2026-07-20",
  idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  status: "completed",
  taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  tenantId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  title: "Prepare workspace proof",
  updatedAt: "2026-07-10T00:05:00.000Z",
  version: 2,
} as const;

describe("workspace task completion boundary", () => {
  it("normalizes a valid completion request", () => {
    expect(
      validateWorkspaceTaskCompletion({
        completionNote: "  Done  ",
        expectedVersion: 1,
        idempotencyKey: task.idempotencyKey,
      }),
    ).toEqual({
      ok: true,
      value: {
        body: { completionNote: "Done", expectedVersion: 1 },
        idempotencyKey: task.idempotencyKey,
      },
    });
    expect(
      validateWorkspaceTaskCompletion({
        completionNote: "x".repeat(2001),
        expectedVersion: 1,
        idempotencyKey: task.idempotencyKey,
      }),
    ).toMatchObject({
      ok: false,
      state: { fieldErrors: { completionNote: expect.any(String) }, status: "error" },
    });
  });

  it("builds only the bounded completion path", () => {
    expect(buildCompleteWorkspaceTaskPath(task.taskId)).toBe(
      "/v1/workspace/tasks/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/complete",
    );
    expect(() => buildCompleteWorkspaceTaskPath("bad")).toThrow("could not be completed");
  });

  it("strictly decodes completed API and form responses", async () => {
    await expect(
      decodeCompleteWorkspaceTaskResponse(
        Promise.resolve(new Response(JSON.stringify(task), { status: 200 })),
        task.taskId,
        1,
      ),
    ).resolves.toEqual(task);
    await expect(
      decodeCompleteWorkspaceTaskResponse(
        Promise.resolve(new Response(JSON.stringify({ ...task, status: "open" }), { status: 200 })),
        task.taskId,
        1,
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(parseWorkspaceTaskCompleteTransport({ ok: true, taskId: task.taskId })).toEqual({
      ok: true,
      taskId: task.taskId,
    });
  });
});
