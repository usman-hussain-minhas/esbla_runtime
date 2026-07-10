import { describe, expect, it } from "vitest";
import {
  decodeCreateWorkspaceTaskResponse,
  parseWorkspaceTaskCreateTransport,
  validateWorkspaceTaskCreation,
} from "./workspace-task-create-core";

const task = {
  assigneePrincipalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  completedAt: null,
  completionNote: null,
  correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  createdAt: "2026-07-10T00:00:00.000Z",
  createdByPrincipalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  description: "Prepare proof",
  dueOn: "2026-07-20",
  idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  status: "open",
  taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  tenantId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  title: "Prepare workspace proof",
  updatedAt: "2026-07-10T00:00:00.000Z",
  version: 1,
} as const;

describe("workspace task creation boundary", () => {
  it("normalizes a valid creation request and rejects identity-bearing envelopes", () => {
    expect(
      validateWorkspaceTaskCreation({
        assigneePrincipalId: task.assigneePrincipalId,
        description: "  Prepare proof  ",
        dueOn: "2026-07-20",
        idempotencyKey: task.idempotencyKey,
        title: "  Prepare workspace proof  ",
      }),
    ).toEqual({
      ok: true,
      value: {
        body: {
          assigneePrincipalId: task.assigneePrincipalId,
          description: "Prepare proof",
          dueOn: "2026-07-20",
          title: "Prepare workspace proof",
        },
        idempotencyKey: task.idempotencyKey,
      },
    });
    expect(
      validateWorkspaceTaskCreation({
        assigneePrincipalId: task.assigneePrincipalId,
        description: "",
        dueOn: "",
        idempotencyKey: task.idempotencyKey,
        tenantId: task.tenantId,
        title: "Task",
      }),
    ).toMatchObject({ ok: false, state: { fieldErrors: {}, status: "error" } });
  });

  it("strictly decodes created and replayed API responses", async () => {
    await expect(
      decodeCreateWorkspaceTaskResponse(
        Promise.resolve(new Response(JSON.stringify(task), { status: 201 })),
      ),
    ).resolves.toEqual(task);
    await expect(
      decodeCreateWorkspaceTaskResponse(
        Promise.resolve(new Response(JSON.stringify(task), { status: 200 })),
      ),
    ).resolves.toEqual(task);
    await expect(
      decodeCreateWorkspaceTaskResponse(
        Promise.resolve(
          new Response(JSON.stringify({ ...task, privateField: true }), { status: 201 }),
        ),
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("strictly decodes bounded form transport", () => {
    expect(parseWorkspaceTaskCreateTransport({ ok: true, taskId: task.taskId })).toEqual({
      ok: true,
      taskId: task.taskId,
    });
    expect(() => parseWorkspaceTaskCreateTransport({ ok: true, private: "leak" })).toThrow(
      "Create response is invalid",
    );
  });
});
