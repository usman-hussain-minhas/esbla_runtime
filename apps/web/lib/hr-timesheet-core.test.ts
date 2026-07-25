import type {
  HrTimesheetListResponse,
  HrTimesheetResponse,
} from "@esbla/contracts/hr-timesheet-api";
import { describe, expect, it } from "vitest";
import {
  buildOwnTimesheetPath,
  buildTimesheetDetailPath,
  decodeTimesheetDetail,
  decodeTimesheetList,
  decodeTimesheetMutation,
  parseTimesheetActions,
  TimesheetUiError,
  validateTimesheetAction,
} from "./hr-timesheet-core";

const root = {
  currentVersion: {
    assignedApproverWorkerProfileId: null,
    entries: [],
    rowVersion: 1,
    status: "draft",
    submittedAt: null,
    supersedesVersionId: null,
    timesheetVersionId: "20000000-0000-4000-8000-000000000001",
    totalMinutes: 0,
    version: 1,
  },
  periodEnd: "2027-07-11",
  periodStart: "2027-07-05",
  rootVersion: 1,
  timesheetId: "10000000-0000-4000-8000-000000000001",
  workerProfileId: "30000000-0000-4000-8000-000000000001",
} satisfies HrTimesheetResponse;
const assigned = {
  items: [
    {
      periodEnd: root.periodEnd,
      periodStart: root.periodStart,
      rootVersion: 1,
      status: "submitted",
      submittedAt: "2027-07-05T09:00:00.000Z",
      timesheetId: root.timesheetId,
      timesheetVersionId: root.currentVersion.timesheetVersionId,
      totalMinutes: 480,
      version: 1,
      workerProfileId: root.workerProfileId,
      workItemId: "40000000-0000-4000-8000-000000000001",
    },
  ],
  kind: "assigned",
  nextCursor: null,
} satisfies HrTimesheetListResponse;

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("Timesheet rendered boundary", () => {
  it("accepts only a canonical current-authority projection", () => {
    expect(
      parseTimesheetActions(
        json({}, 200, {
          "x-esbla-timesheet-actions": '["approve","list_assigned","reject","view_detail"]',
        }),
      ),
    ).toEqual(["approve", "list_assigned", "reject", "view_detail"]);
    expect(() =>
      parseTimesheetActions(
        json({}, 200, {
          "x-esbla-timesheet-actions": '["view_detail","approve"]',
        }),
      ),
    ).toThrowError(TimesheetUiError);
    expect(() => parseTimesheetActions(json({}))).toThrowError(TimesheetUiError);
  });

  it("decodes exact read and mutation success while rejecting wrong kinds and statuses", async () => {
    await expect(decodeTimesheetList(json(assigned), "assigned")).resolves.toEqual(assigned);
    await expect(
      decodeTimesheetList(json({ ...assigned, kind: "own" }), "assigned"),
    ).rejects.toBeInstanceOf(TimesheetUiError);
    await expect(
      decodeTimesheetDetail(
        json({
          ...root,
          accessScope: "own",
          history: { items: [], nextCursor: null },
        }),
      ),
    ).resolves.toMatchObject({ accessScope: "own", timesheetId: root.timesheetId });
    await expect(
      decodeTimesheetMutation(json(root, 201, { "idempotent-replayed": "false" }), "create"),
    ).resolves.toEqual(root);
    await expect(
      decodeTimesheetMutation(json(root, 201, { "idempotent-replayed": "true" }), "create"),
    ).rejects.toBeInstanceOf(TimesheetUiError);
  });

  it("maps only strict Problem Details into sanitized UI errors", async () => {
    const problem = new Response(
      JSON.stringify({
        code: "TIMESHEET_SERVICE_INACTIVE",
        detail: "internal text must not escape",
        instance: "/v1/problems/50000000-0000-4000-8000-000000000001",
        requestId: "50000000-0000-4000-8000-000000000001",
        status: 503,
        title: "Unavailable",
        type: "urn:esbla:problem:timesheet_service_inactive",
      }),
      { headers: { "content-type": "application/problem+json" }, status: 503 },
    );
    await expect(decodeTimesheetList(problem, "assigned")).rejects.toMatchObject({
      kind: "inactive",
      message: "Timesheet request failed",
    });
  });

  it("validates exact create, edit, and submit form semantics", () => {
    const idempotencyKey = "60000000-0000-4000-8000-000000000001";
    expect(
      validateTimesheetAction({
        idempotencyKey,
        operation: "create",
        periodEnd: root.periodEnd,
        periodStart: root.periodStart,
      }),
    ).toMatchObject({ ok: true, value: { operation: "create" } });
    expect(
      validateTimesheetAction({
        entryDate_0: root.periodStart,
        entryDescription_0: "Customer-free internal work",
        entryMinutes_0: "480",
        expectedRootVersion: "1",
        expectedTimesheetVersionId: root.currentVersion.timesheetVersionId,
        expectedVersion: "1",
        idempotencyKey,
        operation: "edit_draft",
        timesheetId: root.timesheetId,
      }),
    ).toMatchObject({
      ok: true,
      value: { body: { entries: [{ entryDate: root.periodStart, minutes: 480 }] } },
    });
    expect(
      validateTimesheetAction({
        expectedRootVersion: "1",
        expectedTimesheetVersionId: root.currentVersion.timesheetVersionId,
        expectedVersion: "1",
        idempotencyKey,
        operation: "submit",
        timesheetId: root.timesheetId,
      }),
    ).toMatchObject({ ok: true, value: { operation: "submit" } });
    expect(
      validateTimesheetAction({
        idempotencyKey,
        operation: "create",
        periodEnd: "2027-07-12",
        periodStart: root.periodStart,
        surprise: "not allowed",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
  });

  it("fails closed on partial or non-scalar list and history cursors", () => {
    expect(() =>
      buildOwnTimesheetPath({
        cursorPeriodStart: [root.periodStart],
        cursorTimesheetId: [root.timesheetId],
      }),
    ).toThrowError(TimesheetUiError);
    expect(() =>
      buildTimesheetDetailPath(root.timesheetId, {
        cursorTimesheetVersionId: [root.currentVersion.timesheetVersionId],
        cursorVersion: ["1"],
      }),
    ).toThrowError(TimesheetUiError);
  });
});
