import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildOwnLeaveRequestListPath,
  decodeOwnLeaveRequestListResponse,
  type HrLeaveListError,
} from "./hr-leave-list-core";

const cursor = {
  leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  submittedAt: "2026-07-10T00:00:00.000Z",
};

const page = {
  items: [],
  nextCursor: cursor,
};

describe("own leave-request list boundary", () => {
  it("builds only the bounded own-list query without a client tenant parameter", () => {
    const path = buildOwnLeaveRequestListPath(cursor);
    expect(path).toBe(
      "/v1/hr/leave-requests?pageSize=50&cursorLeaveRequestId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee&cursorSubmittedAt=2026-07-10T00%3A00%3A00.000Z",
    );
    expect(path).not.toContain("tenant");
    expect(() => buildOwnLeaveRequestListPath({ ...cursor, leaveRequestId: "bad" })).toThrow(
      "unavailable",
    );
    expect(() => buildOwnLeaveRequestListPath({ ...cursor, submittedAt: "July 10, 2026" })).toThrow(
      "unavailable",
    );
  });

  it("accepts a valid page and fails opaquely for HTTP, transport, or payload errors", async () => {
    await expect(
      decodeOwnLeaveRequestListResponse(Promise.resolve(Response.json(page, { status: 200 }))),
    ).resolves.toEqual(page);
    await expect(
      decodeOwnLeaveRequestListResponse(Promise.resolve(new Response("private", { status: 503 }))),
    ).rejects.toThrow("unavailable");
    await expect(
      decodeOwnLeaveRequestListResponse(Promise.resolve(new Response("not json", { status: 200 }))),
    ).rejects.toThrow("unavailable");
    await expect(
      decodeOwnLeaveRequestListResponse(Promise.reject(new Error("secret"))),
    ).rejects.toThrow("unavailable");
  });

  it.each([
    [403, "POLICY_DENIED", "denied"],
    [404, "LEAVE_NOT_FOUND", "not_found"],
    [503, "LEAVE_SERVICE_INACTIVE", "inactive"],
    [500, "UNEXPECTED_ERROR", "error"],
  ] as const)("classifies exact Problem Details %s without exposing detail", async (status, code, kind) => {
    const failure = decodeOwnLeaveRequestListResponse(
      Promise.resolve(
        Response.json(
          {
            code,
            detail: "private upstream detail",
            instance: "/v1/hr/leave-requests",
            requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            status,
            title: "Failure",
            type: `urn:esbla:problem:${code.toLowerCase()}`,
          },
          {
            headers: { "content-type": "application/problem+json" },
            status,
          },
        ),
      ),
    );
    await expect(failure).rejects.toMatchObject({ kind } satisfies Partial<HrLeaveListError>);
    await expect(failure).rejects.not.toThrow("private upstream detail");
  });

  it("keeps the route read-only and excludes successor actions", async () => {
    const pageSource = await readFile(
      new URL("../app/workspace/hr/leave/page.tsx", import.meta.url),
      "utf8",
    );
    expect(pageSource).toContain("My Leave Requests");
    expect(pageSource).not.toContain("Submit request");
    expect(pageSource).not.toContain("Approve");
    expect(pageSource).not.toContain("Reject");
  });
});
