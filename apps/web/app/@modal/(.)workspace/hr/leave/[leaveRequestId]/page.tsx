import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
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
import { HrLeaveRequestDetailFace } from "../../../../../workspace/hr/leave/[leaveRequestId]/leave-request-detail-face";
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
  const detail = await getLeaveRequestDetail(leaveRequestId);
  if (!detail) notFound();

  const fallbackHref = returnLink?.href ?? HR_LEAVE_CANONICAL_HOST_LINK.href;
  const focusNavigation: HrLeaveFocusNavigation | undefined =
    returnContext === "leave-list"
      ? { returnContext }
      : (returnContext === "mission-control" || returnContext === "hr-mission-control") &&
          originFocusId
        ? { originFocusId, returnContext }
        : undefined;
  const masterHref = focusNavigation ? buildHrLeaveListHref(focusNavigation) : fallbackHref;
  return (
    <RouteBackedWidgetOverlay
      browserBackMode={focusNavigation ? "return-master" : "close-origin"}
      fallbackHref={fallbackHref}
      label="Leave request detail"
      returnFocusId={originFocusId ?? "leave-detail-fallback-focus"}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close leave request detail"
        fallbackHref={fallbackHref}
        layout={focusNavigation ? "master-detail" : "single"}
        workspaceId="hr-leave"
      >
        {focusNavigation ? (
          <RouteBackedWidgetFocusPane kind="master">
            <HrLeaveRequestPage
              focusNavigation={focusNavigation}
              mode="focus-master"
              searchParams={Promise.resolve({})}
            />
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          <HrLeaveRequestDetailFace
            detail={detail}
            leadingControl={
              focusNavigation ? (
                <RouteBackedWidgetNestedBackLink href={masterHref}>
                  <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
                  Back to requests
                </RouteBackedWidgetNestedBackLink>
              ) : undefined
            }
            mode="overlay"
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
