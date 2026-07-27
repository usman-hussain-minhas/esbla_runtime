import { describe, expect, it } from "vitest";
import { HrLeaveListError } from "../../../../lib/hr-leave-list-core";
import { resolveHrLeaveWidgetFailureState } from "./hr-leave-widget-state";

describe("Zen Leave widget failure states", () => {
  it.each([
    ["denied", "denied"],
    ["inactive", "inactive"],
    ["not_found", "not-found"],
    ["error", "error"],
    ["unavailable", "unavailable"],
  ] as const)("maps %s without exposing upstream diagnostics", (kind, state) => {
    expect(resolveHrLeaveWidgetFailureState(new HrLeaveListError(kind))).toMatchObject({
      state,
    });
  });

  it("maps an unrecognized failure to the sanitized error state", () => {
    expect(resolveHrLeaveWidgetFailureState(new Error("private stack"))).toEqual({
      description: "The widget hit an unexpected problem. No private error detail is shown.",
      heading: "Leave could not be loaded",
      state: "error",
    });
  });
});
