import { describe, expect, it } from "vitest";
import { HrLeaveListError } from "../../../../lib/hr-leave-list-core";
import {
  HR_LEAVE_WIDGET_TIMEOUT_STATE,
  resolveHrLeaveWidgetFailureState,
} from "./hr-leave-widget-state";

describe("Zen Leave widget failure states", () => {
  it.each([
    ["denied", "permission_denied"],
    ["inactive", "service_inactive"],
    ["not_found", "not_found"],
    ["error", "operational_error"],
    ["unavailable", "unavailable"],
  ] as const)("maps %s without exposing upstream diagnostics", (kind, state) => {
    expect(resolveHrLeaveWidgetFailureState(new HrLeaveListError(kind))).toMatchObject({
      state,
    });
  });

  it("maps an unrecognized failure to the sanitized error state", () => {
    expect(resolveHrLeaveWidgetFailureState(new Error("private stack"))).toEqual({
      description: "The widget hit an unexpected problem. Reload this page to try the read again.",
      heading: "Leave could not be loaded",
      state: "operational_error",
    });
  });

  it("keeps provider-timeout copy sanitized and explicitly retryable", () => {
    expect(HR_LEAVE_WIDGET_TIMEOUT_STATE).toEqual({
      description: "The Leave read took too long. Reload this page to try it again.",
      heading: "Leave is taking too long",
      state: "unavailable",
    });
    expect(Object.isFrozen(HR_LEAVE_WIDGET_TIMEOUT_STATE)).toBe(true);
  });
});
