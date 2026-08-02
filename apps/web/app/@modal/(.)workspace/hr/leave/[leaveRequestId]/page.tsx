import { ArrowLeft } from "lucide-react";
import { fromAssignedProviderMasterCursorParameters } from "../../../../../../lib/assigned-provider-core";
import { getLeaveRequestDetail } from "../../../../../../lib/hr-leave-detail";
import {
  buildHrLeaveListHref,
  getHrLeaveReturnLink,
  HR_LEAVE_CANONICAL_HOST_LINK,
  type HrLeaveFocusNavigation,
  parseHrLeaveListCursor,
  parseHrLeaveOriginFocusId,
  parseHrLeaveReturnContext,
} from "../../../../../../lib/hr-leave-navigation-core";
import {
  buildNestedRouteBackedWidgetHref,
  parseOptionalRouteBackedWidgetOrigin,
} from "../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetNestedBackLink,
  RouteBackedWidgetOverlay,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import HrLeaveDetailError from "../../../../../workspace/hr/leave/[leaveRequestId]/error";
import { HrLeaveRequestDetailFace } from "../../../../../workspace/hr/leave/[leaveRequestId]/leave-request-detail-face";
import HrLeaveDetailNotFound from "../../../../../workspace/hr/leave/[leaveRequestId]/not-found";
import HrLeaveRequestPage from "../../../../../workspace/hr/leave/page";
import MyWorkPage from "../../../../../workspace/my-work/page";

interface InterceptedLeaveDetailPageProps {
  readonly params: Promise<{ leaveRequestId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedLeaveDetailPage({
  params,
  searchParams,
}: InterceptedLeaveDetailPageProps) {
  const [{ leaveRequestId }, parameters] = await Promise.all([params, searchParams]);
  const returnContext = parseHrLeaveReturnContext(parameters.returnContext);
  const returnLink = getHrLeaveReturnLink(returnContext);
  const originFocusId = parseHrLeaveOriginFocusId(parameters.originFocusId);
  const routeOrigin = parseOptionalRouteBackedWidgetOrigin(parameters);
  const fromFocusedMyWork = returnContext === "my-work" && routeOrigin !== undefined;
  const detailResult = await (async () => {
    try {
      const detail = await getLeaveRequestDetail(leaveRequestId);
      return detail ? ({ detail, kind: "detail" } as const) : ({ kind: "not-found" } as const);
    } catch {
      return { kind: "error" } as const;
    }
  })();

  const fallbackHref = fromFocusedMyWork
    ? routeOrigin.fallbackHref
    : (returnLink?.href ?? HR_LEAVE_CANONICAL_HOST_LINK.href);
  const focusNavigation: HrLeaveFocusNavigation | undefined =
    returnContext === "leave-list"
      ? { returnContext }
      : (returnContext === "mission-control" || returnContext === "hr-mission-control") &&
          originFocusId
        ? { originFocusId, returnContext }
        : undefined;
  const listCursor =
    returnContext === "leave-list" ? parseHrLeaveListCursor(parameters) : undefined;
  const masterParameters = fromFocusedMyWork
    ? fromAssignedProviderMasterCursorParameters(parameters)
    : listCursor
      ? {
          cursorLeaveRequestId: listCursor.leaveRequestId,
          cursorSubmittedAt: listCursor.submittedAt,
        }
      : {};
  const myWorkQuery = new URLSearchParams(masterParameters).toString();
  const masterHref = fromFocusedMyWork
    ? buildNestedRouteBackedWidgetHref(
        myWorkQuery ? `/workspace/my-work?${myWorkQuery}` : "/workspace/my-work",
        routeOrigin,
      )
    : focusNavigation
      ? buildHrLeaveListHref(focusNavigation, listCursor)
      : fallbackHref;
  const showMaster =
    (fromFocusedMyWork || Boolean(focusNavigation)) && detailResult.kind !== "error";
  const leadingControl =
    showMaster || returnLink ? (
      <RouteBackedWidgetNestedBackLink href={masterHref}>
        <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
        {fromFocusedMyWork
          ? "Back to My Work"
          : showMaster
            ? "Back to requests"
            : returnLink?.label}
      </RouteBackedWidgetNestedBackLink>
    ) : undefined;
  return (
    <RouteBackedWidgetOverlay
      browserBackMode={showMaster ? "return-master" : "close-origin"}
      fallbackHref={fallbackHref}
      label="Leave request detail"
      returnFocusId={routeOrigin?.returnFocusId ?? originFocusId ?? "leave-detail-fallback-focus"}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close leave request detail"
        fallbackHref={fallbackHref}
        layout={showMaster ? "master-detail" : "single"}
        workspaceId="hr-leave"
      >
        {showMaster ? (
          <RouteBackedWidgetFocusPane kind="master">
            {fromFocusedMyWork ? (
              <MyWorkPage
                focusOrigin={routeOrigin}
                searchParams={Promise.resolve(masterParameters)}
              />
            ) : focusNavigation ? (
              <HrLeaveRequestPage
                focusNavigation={focusNavigation}
                mode="focus-master"
                searchParams={Promise.resolve(masterParameters)}
              />
            ) : null}
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          {detailResult.kind === "error" ? (
            <HrLeaveDetailError leadingControl={leadingControl} mode="overlay" />
          ) : detailResult.kind === "detail" ? (
            <HrLeaveRequestDetailFace
              detail={detailResult.detail}
              leadingControl={leadingControl}
              mode="overlay"
            />
          ) : (
            <HrLeaveDetailNotFound leadingControl={leadingControl} mode="overlay" />
          )}
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
