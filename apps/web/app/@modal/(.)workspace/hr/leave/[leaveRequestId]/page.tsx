import { ArrowLeft } from "lucide-react";
import { getLeaveRequestDetail } from "../../../../../../lib/hr-leave-detail";
import {
  buildHrLeaveListHref,
  getHrLeaveReturnLink,
  HR_LEAVE_CANONICAL_HOST_LINK,
  type HrLeaveFocusNavigation,
  parseHrLeaveOriginFocusId,
  parseHrLeaveReturnContext,
} from "../../../../../../lib/hr-leave-navigation-core";
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
  const detailResult = await (async () => {
    try {
      const detail = await getLeaveRequestDetail(leaveRequestId);
      return detail ? ({ detail, kind: "detail" } as const) : ({ kind: "not-found" } as const);
    } catch {
      return { kind: "error" } as const;
    }
  })();

  const fallbackHref = returnLink?.href ?? HR_LEAVE_CANONICAL_HOST_LINK.href;
  const focusNavigation: HrLeaveFocusNavigation | undefined =
    returnContext === "leave-list"
      ? { returnContext }
      : (returnContext === "mission-control" || returnContext === "hr-mission-control") &&
          originFocusId
        ? { originFocusId, returnContext }
        : undefined;
  const masterHref = focusNavigation ? buildHrLeaveListHref(focusNavigation) : fallbackHref;
  const showMaster = Boolean(focusNavigation) && detailResult.kind !== "error";
  const leadingControl = showMaster ? (
    <RouteBackedWidgetNestedBackLink href={masterHref}>
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
      Back to requests
    </RouteBackedWidgetNestedBackLink>
  ) : undefined;
  return (
    <RouteBackedWidgetOverlay
      browserBackMode={showMaster ? "return-master" : "close-origin"}
      fallbackHref={fallbackHref}
      label="Leave request detail"
      returnFocusId={originFocusId ?? "leave-detail-fallback-focus"}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close leave request detail"
        fallbackHref={fallbackHref}
        layout={showMaster ? "master-detail" : "single"}
        workspaceId="hr-leave"
      >
        {showMaster && focusNavigation ? (
          <RouteBackedWidgetFocusPane kind="master">
            <HrLeaveRequestPage
              focusNavigation={focusNavigation}
              mode="focus-master"
              searchParams={Promise.resolve({})}
            />
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          {detailResult.kind === "error" ? (
            <HrLeaveDetailError mode="overlay" />
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
