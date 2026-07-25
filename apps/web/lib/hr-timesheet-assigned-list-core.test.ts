import type {
  HrTimesheetAssignedCursor,
  HrTimesheetListResponse,
} from "@esbla/contracts/hr-timesheet-api";
import { describe, expect, it } from "vitest";
import { AssignedProviderUnavailableError } from "./assigned-provider-core";
import {
  buildAssignedTimesheetListPath,
  decodeAssignedTimesheetListResponse,
  TimesheetAssignedListError,
} from "./hr-timesheet-assigned-list-core";

const cursor = {
  submittedAt: "2026-07-25T10:20:30.000Z",
  timesheetVersionId: "11111111-1111-4111-8111-111111111111",
} satisfies HrTimesheetAssignedCursor;
const page = {
  items: [
    {
      periodEnd: "2026-07-27",
      periodStart: "2026-07-21",
      rootVersion: 1,
      status: "submitted",
      submittedAt: cursor.submittedAt,
      timesheetId: "22222222-2222-4222-8222-222222222222",
      timesheetVersionId: cursor.timesheetVersionId,
      totalMinutes: 480,
      version: 1,
      workerProfileId: "33333333-3333-4333-8333-333333333333",
      workItemId: "44444444-4444-4444-8444-444444444444",
    },
  ],
  kind: "assigned",
  nextCursor: cursor,
} satisfies HrTimesheetListResponse;

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function problem(status: number, code: string): Response {
  return new Response(
    JSON.stringify({
      code,
      detail: "Bounded public detail",
      instance: "/v1/hr/timesheets/assigned",
      requestId: "bounded-request-id",
      status,
      title: "Unavailable",
      type: `urn:esbla:problem:${code.toLowerCase()}`,
    }),
    { headers: { "content-type": "application/problem+json" }, status },
  );
}

describe("Timesheet assigned-list boundary", () => {
  it("builds only an exact bounded paired cursor request", () => {
    expect(buildAssignedTimesheetListPath()).toBe("/v1/hr/timesheets/assigned?pageSize=50");
    expect(buildAssignedTimesheetListPath(cursor)).toBe(
      `/v1/hr/timesheets/assigned?pageSize=50&cursorTimesheetVersionId=${cursor.timesheetVersionId}&cursorSubmittedAt=${encodeURIComponent(cursor.submittedAt)}`,
    );
    expect(() =>
      buildAssignedTimesheetListPath({ ...cursor, submittedAt: "2026-02-30T00:00:00.000Z" }),
    ).toThrowError(TimesheetAssignedListError);
  });

  it("accepts exact HTTP 200 JSON only after fresh assigned authority is present", async () => {
    await expect(
      decodeAssignedTimesheetListResponse(
        Promise.resolve(
          json(page, 200, {
            "x-esbla-timesheet-actions": '["approve","list_assigned","reject","view_detail"]',
          }),
        ),
      ),
    ).resolves.toEqual(page);
    await expect(
      decodeAssignedTimesheetListResponse(
        Promise.resolve(json(page, 200, { "x-esbla-timesheet-actions": '["view_detail"]' })),
      ),
    ).rejects.toBeInstanceOf(TimesheetAssignedListError);
  });

  it.each([
    [403, "POLICY_DENIED", "ineligible"],
    [503, "TIMESHEET_SERVICE_INACTIVE", "inactive"],
  ] as const)("suppresses only exact endpoint-local %i %s", async (status, code, reason) => {
    await expect(
      decodeAssignedTimesheetListResponse(Promise.resolve(problem(status, code))),
    ).rejects.toEqual(
      expect.objectContaining({
        provider: "hr_timesheet_assigned",
        reason,
      }),
    );
  });

  it("keeps non-suppressible failures fatal and sanitized", async () => {
    const subject = decodeAssignedTimesheetListResponse(
      Promise.resolve(problem(403, "ACTOR_NOT_ACTIVE_MEMBER")),
    );
    await expect(subject).rejects.toBeInstanceOf(TimesheetAssignedListError);
    await expect(subject).rejects.not.toBeInstanceOf(AssignedProviderUnavailableError);
  });

  it("fails opaquely for transport and malformed success", async () => {
    const privateFailure = new Error("upstream private connection detail");
    for (const subject of [
      decodeAssignedTimesheetListResponse(Promise.reject(privateFailure)),
      decodeAssignedTimesheetListResponse(
        Promise.resolve(
          new Response("{", {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        ),
      ),
    ]) {
      await expect(subject).rejects.toMatchObject({
        message: "The assigned Timesheet list is unavailable",
        name: "TimesheetAssignedListError",
      });
      await expect(subject).rejects.not.toHaveProperty("cause");
    }
  });
});
