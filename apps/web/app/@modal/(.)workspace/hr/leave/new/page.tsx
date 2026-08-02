import {
  parseHrLeaveOriginFocusId,
  parseHrLeaveReturnContext,
} from "../../../../../../lib/hr-leave-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import NewLeaveRequestPage from "../../../../../workspace/hr/leave/new/page";
import HrLeaveRequestPage from "../../../../../workspace/hr/leave/page";

interface InterceptedNewLeavePageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedNewLeavePage({
  searchParams,
}: InterceptedNewLeavePageProps) {
  const parameters = await searchParams;
  const returnContext = parseHrLeaveReturnContext(parameters.returnContext);
  const originFocusId = parseHrLeaveOriginFocusId(parameters.originFocusId);
  const focusNavigation =
    (returnContext === "mission-control" || returnContext === "hr-mission-control") && originFocusId
      ? { originFocusId, returnContext }
      : { returnContext: "leave-list" as const };
  const fallbackHref =
    focusNavigation.returnContext === "mission-control"
      ? "/"
      : focusNavigation.returnContext === "hr-mission-control"
        ? "/workspace/hr"
        : "/workspace/hr/leave";

  return (
    <RouteBackedWidgetOverlay
      browserBackMode="return-master"
      fallbackHref={fallbackHref}
      label="New leave request"
      returnFocusId={originFocusId ?? "leave-list-heading"}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close new leave request"
        fallbackHref={fallbackHref}
        layout="master-detail"
        workspaceId="hr-leave"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <HrLeaveRequestPage
            focusNavigation={focusNavigation}
            mode="focus-master"
            searchParams={Promise.resolve({})}
          />
        </RouteBackedWidgetFocusPane>
        <RouteBackedWidgetFocusPane kind="detail">
          <NewLeaveRequestPage focusNavigation={focusNavigation} mode="focus" />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
