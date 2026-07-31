import { ArrowRight, List } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { getOwnLeaveRequests } from "../../../../lib/hr-leave-list";
import { buildHrLeaveDetailHref } from "../../../../lib/hr-leave-navigation-core";
import type { ResponsivePresentationWidgetPlacement } from "../../../../lib/presentation-layout-core";
import { settlePresentationWidgetProviders } from "../../../../lib/presentation-widget-provider-core";
import { buildRouteBackedWidgetHref } from "../../../../lib/route-backed-widget-navigation-core";
import {
  getRegisteredSurfaceInstance,
  getWidgetDefinition,
  type SurfaceDefinition,
} from "../index";
import { SemanticIcon } from "../semantic-icons";
import {
  HR_LEAVE_WIDGET_TIMEOUT_STATE,
  type HrLeaveWidgetFailureState,
  type HrLeaveWidgetState,
  resolveHrLeaveWidgetFailureState,
} from "./hr-leave-widget-state";
import { PresentationWidgetFrame, PresentationWidgetStateContent } from "./presentation-widget";

interface HrLeaveMyRequestsWidgetProps {
  readonly placement: ResponsivePresentationWidgetPlacement;
  readonly surfaceId: SurfaceDefinition["id"];
}

function formatRange(startDate: string, endDate: string): string {
  const format = (value: string) =>
    new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  return startDate === endDate ? format(startDate) : `${format(startDate)}–${format(endDate)}`;
}

function resolveLeaveWidget(
  surfaceId: SurfaceDefinition["id"],
  placement: ResponsivePresentationWidgetPlacement,
) {
  const registered = getRegisteredSurfaceInstance(surfaceId, placement.desktop.instanceId);
  const definition = getWidgetDefinition(
    registered.widgetDefinitionId,
    registered.widgetDefinitionVersion,
  );
  if (
    [placement.desktop, placement.tablet, placement.phone].some(
      (candidate) =>
        candidate.instanceId !== registered.instanceId ||
        candidate.widgetDefinitionId !== registered.widgetDefinitionId ||
        candidate.widgetDefinitionVersion !== registered.widgetDefinitionVersion,
    ) ||
    definition.fullScreenRoute === null
  ) {
    throw new Error("Leave widget registry binding is invalid");
  }
  return {
    definition,
    fullScreenRoute: definition.fullScreenRoute,
    instance: placement,
  };
}

export function HrLeaveMyRequestsWidgetLoading({
  placement,
  surfaceId,
}: Pick<HrLeaveMyRequestsWidgetProps, "placement" | "surfaceId">) {
  const { definition, instance } = resolveLeaveWidget(surfaceId, placement);
  return (
    <PresentationWidgetFrame
      definition={definition}
      leadingIcon={
        <SemanticIcon
          aria-hidden="true"
          semanticKey={definition.semanticIcon}
          size={18}
          strokeWidth={1.7}
        />
      }
      placement={instance}
      state="loading"
    >
      <PresentationWidgetStateContent
        description="Keep this page open while the current authorized requests are read."
        heading="Loading leave requests…"
        state="loading"
      />
    </PresentationWidgetFrame>
  );
}

export async function HrLeaveMyRequestsWidget({
  placement,
  surfaceId,
}: HrLeaveMyRequestsWidgetProps) {
  const { definition, fullScreenRoute, instance } = resolveLeaveWidget(surfaceId, placement);
  const fullScreenControlId = `${instance.desktop.instanceId}.full-screen`;

  let content: ReactNode;
  let state: HrLeaveWidgetState;
  const [provider] = await settlePresentationWidgetProviders<
    Awaited<ReturnType<typeof getOwnLeaveRequests>>,
    HrLeaveWidgetFailureState
  >(
    [
      {
        classifyFailure: (error) => ({
          scope: "provider",
          value: resolveHrLeaveWidgetFailureState(error),
        }),
        eligible: true,
        id: instance.desktop.instanceId,
        load: (signal) => getOwnLeaveRequests(undefined, signal),
        timeoutFailure: {
          scope: "provider",
          value: HR_LEAVE_WIDGET_TIMEOUT_STATE,
        },
      },
    ],
    { concurrency: 1, timeoutMs: 8_000 },
  );
  if (!provider || provider.status === "ineligible") {
    throw new Error("Leave widget provider binding is invalid");
  }
  if (provider.status === "fulfilled") {
    const page = provider.value;
    if (page.items.length === 0) {
      state = "empty";
      content = (
        <PresentationWidgetStateContent
          description="Submitted whole-day requests will appear here."
          heading="No leave requests yet"
          icon={
            <SemanticIcon
              aria-hidden="true"
              semanticKey={definition.semanticIcon}
              size={25}
              strokeWidth={1.6}
            />
          }
          state="empty"
        />
      );
    } else {
      state = "populated";
      content = (
        <PresentationWidgetStateContent state="populated">
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
                    `${instance.desktop.instanceId}.${request.leaveRequestId}`,
                  )}
                  id={`${instance.desktop.instanceId}.${request.leaveRequestId}`}
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
        </PresentationWidgetStateContent>
      );
    }
  } else {
    const failure = provider.failure;
    state = failure.state;
    content = (
      <PresentationWidgetStateContent
        description={failure.description}
        heading={failure.heading}
        icon={
          <SemanticIcon
            aria-hidden="true"
            semanticKey={definition.semanticIcon}
            size={25}
            strokeWidth={1.6}
          />
        }
        state={failure.state}
      />
    );
  }

  const fullScreenEligible =
    state !== "permission_denied" && state !== "service_inactive" && state !== "not_found";
  return (
    <PresentationWidgetFrame
      action={
        fullScreenEligible ? (
          <Link
            aria-label={`View all ${definition.displayName}`}
            className="icon-command"
            href={buildRouteBackedWidgetHref(fullScreenRoute, surfaceId, fullScreenControlId)}
            id={fullScreenControlId}
            title="View all"
          >
            <List aria-hidden="true" size={16} />
          </Link>
        ) : undefined
      }
      definition={definition}
      leadingIcon={
        <SemanticIcon
          aria-hidden="true"
          semanticKey={definition.semanticIcon}
          size={18}
          strokeWidth={1.7}
        />
      }
      placement={instance}
      state={state}
    >
      {content}
    </PresentationWidgetFrame>
  );
}
