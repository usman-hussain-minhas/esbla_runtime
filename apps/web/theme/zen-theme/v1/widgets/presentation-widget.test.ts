import { HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION, presentationWidgetStates } from "@esbla/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PresentationWidgetFrame, PresentationWidgetStateContent } from "./presentation-widget";

const placement = {
  desktop: {
    column: 2,
    columnSpan: 4,
    instanceId: "mission-control.my-leave",
    row: 5,
    rowSpan: 3,
    widgetDefinitionId: "hr.leave.my-requests",
    widgetDefinitionVersion: 1,
  },
  phone: {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.my-leave",
    row: 1,
    rowSpan: 3,
    widgetDefinitionId: "hr.leave.my-requests",
    widgetDefinitionVersion: 1,
  },
  tablet: {
    column: 5,
    columnSpan: 4,
    instanceId: "mission-control.my-leave",
    row: 1,
    rowSpan: 3,
    widgetDefinitionId: "hr.leave.my-requests",
    widgetDefinitionVersion: 1,
  },
} as const;

function messageState(state: Exclude<(typeof presentationWidgetStates)[number], "populated">) {
  return createElement(PresentationWidgetStateContent, {
    description: `Safe ${state} guidance`,
    heading: `State ${state}`,
    state,
  });
}

describe("shared presentation widget states", () => {
  it.each(presentationWidgetStates)("renders the complete %s state deliberately", (state) => {
    const body =
      state === "populated"
        ? createElement(
            PresentationWidgetStateContent,
            { state: "populated" },
            createElement("p", null, "Current authorized content"),
          )
        : messageState(state);
    const html = renderToStaticMarkup(
      createElement(
        PresentationWidgetFrame,
        {
          definition: HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
          placement,
          state,
        },
        body,
      ),
    );

    expect(html).toContain(`data-widget-state="${state}"`);
    expect(html).toContain('data-widget-definition-version="1"');
    expect(html).not.toContain("stack trace");
    if (state === "loading" || state === "stale_retrying") {
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('aria-live="polite"');
    }
    if (
      [
        "not_found",
        "operational_error",
        "permission_denied",
        "service_inactive",
        "unavailable",
      ].includes(state)
    ) {
      expect(html).toContain('role="alert"');
    }
  });

  it("emits exact desktop, tablet and phone geometry without changing instance identity", () => {
    const html = renderToStaticMarkup(
      createElement(
        PresentationWidgetFrame,
        {
          definition: HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
          placement,
          state: "empty",
        },
        createElement(PresentationWidgetStateContent, {
          description: "Submit a request to see it here.",
          heading: "No leave requests",
          state: "empty",
        }),
      ),
    );
    expect(html).toContain("--widget-desktop-column:2");
    expect(html).toContain("--widget-tablet-column:5");
    expect(html).toContain("--widget-phone-column:1");
    expect(html).toContain('data-surface-instance="mission-control.my-leave"');
  });

  it.each([
    "permission_denied",
    "service_inactive",
    "not_found",
  ] as const)("omits activation affordances for an ineligible %s widget", (state) => {
    const html = renderToStaticMarkup(
      createElement(
        PresentationWidgetFrame,
        {
          action: createElement("a", { href: "/workspace/hr/leave" }, "View all"),
          definition: HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
          placement,
          state,
        },
        messageState(state),
      ),
    );
    expect(html).not.toContain("View all");
    expect(html).not.toContain('href="/workspace/hr/leave"');
  });

  it("preserves an explicit activation affordance for an eligible populated widget", () => {
    const html = renderToStaticMarkup(
      createElement(
        PresentationWidgetFrame,
        {
          action: createElement("a", { href: "/workspace/hr/leave" }, "View all"),
          definition: HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
          placement,
          state: "populated",
        },
        createElement(
          PresentationWidgetStateContent,
          { state: "populated" },
          createElement("p", null, "Current authorized content"),
        ),
      ),
    );
    expect(html).toContain("View all");
    expect(html).toContain('href="/workspace/hr/leave"');
  });
});
