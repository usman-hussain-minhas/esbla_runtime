import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildHrLeaveDetailHref,
  buildHrLeaveListHref,
  buildHrLeaveNewHref,
  getHrLeaveReturnLink,
  HR_LEAVE_CANONICAL_HOST_LINK,
  isHrLeaveRouteOriginCompatible,
  parseHrLeaveListCursor,
  parseHrLeaveOriginFocusId,
  parseHrLeaveReturnContext,
  resolveHrLeaveInterceptedFocusNavigation,
} from "./hr-leave-navigation-core";
import {
  createRouteBackedWidgetOrigin,
  parseRouteBackedWidgetOrigin,
} from "./route-backed-widget-navigation-core";

const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("HR leave closed navigation", () => {
  it("parses and maps only the four exact scalar return contexts", () => {
    expect(parseHrLeaveReturnContext("leave-list")).toBe("leave-list");
    expect(parseHrLeaveReturnContext("my-work")).toBe("my-work");
    expect(parseHrLeaveReturnContext("mission-control")).toBe("mission-control");
    expect(parseHrLeaveReturnContext("hr-mission-control")).toBe("hr-mission-control");
    expect(getHrLeaveReturnLink("leave-list")).toEqual({
      href: "/workspace/hr/leave",
      label: "Back to My Leave Requests",
    });
    expect(HR_LEAVE_CANONICAL_HOST_LINK).toEqual({
      href: "/workspace/hr/leave",
      label: "Back to My Leave Requests",
    });
    expect(getHrLeaveReturnLink("my-work")).toEqual({
      href: "/workspace/my-work",
      label: "Back to My Work",
    });
    expect(getHrLeaveReturnLink("mission-control")).toEqual({
      href: "/",
      label: "Back to Mission Control",
    });
    expect(getHrLeaveReturnLink("hr-mission-control")).toEqual({
      href: "/workspace/hr",
      label: "Back to HR Mission Control",
    });
  });

  it("rejects missing, repeated, unknown, path-like and URL-like contexts plus invalid IDs", () => {
    for (const value of [
      undefined,
      ["leave-list"],
      ["leave-list", "my-work"],
      "",
      "Leave-list",
      "my-work/../leave",
      "/workspace/my-work",
      "https://attacker.example",
      "//attacker.example",
    ]) {
      const parsed = parseHrLeaveReturnContext(value);
      expect(parsed).toBeUndefined();
      expect(getHrLeaveReturnLink(parsed)).toBeUndefined();
    }
    expect(() => buildHrLeaveDetailHref("bad", "leave-list")).toThrow(
      "Leave request ID is invalid",
    );
    expect(() => buildHrLeaveDetailHref("https://attacker.example", "my-work")).toThrow(
      "Leave request ID is invalid",
    );
    expect(() =>
      buildHrLeaveDetailHref(leaveRequestId, "https://attacker.example" as "my-work"),
    ).toThrow("Leave return context is invalid");
  });

  it("builds UUID-only detail hrefs with a closed context", () => {
    expect(buildHrLeaveDetailHref(leaveRequestId, "leave-list")).toBe(
      `/workspace/hr/leave/${leaveRequestId}?returnContext=leave-list`,
    );
    expect(buildHrLeaveDetailHref(leaveRequestId, "my-work")).toBe(
      `/workspace/hr/leave/${leaveRequestId}?returnContext=my-work`,
    );
    expect(() =>
      buildHrLeaveDetailHref(
        leaveRequestId,
        "mission-control",
        `mission-control.my-leave.${leaveRequestId}`,
      ),
    ).toThrow("Leave surface origin does not match its return context");
  });

  it("never emits legacy Mission Control tokens without an exact registered origin", () => {
    const navigation = {
      originFocusId: `mission-control.my-leave.${leaveRequestId}`,
      returnContext: "mission-control" as const,
    };

    expect(() => buildHrLeaveListHref(navigation)).toThrow(
      "Leave surface origin does not match its return context",
    );
    expect(() => buildHrLeaveNewHref(navigation)).toThrow(
      "Leave surface origin does not match its return context",
    );
    expect(() =>
      buildHrLeaveDetailHref(leaveRequestId, navigation.returnContext, navigation.originFocusId),
    ).toThrow("Leave surface origin does not match its return context");
    expect(parseHrLeaveOriginFocusId(navigation.originFocusId)).toBe(navigation.originFocusId);
  });

  it("resolves an intercepted Leave list to canonical navigation when its origin is absent or incompatible", () => {
    for (const search of [
      {},
      {
        originFocusId: "hr-workforce.my-profile.full-screen",
        originWidgetDefinitionId: "hr.workforce.my-profile",
        returnSurface: "surface.hr.workforce",
      },
    ]) {
      const fallbackOrigin = parseRouteBackedWidgetOrigin(
        search,
        "/workspace/hr",
        "/workspace/hr/leave",
      );
      expect(resolveHrLeaveInterceptedFocusNavigation(fallbackOrigin)).toEqual({
        returnContext: "leave-list",
      });
    }
  });

  it("preserves an exact grouped surface and semantic widget across nested routes", () => {
    const routeOrigin = createRouteBackedWidgetOrigin(
      "surface.hr.requests-and-claims",
      "hr-requests-and-claims.my-leave.full-screen",
      "hr.leave.my-requests",
    );
    const navigation = {
      originFocusId: routeOrigin.returnFocusId,
      routeOrigin,
      returnContext: "hr-mission-control" as const,
    };

    expect(buildHrLeaveListHref(navigation)).toBe(
      "/workspace/hr/leave?originFocusId=hr-requests-and-claims.my-leave.full-screen&returnSurface=surface.hr.requests-and-claims&originWidgetDefinitionId=hr.leave.my-requests",
    );
    expect(buildHrLeaveNewHref(navigation)).toBe(
      "/workspace/hr/leave/new?returnContext=hr-mission-control&originFocusId=hr-requests-and-claims.my-leave.full-screen&returnSurface=surface.hr.requests-and-claims&originWidgetDefinitionId=hr.leave.my-requests",
    );
    expect(
      buildHrLeaveDetailHref(
        leaveRequestId,
        navigation.returnContext,
        navigation.originFocusId,
        undefined,
        routeOrigin,
      ),
    ).toBe(
      `/workspace/hr/leave/${leaveRequestId}?returnContext=hr-mission-control&originFocusId=hr-requests-and-claims.my-leave.full-screen&returnSurface=surface.hr.requests-and-claims&originWidgetDefinitionId=hr.leave.my-requests`,
    );
    expect(() =>
      buildHrLeaveNewHref({
        ...navigation,
        originFocusId: "hr-requests-and-claims.leave-history.full-screen",
      }),
    ).toThrow("Leave surface origin does not match its return context");
    expect(
      isHrLeaveRouteOriginCompatible("hr-mission-control", navigation.originFocusId, routeOrigin),
    ).toBe(true);
    expect(
      isHrLeaveRouteOriginCompatible("mission-control", navigation.originFocusId, routeOrigin),
    ).toBe(false);
    const assignedFocusId = `mission-control.leave-assigned.${leaveRequestId}`;
    const assignedOrigin = createRouteBackedWidgetOrigin(
      "surface.mission-control",
      assignedFocusId,
      "hr.leave.assigned",
    );
    expect(isHrLeaveRouteOriginCompatible("mission-control", assignedFocusId, assignedOrigin)).toBe(
      true,
    );
    expect(
      buildHrLeaveDetailHref(
        leaveRequestId,
        "mission-control",
        assignedFocusId,
        undefined,
        assignedOrigin,
      ),
    ).toContain("originWidgetDefinitionId=hr.leave.assigned");
  });

  it("keeps standalone list navigation canonical and rejects unsafe focus identifiers", () => {
    expect(buildHrLeaveListHref()).toBe("/workspace/hr/leave");
    expect(buildHrLeaveListHref({ returnContext: "leave-list" })).toBe("/workspace/hr/leave");
    expect(buildHrLeaveNewHref()).toBe("/workspace/hr/leave/new");
    expect(
      buildHrLeaveListHref(undefined, {
        leaveRequestId,
        submittedAt: "2026-08-02T01:02:03.000Z",
      }),
    ).toBe(
      `/workspace/hr/leave?cursorLeaveRequestId=${leaveRequestId}&cursorSubmittedAt=2026-08-02T01%3A02%3A03.000Z`,
    );
    const cursor = {
      leaveRequestId,
      submittedAt: "2026-08-02T01:02:03.000Z",
    };
    expect(
      parseHrLeaveListCursor({
        cursorLeaveRequestId: cursor.leaveRequestId,
        cursorSubmittedAt: cursor.submittedAt,
      }),
    ).toEqual(cursor);
    expect(buildHrLeaveDetailHref(leaveRequestId, "leave-list", undefined, cursor)).toBe(
      `/workspace/hr/leave/${leaveRequestId}?returnContext=leave-list&cursorLeaveRequestId=${leaveRequestId}&cursorSubmittedAt=2026-08-02T01%3A02%3A03.000Z`,
    );
    expect(() => parseHrLeaveListCursor({ cursorLeaveRequestId: leaveRequestId })).toThrowError(
      "Leave cursor is invalid",
    );
    for (const submittedAt of [
      "2026-08-02",
      "2026-02-30T00:00:00.000Z",
      "2026-08-02T25:00:00.000Z",
    ]) {
      expect(() =>
        parseHrLeaveListCursor({
          cursorLeaveRequestId: leaveRequestId,
          cursorSubmittedAt: submittedAt,
        }),
      ).toThrowError("Leave cursor is invalid");
      expect(() => buildHrLeaveListHref(undefined, { leaveRequestId, submittedAt })).toThrowError(
        "Leave cursor is invalid",
      );
    }

    for (const originFocusId of ["../outside", "two..dots", "/absolute", "https://bad"]) {
      expect(parseHrLeaveOriginFocusId(originFocusId)).toBeUndefined();
      expect(() =>
        buildHrLeaveNewHref({ originFocusId, returnContext: "mission-control" }),
      ).toThrow("Leave origin focus ID is invalid");
    }
    expect(() => buildHrLeaveNewHref({ returnContext: "mission-control" })).toThrow(
      "Leave surface origin does not match its return context",
    );
  });

  it("provides source-only wiring checks for five entrypoints and dead flags", async () => {
    const [list, form, detail, detailFace, myWork, approval, rejection] = await Promise.all(
      [
        "../app/workspace/hr/leave/page.tsx",
        "../app/workspace/hr/leave/new/leave-request-form.tsx",
        "../app/workspace/hr/leave/[leaveRequestId]/page.tsx",
        "../app/workspace/hr/leave/[leaveRequestId]/leave-request-detail-face.tsx",
        "../app/workspace/my-work/page.tsx",
        "../components/leave-approval-action.tsx",
        "../app/workspace/my-work/leave-rejection-action.tsx",
      ].map(async (path) => await readFile(new URL(path, import.meta.url), "utf8")),
    );

    expect(form).toContain("buildHrLeaveDetailHref(");
    expect(form).toContain('focusNavigation?.returnContext ?? "leave-list"');
    expect(form).toContain("focusNavigation?.originFocusId");
    expect(form).toContain("decodeHrLeaveSubmitTransport(");
    expect(form).toContain("router.replace(");
    expect(form).not.toContain("parseHrLeaveSubmitTransport");
    expect(list).toContain("buildHrLeaveDetailHref(");
    expect(list).toContain('focusNavigation?.returnContext ?? "leave-list"');
    expect(list).toContain("View details");
    expect(myWork).toContain("toAssignedProviderMasterCursorParameters(productParameters)");
    expect(myWork).toContain("successHref={successHref}");
    expect(approval).toContain('buildHrLeaveDetailHref(result.leaveRequestId, "my-work")');
    expect(rejection).toContain('buildHrLeaveDetailHref(result.leaveRequestId, "my-work")');
    expect(detail).toContain("parseHrLeaveReturnContext(parameters.returnContext)");
    expect(detail).toContain("getHrLeaveReturnLink(returnContext)");
    expect(detail).toContain("HrLeaveRequestDetailFace");
    expect(detailFace).toContain("Evidence history");

    for (const source of [list, form, detail, detailFace, myWork, approval, rejection]) {
      expect(source).not.toMatch(/submitted=1|approved=1|rejected=1|returnTo|document\.referrer/);
    }
  });
});
