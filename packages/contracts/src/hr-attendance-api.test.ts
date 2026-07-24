import { describe, expect, it } from "vitest";
import {
  parseHrAttendanceObservation,
  parseHrAttendanceRecordManualBody,
} from "./hr-attendance-api.js";

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
});
