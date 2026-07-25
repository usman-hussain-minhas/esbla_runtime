import { describe, expect, it } from "vitest";
import {
  parseHrTimesheetApproveBody,
  parseHrTimesheetAssignedListQuery,
  parseHrTimesheetCreateCorrectionBody,
  parseHrTimesheetDetailQuery,
  parseHrTimesheetEditDraftBody,
  parseHrTimesheetOwnListQuery,
  parseHrTimesheetRejectBody,
} from "./hr-timesheet-api.js";

const id = (suffix: string) => `13000000-0000-4000-8000-${suffix}`;

describe("HR Timesheet API contract", () => {
  it("accepts bounded entries and rejects half-paired entry currentness", () => {
    const expected = {
      expectedRootVersion: 1,
      expectedTimesheetVersionId: id("000000000001"),
      expectedVersion: 1,
    };
    expect(
      parseHrTimesheetEditDraftBody({
        ...expected,
        entries: [{ entryDate: "2028-08-01", minutes: 480 }],
      }).entries,
    ).toHaveLength(1);
    expect(() =>
      parseHrTimesheetEditDraftBody({
        ...expected,
        entries: [{ entryDate: "2028-08-01", expectedVersion: 1, minutes: 480 }],
      }),
    ).toThrow(TypeError);
  });

  it("parses strict manager decisions with optional bounded notes", () => {
    const expected = {
      expectedRootVersion: 1,
      expectedTimesheetVersionId: id("000000000001"),
      expectedVersion: 3,
    };
    expect(parseHrTimesheetApproveBody({ ...expected, decisionNote: "Reviewed" })).toEqual({
      ...expected,
      decisionNote: "Reviewed",
    });
    expect(parseHrTimesheetRejectBody(expected)).toEqual(expected);
    expect(() => parseHrTimesheetRejectBody({ ...expected, unknown: true })).toThrow(TypeError);
    expect(() =>
      parseHrTimesheetApproveBody({ ...expected, decisionNote: "x".repeat(2001) }),
    ).toThrow(TypeError);
  });

  it("parses exact correction currentness without accepting extra fields", () => {
    const expected = {
      expectedRootVersion: 1,
      expectedTimesheetVersionId: id("000000000001"),
      expectedVersion: 4,
    };
    expect(parseHrTimesheetCreateCorrectionBody(expected)).toEqual(expected);
    expect(() => parseHrTimesheetCreateCorrectionBody({ ...expected, copyEntries: true })).toThrow(
      TypeError,
    );
  });

  it("requires paired, bounded provider-local cursors", () => {
    const ownCursor = {
      cursorPeriodStart: "2028-08-22",
      cursorTimesheetId: id("000000000001"),
      pageSize: 50,
    };
    const assignedCursor = {
      cursorSubmittedAt: "2028-08-22T10:00:00.123456Z",
      cursorTimesheetVersionId: id("000000000002"),
    };
    expect(parseHrTimesheetOwnListQuery(ownCursor)).toEqual(ownCursor);
    expect(parseHrTimesheetAssignedListQuery(assignedCursor)).toEqual(assignedCursor);
    expect(() => parseHrTimesheetOwnListQuery({ cursorPeriodStart: "2028-08-22" })).toThrow(
      TypeError,
    );
    expect(() =>
      parseHrTimesheetAssignedListQuery({
        cursorSubmittedAt: "2028-08-22T10:00:00Z",
        cursorTimesheetVersionId: id("000000000002"),
      }),
    ).toThrow(TypeError);
    expect(() => parseHrTimesheetDetailQuery({ cursorVersion: 2 })).toThrow(TypeError);
    expect(() => parseHrTimesheetDetailQuery({ pageSize: 51 })).toThrow(TypeError);
  });
});
