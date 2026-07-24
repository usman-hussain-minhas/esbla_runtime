import { describe, expect, it } from "vitest";
import {
  parseHrAttendanceCorrection,
  parseHrAttendanceCorrectionBody,
  parseHrAttendanceDetailQuery,
  parseHrAttendanceListResponse,
  parseHrAttendanceObservation,
  parseHrAttendanceObservationResponse,
  parseHrAttendanceOwnListQuery,
  parseHrAttendanceRecordManualBody,
  parseHrAttendanceReportsListQuery,
} from "./hr-attendance-api.js";

const correctionId = "91000000-0000-4000-8000-000000000003";
const observationId = "91000000-0000-4000-8000-000000000001";
const workerProfileId = "91000000-0000-4000-8000-000000000002";
describe("HR Attendance API contracts", () => {
  it("accepts only the exact manual observation input", () => {
    expect(
      parseHrAttendanceRecordManualBody({
        observationKind: "presence_start",
        observedAt: "2026-07-24T08:30:00+05:00",
        workerProfileId,
      }),
    ).toEqual({
      observationKind: "presence_start",
      observedAt: "2026-07-24T08:30:00+05:00",
      workerProfileId,
    });
    for (const invalid of [
      { observationKind: "presence_start", observedAt: "2026-07-24", workerProfileId },
      { observationKind: "break_start", observedAt: "2026-07-24T08:30:00Z", workerProfileId },
      {
        observationKind: "presence_end",
        observedAt: "2026-07-24T08:30:00Z",
        sourceKind: "provider",
        workerProfileId,
      },
      {
        observationKind: "presence_end",
        observedAt: "2026-07-24T08:30:00Z",
        tenantId: workerProfileId,
        workerProfileId,
      },
    ]) {
      expect(() => parseHrAttendanceRecordManualBody(invalid)).toThrow(TypeError);
    }
  });
  it("parses a privacy-minimized immutable observation", () => {
    const observation = {
      attendanceObservationId: observationId,
      observationKind: "presence_start",
      observedAt: "2026-07-24T03:30:00.000Z",
      sourceKind: "manual",
      version: 1,
      workerProfileId,
    } as const;
    expect(parseHrAttendanceObservation(observation)).toEqual(observation);

    for (const privateField of [
      "actorPrincipalId",
      "correlationId",
      "tenantId",
      "deviceId",
      "latitude",
      "providerPayload",
    ]) {
      expect(() =>
        parseHrAttendanceObservation({ ...observation, [privateField]: workerProfileId }),
      ).toThrow(TypeError);
    }
    expect(() => parseHrAttendanceObservation({ ...observation, version: 2 })).toThrow(TypeError);
  });
  it("requires the exact correction currentness pair and privacy-minimized response", () => {
    const first = {
      correctedObservationKind: "presence_end",
      correctedObservedAt: "2026-07-24T08:45:00+05:00",
      expectedCurrentCorrectionId: null,
      expectedCurrentCorrectionVersion: null,
      reason: "Clock corrected",
    };
    expect(parseHrAttendanceCorrectionBody(first)).toEqual(first);
    expect(
      parseHrAttendanceCorrectionBody({
        ...first,
        expectedCurrentCorrectionId: correctionId,
        expectedCurrentCorrectionVersion: 1,
      }),
    ).toMatchObject({
      expectedCurrentCorrectionId: correctionId,
      expectedCurrentCorrectionVersion: 1,
    });
    for (const invalid of [
      { ...first, correctedObservationKind: "break_start" },
      { ...first, correctedObservedAt: "2026-07-24" },
      { ...first, expectedCurrentCorrectionId: correctionId },
      { ...first, expectedCurrentCorrectionVersion: 1 },
      { ...first, reason: " " },
      { ...first, providerPayload: "forbidden" },
    ]) {
      expect(() => parseHrAttendanceCorrectionBody(invalid)).toThrow(TypeError);
    }

    const response = {
      attendanceCorrectionId: correctionId,
      attendanceObservationId: observationId,
      correctedObservationKind: "presence_end",
      correctedObservedAt: "2026-07-24T03:45:00.000Z",
      createdAt: "2026-07-24T03:46:00.000Z",
      reason: "Clock corrected",
      supersedesAttendanceCorrectionId: null,
      version: 1,
    };
    expect(parseHrAttendanceCorrection(response)).toEqual(response);
    for (const privateField of ["actorPrincipalId", "correlationId", "tenantId"]) {
      expect(() =>
        parseHrAttendanceCorrection({ ...response, [privateField]: workerProfileId }),
      ).toThrow(TypeError);
    }
  });
  it("binds strict paired cursors and privacy-minimized read responses", () => {
    const listQuery = {
      cursorAttendanceObservationId: observationId,
      cursorObservedAt: "2026-07-24T03:30:00.000Z",
      pageSize: 25,
      rangeEnd: "2026-07-25T00:00:00.000Z",
      rangeStart: "2026-07-24T00:00:00.000Z",
    };
    expect(parseHrAttendanceOwnListQuery(listQuery)).toEqual(listQuery);
    expect(parseHrAttendanceReportsListQuery(listQuery)).toEqual(listQuery);

    const detailQuery = {
      cursorAttendanceCorrectionId: correctionId,
      cursorCorrectionVersion: 1,
      pageSize: 25,
    };
    expect(parseHrAttendanceDetailQuery(detailQuery)).toEqual(detailQuery);

    for (const invalid of [
      { ...listQuery, cursorObservedAt: undefined },
      { ...listQuery, pageSize: 51 },
      { ...listQuery, rangeEnd: listQuery.rangeStart, rangeStart: listQuery.rangeEnd },
      { ...listQuery, tenantId: workerProfileId },
    ]) {
      expect(() => parseHrAttendanceOwnListQuery(invalid)).toThrow(TypeError);
      expect(() => parseHrAttendanceReportsListQuery(invalid)).toThrow(TypeError);
    }
    for (const invalid of [
      { ...detailQuery, cursorCorrectionVersion: undefined },
      { ...detailQuery, cursorCorrectionVersion: 0 },
      { ...detailQuery, accessScope: "tenant" },
    ]) {
      expect(() => parseHrAttendanceDetailQuery(invalid)).toThrow(TypeError);
    }

    const observation = {
      attendanceObservationId: observationId,
      observationKind: "presence_start",
      observedAt: "2026-07-24T03:30:00.000Z",
      sourceKind: "manual",
      version: 1,
      workerProfileId,
    } as const;
    const correction = {
      attendanceCorrectionId: correctionId,
      attendanceObservationId: observationId,
      correctedObservationKind: "presence_end",
      correctedObservedAt: "2026-07-24T03:45:00.000Z",
      createdAt: "2026-07-24T03:46:00.000Z",
      reason: "Clock corrected",
      supersedesAttendanceCorrectionId: null,
      version: 1,
    } as const;
    const detail = {
      ...observation,
      corrections: {
        items: [correction],
        nextCursor: { attendanceCorrectionId: correctionId, version: 1 },
      },
    } as const;
    expect(parseHrAttendanceObservationResponse(observation)).toEqual(observation);
    expect(parseHrAttendanceObservationResponse(detail)).toEqual(detail);
    const list = {
      accessScope: "own",
      items: [observation],
      nextCursor: { attendanceObservationId: observationId, observedAt: observation.observedAt },
    } as const;
    expect(parseHrAttendanceListResponse(list)).toEqual(list);
    expect(parseHrAttendanceListResponse({ ...list, accessScope: "assigned" })).toMatchObject({
      accessScope: "assigned",
    });
    expect(parseHrAttendanceListResponse({ ...list, accessScope: "tenant" })).toMatchObject({
      accessScope: "tenant",
    });
    expect(() =>
      parseHrAttendanceListResponse({
        accessScope: "own",
        items: [observation],
        nextCursor: null,
        tenantId: workerProfileId,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseHrAttendanceObservationResponse({
        ...detail,
        corrections: {
          items: [{ ...correction, actorPrincipalId: workerProfileId }],
          nextCursor: null,
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseHrAttendanceObservationResponse({
        ...detail,
        corrections: { items: [correction], nextCursor: { version: 1 } },
      }),
    ).toThrow(TypeError);
  });
});
