import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AssignedProviderUnavailableError } from "./assigned-provider-core";
import {
  buildAssignedLeaveRequestListPath,
  decodeAssignedLeaveRequestListResponse,
  HrLeaveAssignedListError,
} from "./hr-leave-assigned-list-core";

const cursor = {
  leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  submittedAt: "2026-07-10T00:00:00.000Z",
};

const assignedItem = {
  categoryCode: "annual",
  employeeDisplayName: "Employee A",
  endDate: "2026-07-12",
  leaveRequestId: cursor.leaveRequestId,
  reason: "Rest",
  startDate: "2026-07-11",
  submittedAt: cursor.submittedAt,
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
    instance: "/v1/hr/leave-requests/assigned?private=true",
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
    expect(error).toBeInstanceOf(HrLeaveAssignedListError);
    expect(error).not.toBeInstanceOf(AssignedProviderUnavailableError);
    return error;
  }
  throw new Error("Expected a fatal HR assigned-list failure");
}

async function expectUnavailable(
  response: Response,
  reason: "inactive" | "ineligible",
): Promise<AssignedProviderUnavailableError> {
  try {
    await decodeAssignedLeaveRequestListResponse(Promise.resolve(response));
  } catch (error) {
    expect(error).toBeInstanceOf(AssignedProviderUnavailableError);
    expect(error).toMatchObject({ provider: "hr_leave_assigned", reason });
    return error as AssignedProviderUnavailableError;
  }
  throw new Error("Expected an unavailable HR assigned-list signal");
}

describe("assigned leave-request list boundary", () => {
  it("builds only the bounded assigned-list query without client identity parameters", () => {
    const path = buildAssignedLeaveRequestListPath(cursor);
    expect(path).toBe(
      "/v1/hr/leave-requests/assigned?pageSize=50&cursorLeaveRequestId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee&cursorSubmittedAt=2026-07-10T00%3A00%3A00.000Z",
    );
    expect(path).not.toContain("tenant");
    expect(path).not.toContain("principal");
    expect(() => buildAssignedLeaveRequestListPath({ ...cursor, leaveRequestId: "bad" })).toThrow(
      "unavailable",
    );
  });

  it.each([
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    'application/json; profile="a,b"',
  ])("accepts exact HTTP 200 with strict %s media and page schema", async (contentType) => {
    await expect(
      decodeAssignedLeaveRequestListResponse(Promise.resolve(jsonResponse(page, 200, contentType))),
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
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(jsonResponse(page, status, contentType)),
      ),
    );
  });

  it("keeps a bodyless 204 fatal", async () => {
    await expectFatal(
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(
          new Response(null, { headers: { "content-type": "application/json" }, status: 204 }),
        ),
      ),
    );
  });

  it("keeps missing Content-Type fatal for success and an allowlisted problem", async () => {
    const success = jsonResponse(page);
    success.headers.delete("content-type");
    await expectFatal(decodeAssignedLeaveRequestListResponse(Promise.resolve(success)));

    const unavailable = jsonResponse(problem("POLICY_DENIED", 403), 403);
    unavailable.headers.delete("content-type");
    await expectFatal(decodeAssignedLeaveRequestListResponse(Promise.resolve(unavailable)));
  });

  it.each([
    [403, "POLICY_DENIED", "ineligible", "application/problem+json"],
    [403, "POLICY_DENIED", "ineligible", "Application/Problem+JSON; Charset=UTF-8"],
    [403, "POLICY_DENIED", "ineligible", 'application/problem+json; profile="a,b"'],
    [503, "LEAVE_SERVICE_INACTIVE", "inactive", "application/problem+json; charset=utf-8"],
  ] as const)("classifies only HR %i/%s as sanitized %s", async (status, code, reason, contentType) => {
    await expectUnavailable(jsonResponse(problem(code, status), status, contentType), reason);
  });

  it.each([
    [400, "INVALID_REQUEST"],
    [403, "ACTOR_NOT_ACTIVE_MEMBER"],
    [403, "UNKNOWN_DENIAL"],
    [503, "WORKSPACE_TASK_SERVICE_INACTIVE"],
    [503, "UNKNOWN_UNAVAILABLE"],
    [500, "UNEXPECTED_SERVER_ERROR"],
    [401, "AUTH_REQUIRED"],
    [404, "LEAVE_NOT_FOUND"],
    [409, "LEAVE_STATE_CONFLICT"],
    [422, "LEAVE_MANAGER_REQUIRED"],
    [503, "POLICY_DENIED"],
    [403, "LEAVE_SERVICE_INACTIVE"],
  ])("keeps non-allowlisted HR tuple %i/%s fatal", async (status, code) => {
    await expectFatal(
      decodeAssignedLeaveRequestListResponse(
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
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(jsonResponse(problem("POLICY_DENIED", 403), 403, contentType)),
      ),
    );
  });

  it("strictly rejects malformed, mismatched, missing, or extra Problem Details", async () => {
    const valid = problem("POLICY_DENIED", 403);
    const { requestId: _requestId, ...missing } = valid;
    const cases: readonly unknown[] = [
      { ...valid, privateField: "secret" },
      missing,
      { ...valid, detail: "" },
      { ...valid, status: 503 },
      { ...valid, status: 403.5 },
      { ...valid, title: null },
      page,
    ];
    for (const payload of cases) {
      await expectFatal(
        decodeAssignedLeaveRequestListResponse(
          Promise.resolve(jsonResponse(payload, 403, "application/problem+json")),
        ),
      );
    }
    await expectFatal(
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(
          new Response("{", {
            headers: { "content-type": "application/problem+json" },
            status: 403,
          }),
        ),
      ),
    );
  });

  it("keeps network failures and malformed or privacy-expanded success pages fatal", async () => {
    await expectFatal(
      decodeAssignedLeaveRequestListResponse(Promise.reject(new Error("upstream-network-secret"))),
    );
    await expectFatal(
      decodeAssignedLeaveRequestListResponse(
        Promise.resolve(
          jsonResponse({ items: [{ ...assignedItem, tenantId: "private" }], nextCursor: null }),
        ),
      ),
    );
    await expectFatal(
      decodeAssignedLeaveRequestListResponse(
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
      jsonResponse(problem("POLICY_DENIED", 403), 403, "application/problem+json"),
      "ineligible",
    );
    const serialized = `${JSON.stringify(error)} ${error.message} ${error.stack}`;
    expect(serialized).not.toMatch(
      /upstream-sensitive-detail|private=true|upstream-request-id|Upstream title|urn:esbla/i,
    );
    expect(error).not.toHaveProperty("cause");
    expect(Object.keys(error).sort()).toEqual(["name", "provider", "reason"].sort());
  });

  it("keeps My Work privacy-minimized and delegates decisions to bounded actions", async () => {
    const pageSource = await readFile(
      new URL("../app/workspace/my-work/page.tsx", import.meta.url),
      "utf8",
    );
    expect(pageSource).toContain("Assigned work");
    expect(pageSource).toContain("LeaveApprovalAction");
    expect(pageSource).toContain("LeaveRejectionAction");
    expect(pageSource).toContain("TaskCompleteAction");
    expect(pageSource).not.toContain("fetch(");
    expect(pageSource).not.toContain("/approve");
    expect(pageSource).not.toContain("/reject");
    expect(pageSource).not.toContain("tenantId");
    expect(pageSource).not.toContain("employeePrincipalId");
  });
});
