import type { PresentationWidgetDefinition, PresentationWidgetState } from "@esbla/contracts";
import { type CSSProperties, createElement, type ReactNode } from "react";
import type { ResponsivePresentationWidgetPlacement } from "../../../../lib/presentation-layout-core";

type WidgetStyle = CSSProperties & Readonly<Record<`--widget-${string}`, number>>;

export interface PresentationWidgetFrameProps {
  readonly action?: ReactNode;
  readonly children?: ReactNode;
  readonly definition: PresentationWidgetDefinition;
  readonly leadingIcon?: ReactNode;
  readonly placement: ResponsivePresentationWidgetPlacement;
  readonly state: PresentationWidgetState;
}

export interface PresentationWidgetStateContentProps {
  readonly children?: ReactNode;
  readonly description?: string;
  readonly heading?: string;
  readonly icon?: ReactNode;
  readonly state: PresentationWidgetState;
}

const alertStates = new Set<PresentationWidgetState>([
  "not_found",
  "operational_error",
  "permission_denied",
  "service_inactive",
  "unavailable",
]);

const ineligibleStates = new Set<PresentationWidgetState>([
  "not_found",
  "permission_denied",
  "service_inactive",
]);

function widgetStyle(placement: ResponsivePresentationWidgetPlacement): WidgetStyle {
  return {
    "--widget-column": placement.desktop.column,
    "--widget-column-span": placement.desktop.columnSpan,
    "--widget-desktop-column": placement.desktop.column,
    "--widget-desktop-column-span": placement.desktop.columnSpan,
    "--widget-desktop-row": placement.desktop.row,
    "--widget-desktop-row-span": placement.desktop.rowSpan,
    "--widget-phone-column": placement.phone.column,
    "--widget-phone-column-span": placement.phone.columnSpan,
    "--widget-phone-row": placement.phone.row,
    "--widget-phone-row-span": placement.phone.rowSpan,
    "--widget-row": placement.desktop.row,
    "--widget-row-span": placement.desktop.rowSpan,
    "--widget-tablet-column": placement.tablet.column,
    "--widget-tablet-column-span": placement.tablet.columnSpan,
    "--widget-tablet-row": placement.tablet.row,
    "--widget-tablet-row-span": placement.tablet.rowSpan,
  };
}

export function PresentationWidgetFrame({
  action,
  children,
  definition,
  leadingIcon,
  placement,
  state,
}: PresentationWidgetFrameProps) {
  const instanceId = placement.desktop.instanceId;
  const busy = state === "loading" || state === "stale_retrying";
  return createElement(
    "article",
    {
      ...(busy ? { "aria-busy": true } : {}),
      "aria-labelledby": `${instanceId}-heading`,
      className: "zen-widget",
      "data-surface-instance": instanceId,
      "data-widget-definition": definition.id,
      "data-widget-state": state,
      style: widgetStyle(placement),
    },
    createElement(
      "header",
      { className: "zen-widget-header" },
      createElement(
        "div",
        { className: "zen-widget-title" },
        leadingIcon,
        createElement("h2", { id: `${instanceId}-heading` }, definition.displayName),
      ),
      ineligibleStates.has(state) ? null : action,
    ),
    createElement("div", { className: "zen-widget-body" }, children),
  );
}

export function PresentationWidgetStateContent({
  children,
  description,
  heading,
  icon,
  state,
}: PresentationWidgetStateContentProps) {
  if (state === "populated") {
    return createElement("div", { className: "zen-widget-populated" }, children);
  }
  if (!heading || !description) {
    throw new TypeError("A non-populated widget state requires truthful copy");
  }
  const live = state === "loading" || state === "stale_retrying";
  return createElement(
    "div",
    {
      ...(live ? { "aria-live": "polite" } : {}),
      ...(alertStates.has(state) ? { role: "alert" } : {}),
      className: `zen-widget-state zen-widget-state-${state}`,
    },
    icon,
    createElement("strong", null, heading),
    createElement("p", null, description),
  );
}
