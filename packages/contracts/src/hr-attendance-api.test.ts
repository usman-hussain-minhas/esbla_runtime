import { describe, expect, it } from "vitest";
import {
  parseHrAttendanceCorrection,
  parseHrAttendanceCorrectionBody,
  parseHrAttendanceObservation,
  parseHrAttendanceRecordManualBody,
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
});
