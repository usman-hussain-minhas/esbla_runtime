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
        "hr.timesheet.mine",
      ),
    ).toBe(
      "/workspace/hr/timesheets?originFocusId=hr-mission-control.my-timesheets.full-screen&returnSurface=surface.hr.mission-control&originWidgetDefinitionId=hr.timesheet.mine",
    );
    expect(
      parseRouteBackedWidgetOrigin(
        {
          originFocusId: "hr-mission-control.my-timesheets.full-screen",
          returnSurface: "hr-mission-control",
        },
        "/",
        "/workspace/hr/timesheets",
      ),
    ).toEqual({
      entryRoute: "/workspace/hr/timesheets",
      expansionMode: "workspace",
      fallbackHref: "/workspace/hr",
      returnFocusId: "hr-mission-control.my-timesheets.full-screen",
      surfaceId: "surface.hr.mission-control",
      widgetDefinitionId: "hr.timesheet.mine",
      widgetDefinitionVersion: 1,
    });
  });

  it("preserves an exact registered grouped-surface and semantic widget envelope", () => {
    expect(
      buildRouteBackedWidgetHref(
        "/workspace/hr/leave",
        "surface.hr.requests-and-claims",
        "hr-requests-and-claims.my-leave.full-screen",
        "hr.leave.my-requests",
      ),
    ).toBe(
      "/workspace/hr/leave?originFocusId=hr-requests-and-claims.my-leave.full-screen&returnSurface=surface.hr.requests-and-claims&originWidgetDefinitionId=hr.leave.my-requests",
    );
    expect(() =>
      buildRouteBackedWidgetHref(
        "/workspace/hr/leave",
        "surface.hr.workforce",
        "hr-requests-and-claims.my-leave.full-screen",
        "hr.leave.my-requests",
      ),
    ).toThrow("Route-backed widget launcher is not registered on the surface");
  });

  it("enforces the registered expansion mode and full-screen route", () => {
    const quickViewHref = buildRouteBackedWidgetHref(
      "/workspace/hr/leave/new",
      "surface.hr.requests-and-claims",
      "hr-requests-and-claims.leave-request-form.full-screen",
      "hr.leave.request-form",
    );
    expect(quickViewHref).toBe(
      "/workspace/hr/leave/new?originFocusId=hr-requests-and-claims.leave-request-form.full-screen&returnSurface=surface.hr.requests-and-claims&originWidgetDefinitionId=hr.leave.request-form",
    );
    expect(
      parseOptionalRouteBackedWidgetOrigin(
        {
          originFocusId: "hr-requests-and-claims.leave-request-form.full-screen",
          originWidgetDefinitionId: "hr.leave.request-form",
          returnSurface: "surface.hr.requests-and-claims",
        },
        "/workspace/hr/leave/new",
      ),
    ).toMatchObject({ expansionMode: "quick_view" });
    expect(() =>
      buildRouteBackedWidgetHref(
        "/workspace/hr/profile/admin",
        "surface.hr.workforce",
        "hr-workforce.status-reporting.full-screen",
        "hr.workforce.status-reporting",
      ),
    ).toThrow("Route-backed widget does not admit expansion");
    expect(() =>
      buildRouteBackedWidgetHref(
        "/workspace/hr/profile",
        "surface.hr.requests-and-claims",
        "hr-requests-and-claims.my-leave.full-screen",
        "hr.leave.my-requests",
      ),
    ).toThrow("Route-backed widget route does not match its semantic admission");
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
        "/workspace/my-work",
      ),
    ).toEqual({
      entryRoute: null,
      expansionMode: null,
      fallbackHref: "/workspace/hr",
      returnFocusId: "route-backed-widget-fallback-focus",
      surfaceId: "surface.hr.mission-control",
      widgetDefinitionId: null,
      widgetDefinitionVersion: null,
    });
    expect(() =>
      buildRouteBackedWidgetHref(
        "https://external.test",
        "surface.mission-control",
        "mission-control.my-work.full-screen",
        "platform.my-work.queue",
      ),
    ).toThrow();
    expect(() =>
      buildRouteBackedWidgetHref(
        "/workspace/my-work",
        "surface.mission-control",
        "invalid origin",
        "platform.my-work.queue",
      ),
    ).toThrow();
    expect(() =>
      buildRouteBackedWidgetHref(
        "/workspace/my-work",
        "surface.mission-control",
        "mission-control.my-work.arbitrary-row",
        "platform.my-work.queue",
      ),
    ).toThrow("Route-backed widget launcher is not registered on the surface");
    expect(
      parseOptionalRouteBackedWidgetOrigin(
        {
          originFocusId: "mission-control.my-work.full-screen",
          returnSurface: "mission-control",
        },
        "/workspace/my-work",
      ),
    ).toEqual({
      entryRoute: "/workspace/my-work",
      expansionMode: "workspace",
      fallbackHref: "/",
      returnFocusId: "mission-control.my-work.full-screen",
      surfaceId: "surface.mission-control",
      widgetDefinitionId: "platform.my-work.queue",
      widgetDefinitionVersion: 1,
    });
    expect(
      parseOptionalRouteBackedWidgetOrigin(
        {
          originFocusId: ["mission-control.my-work.full-screen"],
          returnSurface: "mission-control",
        },
        "/workspace/my-work",
      ),
    ).toBeUndefined();
    expect(
      parseOptionalRouteBackedWidgetOrigin(
        {
          originWidgetDefinitionId: "platform.my-work.queue",
          originFocusId: "mission-control.my-work.full-screen",
          returnSurface: "surface.hr.workforce",
        },
        "/workspace/my-work",
      ),
    ).toBeUndefined();
    expect(
      parseOptionalRouteBackedWidgetOrigin(
        {
          originFocusId: "hr-requests-and-claims.my-leave.full-screen",
          returnSurface: "surface.hr.requests-and-claims",
        },
        "/workspace/hr/leave",
      ),
    ).toBeUndefined();
    expect(
      parseOptionalRouteBackedWidgetOrigin(
        {
          originFocusId: "hr-requests-and-claims.my-leave.full-screen",
          originWidgetDefinitionId: "hr.leave.my-requests",
          returnSurface: "surface.hr.requests-and-claims",
        },
        "/workspace/hr/profile",
      ),
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
      "/workspace/hr/attendance",
    );
    expect(getRouteBackedWidgetOriginParameters(origin)).toEqual({
      originFocusId: "hr-mission-control.my-attendance.full-screen",
      originWidgetDefinitionId: "hr.attendance.my-observations",
      returnSurface: "surface.hr.mission-control",
    });
    expect(
      buildNestedRouteBackedWidgetHref(
        "/workspace/hr/attendance/by-id/record?returnTo=own",
        origin,
      ),
    ).toBe(
      "/workspace/hr/attendance/by-id/record?returnTo=own&originFocusId=hr-mission-control.my-attendance.full-screen&returnSurface=surface.hr.mission-control&originWidgetDefinitionId=hr.attendance.my-observations",
    );
    expect(() => buildNestedRouteBackedWidgetHref("https://external.test", origin)).toThrow();
    for (const destination of [
      String.raw`/\attacker.example/path`,
      "/\n/attacker.example/path",
      "/\r/attacker.example/path",
      "/\t/attacker.example/path",
    ]) {
      expect(() => buildNestedRouteBackedWidgetHref(destination, origin)).toThrow(
        "Nested route-backed widget destination is invalid",
      );
    }
    const fallback = parseRouteBackedWidgetOrigin({}, "/workspace/hr", "/workspace/hr/attendance");
    expect(
      buildNestedRouteBackedWidgetHref("/workspace/hr/attendance?from=2028-08-01", fallback),
    ).toBe("/workspace/hr/attendance?from=2028-08-01");
    expect(() => getRouteBackedWidgetOriginParameters(fallback)).toThrow(
      "Nested route-backed widget origin is not exact",
    );
    expect(() =>
      getRouteBackedWidgetOriginParameters({
        entryRoute: "/workspace/my-work",
        expansionMode: "workspace",
        fallbackHref: "/workspace/my-work",
        returnFocusId: "mission-control.my-work.full-screen",
        surfaceId: "surface.mission-control",
        widgetDefinitionId: "platform.my-work.queue",
        widgetDefinitionVersion: 1,
      }),
    ).toThrow();
  });

  it("strips the presentation envelope before strict Product query parsing", () => {
    expect(
      withoutRouteBackedWidgetOrigin({
        originFocusId: "mission-control.workforce-admin.full-screen",
        originWidgetDefinitionId: "hr.workforce.admin-queue",
        returnSurface: "mission-control",
        status: "active",
      }),
    ).toEqual({ status: "active" });
  });
});
