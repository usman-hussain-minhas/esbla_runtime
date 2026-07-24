import { describe, expect, it } from "vitest";
import { parseHrTimesheetEditDraftBody } from "./hr-timesheet-api.js";

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
});
