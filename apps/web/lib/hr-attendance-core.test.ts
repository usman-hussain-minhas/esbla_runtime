import { describe, expect, it } from "vitest";
import {
  ATTENDANCE_AUTHORIZED_ACTIONS,
  AttendanceUiError,
  attendanceStateForError,
  buildAttendanceDetailQuery,
  buildAttendanceListQuery,
  canRenderAttendanceAction,
  decodeAttendanceMutation,
  decodeAttendanceRead,
  decodeAttendanceServiceControl,
  decodeAttendanceServiceMutation,
  hasAttendanceAction,
  isAttendanceServiceActionOnlyFallback,
  isAttendanceServiceOperation,
  parseAttendanceActions,
  validateAttendanceAction,
  validateAttendanceServiceAction,
} from "./hr-attendance-core";

const ids = {
  correction: "30000000-0000-4000-8000-000000000003",
  observation: "30000000-0000-4000-8000-000000000002",
  receipt: "30000000-0000-4000-8000-000000000004",
  worker: "30000000-0000-4000-8000-000000000001",
} as const;
const observation = {
  attendanceObservationId: ids.observation,
  observationKind: "presence_start",
  observedAt: "2026-07-24T08:30:00.000Z",
  sourceKind: "manual",
  version: 1,
  workerProfileId: ids.worker,
} as const;
const correction = {
  attendanceCorrectionId: ids.correction,
  attendanceObservationId: ids.observation,
  correctedObservationKind: "presence_end",
  correctedObservedAt: "2026-07-24T09:00:00.000Z",
  createdAt: "2026-07-24T09:01:00.000Z",
  reason: "Corrected",
  supersedesAttendanceCorrectionId: null,
  version: 1,
} as const;
const serviceControl = {
  activationState: "active",
  activationVersion: 1,
  serviceKey: "attendance",
  settings: {
    correctionNoteRequired: true,
    manualObservationKinds: "presence_start,presence_end",
  },
  settingsVersion: 1,
  updatedAt: "2026-07-24T09:02:00.000Z",
  version: 1,
} as const;
function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    headers: {
      "x-esbla-attendance-actions":
        '["activate_service","configure_service","correct","deactivate_service","list_own","list_reports","record_manual","view_detail","view_service_control"]',
      ...headers,
    },
    status,
  });
}

describe("Attendance rendered boundary", () => {
  it("accepts only a canonical bounded current-action projection", () => {
    const actions = parseAttendanceActions(response({}));
    expect(actions).toEqual(ATTENDANCE_AUTHORIZED_ACTIONS);
    expect(hasAttendanceAction(actions, "correct")).toBe(true);
    expect(canRenderAttendanceAction(actions, "success", "record_manual")).toBe(true);
    expect(canRenderAttendanceAction(actions, "error", "record_manual")).toBe(false);
    for (const invalid of [
      undefined,
      "",
      "[ ]",
      '["view_detail","list_own"]',
      '["list_own","list_own"]',
      '["unknown"]',
      "{}",
    ]) {
      const candidate = new Response(null, {
        headers: invalid === undefined ? {} : { "x-esbla-attendance-actions": invalid },
      });
      expect(() => parseAttendanceActions(candidate)).toThrow(AttendanceUiError);
    }
  });

  it("decodes exact read, mutation and strict Problem Details responses", async () => {
    await expect(
      decodeAttendanceRead(
        response({ accessScope: "own", items: [observation], nextCursor: null }),
        "list",
      ),
    ).resolves.toMatchObject({ accessScope: "own", items: [observation] });
    await expect(
      decodeAttendanceRead(
        response({ ...observation, corrections: { items: [correction], nextCursor: null } }),
        "detail",
      ),
    ).resolves.toMatchObject({ corrections: { items: [correction] } });
    await expect(
      decodeAttendanceMutation(
        response(observation, 201, { "idempotent-replayed": "false" }),
        "record_manual",
      ),
    ).resolves.toEqual(observation);
    await expect(
      decodeAttendanceMutation(
        response(correction, 200, { "idempotent-replayed": "true" }),
        "correct",
      ),
    ).resolves.toEqual(correction);
    const problem = {
      code: "ATTENDANCE_SERVICE_INACTIVE",
      detail: "Attendance service is inactive",
      instance: "/v1/hr/attendance-observations/own",
      requestId: ids.receipt,
      status: 503,
      title: "Service Unavailable",
      type: "urn:esbla:problem:attendance_service_inactive",
    };
    await expect(
      decodeAttendanceRead(
        response(problem, 503, { "content-type": "application/problem+json" }),
        "list",
      ),
    ).rejects.toMatchObject({ kind: "inactive" });
    expect(attendanceStateForError(new AttendanceUiError("inactive"))).toMatchObject({
      kind: "inactive",
      title: "Attendance inactive",
    });
    for (const code of [
      "ACTIVATION_CONFLICT",
      "ATTENDANCE_CONFLICT",
      "ATTENDANCE_VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
    ]) {
      await expect(
        decodeAttendanceServiceControl(
          response(
            {
              ...problem,
              code,
              detail: "Attendance currentness check failed",
              status: 409,
              title: "Conflict",
              type: `urn:esbla:problem:${code.toLowerCase()}`,
            },
            409,
            { "content-type": "application/problem+json" },
          ),
        ),
      ).rejects.toMatchObject({ httpStatus: 409, kind: "conflict" });
    }
  });

  it("validates paired cursors, date periods and exact mutation forms", () => {
    expect(
      buildAttendanceListQuery({
        cursorAttendanceObservationId: ids.observation,
        cursorObservedAt: observation.observedAt,
        from: "2026-07-01",
        pageSize: "10",
        to: "2026-07-24",
      }).toString(),
    ).toBe(
      `rangeStart=2026-07-01T00%3A00%3A00.000Z&rangeEnd=2026-07-25T00%3A00%3A00.000Z&pageSize=10&cursorAttendanceObservationId=${ids.observation}&cursorObservedAt=2026-07-24T08%3A30%3A00.000Z`,
    );
    expect(
      buildAttendanceDetailQuery({
        cursorAttendanceCorrectionId: ids.correction,
        cursorCorrectionVersion: "1",
        pageSize: "25",
      }).toString(),
    ).toBe(`pageSize=25&cursorAttendanceCorrectionId=${ids.correction}&cursorCorrectionVersion=1`);
    expect(() =>
      buildAttendanceListQuery({ cursorAttendanceObservationId: ids.observation }),
    ).toThrow(AttendanceUiError);
    expect(() => buildAttendanceDetailQuery({ cursorCorrectionVersion: "1" })).toThrow(
      AttendanceUiError,
    );

    expect(
      validateAttendanceAction({
        idempotencyKey: ids.receipt,
        observationKind: "presence_start",
        observedAt: observation.observedAt,
        operation: "record_manual",
        workerProfileId: ids.worker,
      }),
    ).toMatchObject({
      ok: true,
      value: { body: { observationKind: "presence_start" }, operation: "record_manual" },
    });
    expect(
      validateAttendanceAction({
        correctedObservationKind: "presence_end",
        correctedObservedAt: correction.correctedObservedAt,
        expectedCurrentCorrectionId: "",
        expectedCurrentCorrectionVersion: "",
        idempotencyKey: ids.receipt,
        observationId: ids.observation,
        operation: "correct",
        reason: "Corrected",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        body: {
          expectedCurrentCorrectionId: null,
          expectedCurrentCorrectionVersion: null,
        },
        observationId: ids.observation,
        operation: "correct",
      },
    });
    expect(
      validateAttendanceAction({
        idempotencyKey: ids.receipt,
        observationKind: "presence_start",
        observedAt: observation.observedAt,
        operation: "record_manual",
        unexpected: "field",
        workerProfileId: ids.worker,
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
  });

  it("binds strict Attendance service control forms and response continuity", async () => {
    const actions = parseAttendanceActions(
      response({}, 200, {
        "x-esbla-attendance-actions":
          '["activate_service","configure_service","correct","deactivate_service","list_own","list_reports","record_manual","view_detail","view_service_control"]',
      }),
    );
    expect(actions).toEqual([
      "activate_service",
      "configure_service",
      "correct",
      "deactivate_service",
      "list_own",
      "list_reports",
      "record_manual",
      "view_detail",
      "view_service_control",
    ]);
    expect(isAttendanceServiceOperation("configure_service")).toBe(true);
    expect(
      validateAttendanceServiceAction({
        expectedVersion: "",
        idempotencyKey: ids.receipt,
        operation: "activate_service",
      }),
    ).toMatchObject({
      ok: true,
      value: { body: { expectedVersion: null }, operation: "activate_service" },
    });
    expect(
      validateAttendanceServiceAction({
        correctionNoteRequired: "true",
        expectedSettingsVersion: "1",
        idempotencyKey: ids.receipt,
        manualObservationKinds: "presence_end,presence_start",
        operation: "configure_service",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        body: {
          expectedSettingsVersion: 1,
          settings: {
            correctionNoteRequired: true,
            manualObservationKinds: "presence_start,presence_end",
          },
        },
        operation: "configure_service",
      },
    });
    for (const invalid of [
      {
        correctionNoteRequired: "false",
        expectedSettingsVersion: "1",
        idempotencyKey: ids.receipt,
        manualObservationKinds: "presence_start",
        operation: "configure_service",
      },
      {
        correctionNoteRequired: "true",
        expectedSettingsVersion: "1",
        idempotencyKey: ids.receipt,
        manualObservationKinds: "presence_start,presence_start",
        operation: "configure_service",
      },
      {
        expectedVersion: "1",
        extra: "field",
        idempotencyKey: ids.receipt,
        operation: "deactivate_service",
      },
    ]) {
      expect(validateAttendanceServiceAction(invalid)).toMatchObject({
        ok: false,
        state: { kind: "validation" },
      });
    }
    await expect(decodeAttendanceServiceControl(response(serviceControl))).resolves.toEqual(
      serviceControl,
    );
    await expect(
      decodeAttendanceServiceMutation(
        response(serviceControl, 200, { "idempotent-replayed": "false" }),
        {
          body: { expectedVersion: null },
          idempotencyKey: ids.receipt,
          operation: "activate_service",
        },
      ),
    ).resolves.toEqual(serviceControl);
    await expect(
      decodeAttendanceServiceMutation(
        response({ ...serviceControl, serviceKey: "shift_assignment" }),
        {
          body: { expectedVersion: null },
          idempotencyKey: ids.receipt,
          operation: "activate_service",
        },
      ),
    ).rejects.toMatchObject({ kind: "operational_error" });
    expect(isAttendanceServiceActionOnlyFallback("denied", true)).toBe(true);
    expect(isAttendanceServiceActionOnlyFallback("denied", false)).toBe(false);
    for (const failure of [
      "dependency_unavailable",
      "inactive",
      "not_found",
      "operational_error",
    ] as const) {
      expect(isAttendanceServiceActionOnlyFallback(failure, true)).toBe(false);
    }
  });
});
