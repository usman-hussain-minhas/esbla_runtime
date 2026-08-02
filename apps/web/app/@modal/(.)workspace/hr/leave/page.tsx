import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import HrLeaveRequestPage from "../../../../workspace/hr/leave/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedLeavePage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  const focusNavigation = {
    originFocusId: origin.returnFocusId,
    returnContext:
      origin.fallbackHref === "/" ? ("mission-control" as const) : ("hr-mission-control" as const),
  };
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My leave requests"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close My leave requests"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-leave"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <HrLeaveRequestPage
            focusNavigation={focusNavigation}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
