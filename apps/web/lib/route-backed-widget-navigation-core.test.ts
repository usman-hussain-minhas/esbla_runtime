import { describe, expect, it } from "vitest";
import {
  buildNestedRouteBackedWidgetHref,
  buildRouteBackedWidgetHref,
  getRouteBackedWidgetOriginParameters,
  parseOptionalRouteBackedWidgetOrigin,
  parseRouteBackedWidgetFallbackHref,
  parseRouteBackedWidgetOrigin,
  parseRouteBackedWidgetReturnFocus,
  serializeRouteBackedWidgetReturnFocus,
  withoutRouteBackedWidgetOrigin,
} from "./route-backed-widget-navigation-core";

describe("route-backed widget navigation", () => {
  it("binds the durable route to its exact authorized origin and launcher", () => {
    expect(
      buildRouteBackedWidgetHref(
        "/workspace/hr/timesheets",
        "surface.hr.mission-control",
        "hr-mission-control.my-timesheets.full-screen",
      ),
    ).toBe(
      "/workspace/hr/timesheets?originFocusId=hr-mission-control.my-timesheets.full-screen&returnSurface=hr-mission-control",
    );
    expect(
      parseRouteBackedWidgetOrigin(
        {
          originFocusId: "hr-mission-control.my-timesheets.full-screen",
          returnSurface: "hr-mission-control",
        },
        "/",
      ),
    ).toEqual({
      fallbackHref: "/workspace/hr",
      returnFocusId: "hr-mission-control.my-timesheets.full-screen",
    });
  });

  it("fails closed for duplicate, external, malformed, or unknown origin data", () => {
    expect(parseRouteBackedWidgetFallbackHref("/workspace/my-work")).toBe("/workspace/my-work");
    expect(parseRouteBackedWidgetFallbackHref("https://external.test")).toBeUndefined();
    expect(
      parseRouteBackedWidgetOrigin(
        {
          originFocusId: ["mission-control.my-work.full-screen"],
          returnSurface: "external",
        },
        "/workspace/hr",
      ),
    ).toEqual({
      fallbackHref: "/workspace/hr",
      returnFocusId: "route-backed-widget-fallback-focus",
    });
    expect(() =>
      buildRouteBackedWidgetHref(
        "https://external.test",
        "surface.mission-control",
        "mission-control.my-work.full-screen",
      ),
    ).toThrow();
    expect(() =>
      buildRouteBackedWidgetHref("/workspace/my-work", "surface.mission-control", "invalid origin"),
    ).toThrow();
    expect(
      parseOptionalRouteBackedWidgetOrigin({
        originFocusId: "mission-control.my-work.full-screen",
        returnSurface: "mission-control",
      }),
    ).toEqual({
      fallbackHref: "/",
      returnFocusId: "mission-control.my-work.full-screen",
    });
    expect(
      parseOptionalRouteBackedWidgetOrigin({
        originFocusId: ["mission-control.my-work.full-screen"],
        returnSurface: "mission-control",
      }),
    ).toBeUndefined();
    expect(
      parseOptionalRouteBackedWidgetOrigin({
        originFocusId: "mission-control.my-work.full-screen",
        returnSurface: "external",
      }),
    ).toBeUndefined();
  });

  it("round-trips only an exact current-origin focus receipt", () => {
    expect(
      parseRouteBackedWidgetReturnFocus(
        serializeRouteBackedWidgetReturnFocus({
          fallbackHref: "/workspace/hr",
          returnFocusId: "hr-mission-control.my-timesheets.full-screen",
          scrollLeft: 0,
          scrollTop: 480,
        }),
      ),
    ).toEqual({
      fallbackHref: "/workspace/hr",
      returnFocusId: "hr-mission-control.my-timesheets.full-screen",
      scrollLeft: 0,
      scrollTop: 480,
    });
    expect(
      parseRouteBackedWidgetReturnFocus(
        '{"fallbackHref":"/workspace/hr","returnFocusId":"invalid origin"}',
      ),
    ).toBeUndefined();
    expect(
      parseRouteBackedWidgetReturnFocus(
        '{"fallbackHref":"https://external.test","returnFocusId":"mission-control.my-work.full-screen","scrollLeft":0,"scrollTop":0}',
      ),
    ).toBeUndefined();
    expect(
      parseRouteBackedWidgetReturnFocus(
        '{"extra":true,"fallbackHref":"/","returnFocusId":"mission-control.my-work.full-screen","scrollLeft":0,"scrollTop":0}',
      ),
    ).toBeUndefined();
    expect(
      parseRouteBackedWidgetReturnFocus(
        '{"fallbackHref":"/","returnFocusId":"mission-control.my-work.full-screen","scrollLeft":0,"scrollTop":-1}',
      ),
    ).toBeUndefined();
  });

  it("carries one validated surface origin through nested focus routes", () => {
    const origin = parseRouteBackedWidgetOrigin(
      {
        originFocusId: "hr-mission-control.my-attendance.full-screen",
        returnSurface: "hr-mission-control",
      },
      "/workspace/hr",
    );
    expect(getRouteBackedWidgetOriginParameters(origin)).toEqual({
      originFocusId: "hr-mission-control.my-attendance.full-screen",
      returnSurface: "hr-mission-control",
    });
    expect(
      buildNestedRouteBackedWidgetHref(
        "/workspace/hr/attendance/by-id/record?returnTo=own",
        origin,
      ),
    ).toBe(
      "/workspace/hr/attendance/by-id/record?returnTo=own&originFocusId=hr-mission-control.my-attendance.full-screen&returnSurface=hr-mission-control",
    );
    expect(() => buildNestedRouteBackedWidgetHref("https://external.test", origin)).toThrow();
    expect(() =>
      getRouteBackedWidgetOriginParameters({
        fallbackHref: "/workspace/my-work",
        returnFocusId: "mission-control.my-work.full-screen",
      }),
    ).toThrow();
  });

  it("strips the presentation envelope before strict Product query parsing", () => {
    expect(
      withoutRouteBackedWidgetOrigin({
        originFocusId: "mission-control.workforce-admin.full-screen",
        returnSurface: "mission-control",
        status: "active",
      }),
    ).toEqual({ status: "active" });
  });
});
