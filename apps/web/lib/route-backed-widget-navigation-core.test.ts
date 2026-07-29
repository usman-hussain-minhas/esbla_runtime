import { describe, expect, it } from "vitest";
import {
  buildRouteBackedWidgetHref,
  parseRouteBackedWidgetFallbackHref,
  parseRouteBackedWidgetOrigin,
  parseRouteBackedWidgetReturnFocus,
  serializeRouteBackedWidgetReturnFocus,
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
});
