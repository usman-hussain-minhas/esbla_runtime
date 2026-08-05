import { resolveHrLeaveInterceptedFocusNavigation } from "../../../../../lib/hr-leave-navigation-core";
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
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/leave",
    "/workspace/hr/leave/new",
  ]);
  const focusNavigation = resolveHrLeaveInterceptedFocusNavigation(origin);
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My leave requests"
      origin={origin}
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
