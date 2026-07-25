import type { HrServiceControl } from "@esbla/contracts/hr-service-control-api";
import type {
  HrTimesheetListResponse,
  HrTimesheetResponse,
} from "@esbla/contracts/hr-timesheet-api";
import { describe, expect, it } from "vitest";
import {
  buildOwnTimesheetPath,
  buildTimesheetCorrectionDetailHref,
  buildTimesheetDetailPath,
  decodeTimesheetDetail,
  decodeTimesheetList,
  decodeTimesheetMutation,
  decodeTimesheetServiceControl,
  decodeTimesheetServiceMutation,
  isTimesheetServiceOperation,
  parseTimesheetActions,
  TIMESHEET_CORRECTIONS_SURFACE_PATH,
  TimesheetUiError,
  validateTimesheetAction,
  validateTimesheetServiceAction,
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
const control = {
  activationState: "active",
  activationVersion: 1,
  serviceKey: "timesheet",
  settings: {
    maxDailyMinutes: 720,
    periodCadence: "weekly",
    rejectionNoteRequired: true,
  },
  settingsVersion: 1,
  updatedAt: "2027-07-01T00:00:00.000Z",
  version: 1,
} satisfies HrServiceControl;

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("Timesheet rendered boundary", () => {
  it("accepts only a canonical current-authority projection", () => {
    expect(TIMESHEET_CORRECTIONS_SURFACE_PATH).toBe("/workspace/hr/timesheets/admin/corrections");
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
    await expect(
      decodeTimesheetMutation(
        json(root, 201, { "idempotent-replayed": "false" }),
        "create_correction",
      ),
    ).resolves.toEqual(root);
    await expect(
      decodeTimesheetMutation(
        json(root, 200, { "idempotent-replayed": "true" }),
        "create_correction",
      ),
    ).resolves.toEqual(root);
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

  it("validates exact employee, manager, and correction form semantics", () => {
    const idempotencyKey = "60000000-0000-4000-8000-000000000001";
    const expectedForm = {
      expectedRootVersion: "1",
      expectedTimesheetVersionId: root.currentVersion.timesheetVersionId,
      expectedVersion: "1",
      idempotencyKey,
      timesheetId: root.timesheetId,
    };
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
        ...expectedForm,
        operation: "submit",
      }),
    ).toMatchObject({ ok: true, value: { operation: "submit" } });
    expect(
      validateTimesheetAction({
        ...expectedForm,
        decisionNote: "  Reviewed against recorded facts  ",
        operation: "approve",
        returnTo: "my-work",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        body: { decisionNote: "Reviewed against recorded facts" },
        operation: "approve",
        returnTo: "my-work",
      },
    });
    expect(
      validateTimesheetAction({
        ...expectedForm,
        decisionNote: "",
        operation: "reject",
        returnTo: "my-work",
      }),
    ).toMatchObject({ ok: true, value: { body: { decisionNote: null }, operation: "reject" } });
    expect(
      validateTimesheetAction({
        ...expectedForm,
        operation: "create_correction",
        returnTo: "corrections",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: "create_correction", returnTo: "corrections" },
    });
    expect(
      validateTimesheetAction({
        idempotencyKey,
        operation: "create",
        periodEnd: "2027-07-12",
        periodStart: root.periodStart,
        surprise: "not allowed",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
    expect(
      validateTimesheetAction({
        ...expectedForm,
        decisionNote: "Reviewed",
        operation: "approve",
        returnTo: "https://outside.invalid",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
    expect(
      validateTimesheetAction({
        ...expectedForm,
        operation: "create_correction",
        returnTo: "my-work",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
    expect(buildTimesheetCorrectionDetailHref(root.timesheetId)).toBe(
      `/workspace/hr/timesheets/by-id/${root.timesheetId}?returnTo=corrections`,
    );
    expect(() => buildTimesheetCorrectionDetailHref([root.timesheetId])).toThrowError(
      TimesheetUiError,
    );
  });

  it("decodes and validates exact Timesheet service-control actions", async () => {
    await expect(decodeTimesheetServiceControl(json(control))).resolves.toEqual(control);
    const configured = {
      ...control,
      settings: { ...control.settings, rejectionNoteRequired: false },
      settingsVersion: 2,
      version: 2,
    };
    const action = {
      body: {
        expectedSettingsVersion: 1,
        settings: configured.settings,
      },
      idempotencyKey: "60000000-0000-4000-8000-000000000002",
      operation: "configure_service",
    } as const;
    await expect(
      decodeTimesheetServiceMutation(
        json(configured, 200, { "idempotent-replayed": "false" }),
        action,
      ),
    ).resolves.toEqual(configured);
    expect(
      validateTimesheetServiceAction({
        expectedSettingsVersion: "1",
        idempotencyKey: action.idempotencyKey,
        maxDailyMinutes: "720",
        operation: "configure_service",
        periodCadence: "weekly",
        rejectionNoteRequired: "false",
      }),
    ).toEqual({ ok: true, value: action });
    expect(isTimesheetServiceOperation("deactivate_service")).toBe(true);
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
