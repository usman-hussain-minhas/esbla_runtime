import { describe, expect, it } from "vitest";
import {
  parseHrShiftAssignBody,
  parseHrShiftAssignmentPath,
  parseHrShiftAssignmentResponse,
  parseHrShiftCreateRosterBody,
  parseHrShiftDetailQuery,
  parseHrShiftListQuery,
  parseHrShiftListResponse,
  parseHrShiftPublishRosterBody,
  parseHrShiftRosterPath,
  parseHrShiftRosterResponse,
} from "./hr-shift-assignment-api.js";

const rosterVersionId = "10000000-0000-4000-8000-000000000001";
const shiftAssignmentId = "10000000-0000-4000-8000-000000000002";
const workerProfileId = "10000000-0000-4000-8000-000000000003";
const occurredAt = "2026-07-23T08:00:00.000Z";

describe("HR Shift Assignment API contracts", () => {
  it("accepts only exact mutation bodies and server identifiers", () => {
    expect(
      parseHrShiftCreateRosterBody({ periodEnd: "2026-07-26", periodStart: "2026-07-20" }),
    ).toEqual({ periodEnd: "2026-07-26", periodStart: "2026-07-20" });
    expect(
      parseHrShiftAssignBody({
        endsAt: "2026-07-20T17:00:00+05:00",
        ianaTimezone: "Asia/Karachi",
        startsAt: "2026-07-20T09:00:00+05:00",
        workerProfileId,
      }),
    ).toMatchObject({ ianaTimezone: "Asia/Karachi", workerProfileId });
    expect(parseHrShiftPublishRosterBody({ expectedVersion: 2 })).toEqual({
      expectedVersion: 2,
    });
    expect(parseHrShiftRosterPath({ rosterVersionId })).toEqual({ rosterVersionId });
    expect(parseHrShiftAssignmentPath({ shiftAssignmentId })).toEqual({ shiftAssignmentId });
    expect(parseHrShiftDetailQuery({})).toEqual({});

    for (const invalid of [
      { periodEnd: "2026-07-26", periodStart: "2026-07-20", tenantId: rosterVersionId },
      { periodEnd: "2026-02-30", periodStart: "2026-02-01" },
      { expectedVersion: 0 },
      { expectedVersion: 1, actorPrincipalId: workerProfileId },
      { shiftAssignmentId: "not-a-uuid" },
      {
        endsAt: "2026-07-20T17:00:00+05:00",
        ianaTimezone: "Not/A_Zone",
        startsAt: "2026-07-20T09:00:00+05:00",
        workerProfileId,
      },
    ]) {
      expect(() =>
        "periodEnd" in invalid
          ? parseHrShiftCreateRosterBody(invalid)
          : "ianaTimezone" in invalid
            ? parseHrShiftAssignBody(invalid)
            : "shiftAssignmentId" in invalid
              ? parseHrShiftAssignmentPath(invalid)
              : parseHrShiftPublishRosterBody(invalid),
      ).toThrow(TypeError);
    }
  });

  it("requires one exact bounded list shape and a paired stable cursor", () => {
    expect(
      parseHrShiftListQuery({
        mode: "own",
        pageSize: 25,
        rangeEnd: "2026-08-01T00:00:00Z",
        rangeStart: "2026-07-01T00:00:00Z",
      }),
    ).toMatchObject({ mode: "own", pageSize: 25 });
    expect(
      parseHrShiftListQuery({
        cursorShiftAssignmentId: shiftAssignmentId,
        cursorStartsAt: occurredAt,
        mode: "roster",
        pageSize: 50,
        rosterVersionId,
        status: "active",
      }),
    ).toMatchObject({ mode: "roster", rosterVersionId, status: "active" });

    for (const invalid of [
      { mode: "own", rangeStart: occurredAt },
      {
        cursorStartsAt: occurredAt,
        mode: "own",
        rangeEnd: "2026-08-01T00:00:00Z",
        rangeStart: "2026-07-01T00:00:00Z",
      },
      {
        mode: "roster",
        rosterVersionId,
      },
      {
        mode: "roster",
        pageSize: 51,
        rosterVersionId,
        status: "active",
      },
      {
        mode: "own",
        rangeEnd: "2026-08-01T00:00:00Z",
        rangeStart: "2026-07-01T00:00:00Z",
        workerProfileId,
      },
    ]) {
      expect(() => parseHrShiftListQuery(invalid)).toThrow(TypeError);
    }
  });

  it("parses privacy-minimized roster, assignment history, and page responses", () => {
    const roster = parseHrShiftRosterResponse({
      periodEnd: "2026-07-26",
      periodStart: "2026-07-20",
      periodVersion: 1,
      publishedAt: null,
      rosterVersionId,
      status: "draft",
      supersedesRosterVersionId: null,
      version: 1,
    });
    expect(roster.status).toBe("draft");

    const assignment = {
      endsAt: "2026-07-20T12:00:00.000Z",
      ianaTimezone: "Asia/Karachi",
      rosterVersionId,
      shiftAssignmentId,
      startsAt: "2026-07-20T04:00:00.000Z",
      status: "active",
      version: 1,
      workerProfileId,
    } as const;
    const detail = parseHrShiftAssignmentResponse({
      assignment,
      history: [
        {
          eventType: "hr.shift_assignment.assign_shift",
          newState: "active",
          occurredAt,
          priorState: null,
        },
      ],
    });
    expect(detail.history).toHaveLength(1);

    expect(
      parseHrShiftListResponse({
        accessScope: "own",
        items: [assignment],
        nextCursor: { shiftAssignmentId, startsAt: assignment.startsAt },
      }),
    ).toMatchObject({ accessScope: "own" });

    for (const privateField of ["tenantId", "actorPrincipalId", "correlationId"]) {
      expect(() =>
        parseHrShiftAssignmentResponse({
          assignment: { ...assignment, [privateField]: rosterVersionId },
          history: detail.history,
        }),
      ).toThrow(TypeError);
    }
  });
});
