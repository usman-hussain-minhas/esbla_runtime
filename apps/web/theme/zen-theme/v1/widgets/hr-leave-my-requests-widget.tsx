import type { PresentationWidgetPlacement } from "@esbla/contracts";
import { ArrowRight, List } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { getOwnLeaveRequests } from "../../../../lib/hr-leave-list";
import { buildHrLeaveDetailHref } from "../../../../lib/hr-leave-navigation-core";
import {
  getRegisteredSurfaceInstance,
  getWidgetDefinition,
  type SurfaceDefinition,
} from "../index";
import { SemanticIcon } from "../semantic-icons";
import { type HrLeaveWidgetState, resolveHrLeaveWidgetFailureState } from "./hr-leave-widget-state";

interface HrLeaveMyRequestsWidgetProps {
  readonly placement?: PresentationWidgetPlacement;
  readonly surfaceId: SurfaceDefinition["id"];
}

type WidgetStyle = CSSProperties & {
  readonly "--widget-column": number;
  readonly "--widget-column-span": number;
  readonly "--widget-row": number;
  readonly "--widget-row-span": number;
};

function formatRange(startDate: string, endDate: string): string {
  const format = (value: string) =>
    new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  return startDate === endDate ? format(startDate) : `${format(startDate)}–${format(endDate)}`;
}

function widgetStyle(placement: PresentationWidgetPlacement): WidgetStyle {
  return {
    "--widget-column": placement.column,
    "--widget-column-span": placement.columnSpan,
    "--widget-row": placement.row,
    "--widget-row-span": placement.rowSpan,
  };
}

function resolveLeaveWidget(
  surfaceId: SurfaceDefinition["id"],
  placement?: PresentationWidgetPlacement,
) {
  const registered = getRegisteredSurfaceInstance(surfaceId, "hr.leave.my-requests");
  const definition = getWidgetDefinition(
    registered.widgetDefinitionId,
    registered.widgetDefinitionVersion,
  );
  if (
    (placement &&
      (placement.instanceId !== registered.instanceId ||
        placement.widgetDefinitionId !== registered.widgetDefinitionId)) ||
    definition.fullScreenRoute === null
  ) {
    throw new Error("Leave widget registry binding is invalid");
  }
  return {
    definition,
    fullScreenRoute: definition.fullScreenRoute,
    instance: placement ?? registered,
  };
}

export function HrLeaveMyRequestsWidgetLoading({
  placement,
  surfaceId,
}: Pick<HrLeaveMyRequestsWidgetProps, "placement" | "surfaceId">) {
  const { definition, instance } = resolveLeaveWidget(surfaceId, placement);
  return (
    <article
      aria-busy="true"
      aria-labelledby={`${instance.instanceId}-loading-heading`}
      className="zen-widget"
      data-surface-instance={instance.instanceId}
      data-widget-definition={definition.id}
      data-widget-state="loading"
      style={widgetStyle(instance)}
    >
      <header className="zen-widget-header">
        <div className="zen-widget-title">
          <SemanticIcon
            aria-hidden="true"
            semanticKey={definition.semanticIcon}
            size={18}
            strokeWidth={1.7}
          />
          <h2 id={`${instance.instanceId}-loading-heading`}>{definition.displayName}</h2>
        </div>
      </header>
      <div aria-live="polite" className="zen-widget-empty">
        <strong>Loading leave requests…</strong>
      </div>
    </article>
  );
}

export async function HrLeaveMyRequestsWidget({
  placement,
  surfaceId,
}: HrLeaveMyRequestsWidgetProps) {
  const { definition, fullScreenRoute, instance } = resolveLeaveWidget(surfaceId, placement);
  const style = widgetStyle(instance);

  let content: ReactNode;
  let state: HrLeaveWidgetState;
  try {
    const page = await getOwnLeaveRequests();
    if (page.items.length === 0) {
      state = "empty";
      content = (
        <div className="zen-widget-empty">
          <SemanticIcon
            aria-hidden="true"
            semanticKey={definition.semanticIcon}
            size={25}
            strokeWidth={1.6}
          />
          <strong>No leave requests yet</strong>
          <p>Submitted whole-day requests will appear here.</p>
        </div>
      );
    } else {
      state = "populated";
      content = (
        <ol aria-label="My recent leave requests" className="zen-widget-list">
          {page.items.slice(0, 5).map((request) => (
            <li key={request.leaveRequestId}>
              <Link
                className="zen-widget-row"
                href={buildHrLeaveDetailHref(
                  request.leaveRequestId,
                  surfaceId === "surface.mission-control"
                    ? "mission-control"
                    : "hr-mission-control",
                  `${instance.instanceId}.${request.leaveRequestId}`,
                )}
                id={`${instance.instanceId}.${request.leaveRequestId}`}
              >
                <span className={`leave-status leave-status-${request.status}`}>
                  {request.status}
                </span>
                <span>
                  <strong>{formatRange(request.startDate, request.endDate)}</strong>
                  <p>{request.categoryCode} leave</p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      );
    }
  } catch (error) {
    const failure = resolveHrLeaveWidgetFailureState(error);
    state = failure.state;
    content = (
      <div className="zen-widget-empty" role="alert">
        <SemanticIcon
          aria-hidden="true"
          semanticKey={definition.semanticIcon}
          size={25}
          strokeWidth={1.6}
        />
        <strong>{failure.heading}</strong>
        <p>{failure.description}</p>
      </div>
    );
  }

  const card = (
    <article
      aria-labelledby={`${instance.instanceId}-heading`}
      className="zen-widget"
      data-surface-instance={instance.instanceId}
      data-widget-definition={definition.id}
      data-widget-state={state}
      style={style}
    >
      <header className="zen-widget-header">
        <div className="zen-widget-title">
          <SemanticIcon
            aria-hidden="true"
            semanticKey={definition.semanticIcon}
            size={18}
            strokeWidth={1.7}
          />
          <h2 id={`${instance.instanceId}-heading`}>{definition.displayName}</h2>
        </div>
        <a
          aria-label={`View all ${definition.displayName}`}
          className="icon-command"
          href={fullScreenRoute}
          title="View all"
        >
          <List aria-hidden="true" size={16} />
        </a>
      </header>
      <div className="zen-widget-body">{content}</div>
    </article>
  );
  return card;
}
