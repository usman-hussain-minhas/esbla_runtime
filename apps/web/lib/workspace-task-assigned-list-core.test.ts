import { readFile } from "node:fs/promises";
import type { AssignedWorkspaceTaskPage } from "@esbla/contracts/workspace-task-api";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AssignedProviderUnavailableError } from "./assigned-provider-core";
import {
  buildAssignedWorkspaceTaskListPath,
  decodeAssignedWorkspaceTaskListResponse,
  WorkspaceTaskAssignedListError,
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
const page = { items: [assignedItem], nextCursor: cursor };

function jsonResponse(payload: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": contentType },
    status,
  });
}

function problem(code: string, status: number) {
  return {
    code,
    detail: "upstream-sensitive-detail",
    instance: "/v1/workspace/tasks/assigned?private=true",
    requestId: "upstream-request-id",
    status,
    title: "Upstream title",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

async function expectFatal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceTaskAssignedListError);
    expect(error).not.toBeInstanceOf(AssignedProviderUnavailableError);
    return error;
  }
  throw new Error("Expected a fatal Workspace assigned-list failure");
}

async function expectUnavailable(response: Response): Promise<AssignedProviderUnavailableError> {
  try {
    await decodeAssignedWorkspaceTaskListResponse(Promise.resolve(response));
  } catch (error) {
    expect(error).toBeInstanceOf(AssignedProviderUnavailableError);
    expect(error).toMatchObject({ provider: "workspace_task_assigned", reason: "inactive" });
    return error as AssignedProviderUnavailableError;
  }
  throw new Error("Expected an unavailable Workspace assigned-list signal");
}

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

  it("retains the standalone Promise<Page> consumer signature", () => {
    expectTypeOf(decodeAssignedWorkspaceTaskListResponse).returns.toEqualTypeOf<
      Promise<AssignedWorkspaceTaskPage>
    >();
  });

  it.each([
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    'application/json; profile="a,b"',
  ])("accepts exact HTTP 200 with strict %s media and page schema", async (contentType) => {
    await expect(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(jsonResponse(page, 200, contentType)),
      ),
    ).resolves.toEqual(page);
  });

  it.each([
    [201, "application/json"],
    [202, "application/json"],
    [206, "application/json"],
    [200, "text/json"],
    [200, "application/problem+json"],
    [200, "application/json-patch+json"],
    [200, "application/json, application/problem+json"],
    [200, "application/json; charset=utf-8, text/plain"],
  ])("keeps parseable status/media mismatch %i %s fatal", async (status, contentType) => {
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(jsonResponse(page, status, contentType)),
      ),
    );
  });

  it("keeps a bodyless 204 fatal", async () => {
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(
          new Response(null, { headers: { "content-type": "application/json" }, status: 204 }),
        ),
      ),
    );
  });

  it("keeps missing Content-Type fatal for success and an allowlisted problem", async () => {
    const success = jsonResponse(page);
    success.headers.delete("content-type");
    await expectFatal(decodeAssignedWorkspaceTaskListResponse(Promise.resolve(success)));

    const unavailable = jsonResponse(problem("WORKSPACE_TASK_SERVICE_INACTIVE", 503), 503);
    unavailable.headers.delete("content-type");
    await expectFatal(decodeAssignedWorkspaceTaskListResponse(Promise.resolve(unavailable)));
  });

  it.each([
    "application/problem+json",
    "Application/Problem+JSON",
    "application/problem+json; charset=utf-8",
    'application/problem+json; profile="a,b"',
  ])("classifies only Workspace 503/inactive with strict %s media", async (contentType) => {
    await expectUnavailable(
      jsonResponse(problem("WORKSPACE_TASK_SERVICE_INACTIVE", 503), 503, contentType),
    );
  });

  it.each([
    [400, "INVALID_REQUEST"],
    [403, "POLICY_DENIED"],
    [403, "ACTOR_NOT_ACTIVE_MEMBER"],
    [503, "LEAVE_SERVICE_INACTIVE"],
    [503, "UNKNOWN_UNAVAILABLE"],
    [500, "UNEXPECTED_SERVER_ERROR"],
    [401, "AUTH_REQUIRED"],
    [404, "WORKSPACE_TASK_NOT_FOUND"],
    [409, "WORKSPACE_TASK_STATE_CONFLICT"],
    [422, "WORKSPACE_TASK_INVALID"],
    [403, "WORKSPACE_TASK_SERVICE_INACTIVE"],
  ])("keeps non-allowlisted Workspace tuple %i/%s fatal", async (status, code) => {
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(jsonResponse(problem(code, status), status, "application/problem+json")),
      ),
    );
  });

  it.each([
    "application/json",
    "text/plain",
    "application/problem+json-patch",
    "application/problem+json; charset=utf-8, application/json",
  ])("keeps an otherwise allowlisted problem with wrong media %s fatal", async (contentType) => {
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(
          jsonResponse(problem("WORKSPACE_TASK_SERVICE_INACTIVE", 503), 503, contentType),
        ),
      ),
    );
  });

  it("strictly rejects malformed, mismatched, missing, or extra Problem Details", async () => {
    const valid = problem("WORKSPACE_TASK_SERVICE_INACTIVE", 503);
    const { requestId: _requestId, ...missing } = valid;
    const cases: readonly unknown[] = [
      { ...valid, privateField: "secret" },
      missing,
      { ...valid, detail: "" },
      { ...valid, status: 403 },
      { ...valid, status: 503.5 },
      { ...valid, title: null },
      page,
    ];
    for (const payload of cases) {
      await expectFatal(
        decodeAssignedWorkspaceTaskListResponse(
          Promise.resolve(jsonResponse(payload, 503, "application/problem+json")),
        ),
      );
    }
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(
          new Response("{", {
            headers: { "content-type": "application/problem+json" },
            status: 503,
          }),
        ),
      ),
    );
  });

  it("keeps network failures and malformed or privacy-expanded success pages fatal", async () => {
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(Promise.reject(new Error("upstream-network-secret"))),
    );
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(
          jsonResponse({ items: [{ ...assignedItem, tenantId: "private" }], nextCursor: null }),
        ),
      ),
    );
    await expectFatal(
      decodeAssignedWorkspaceTaskListResponse(
        Promise.resolve(
          new Response("private", {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        ),
      ),
    );
  });

  it("does not retain raw Problem Details in typed unavailability", async () => {
    const error = await expectUnavailable(
      jsonResponse(
        problem("WORKSPACE_TASK_SERVICE_INACTIVE", 503),
        503,
        "application/problem+json",
      ),
    );
    const serialized = `${JSON.stringify(error)} ${error.message} ${error.stack}`;
    expect(serialized).not.toMatch(
      /upstream-sensitive-detail|private=true|upstream-request-id|Upstream title|urn:esbla/i,
    );
    expect(error).not.toHaveProperty("cause");
    expect(Object.keys(error).sort()).toEqual(["name", "provider", "reason"].sort());
  });

  it("leaves standalone Workspace Tasks as an uncaught page-returning consumer", async () => {
    const source = await readFile(
      new URL("../app/workspace/tasks/page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("await getAssignedWorkspaceTasks(cursor)");
    expect(source).not.toContain("AssignedProviderUnavailableError");
  });
});
