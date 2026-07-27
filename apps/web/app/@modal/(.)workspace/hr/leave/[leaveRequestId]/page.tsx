import { notFound } from "next/navigation";
import { getLeaveRequestDetail } from "../../../../../../lib/hr-leave-detail";
import {
  getHrLeaveReturnLink,
  HR_LEAVE_CANONICAL_HOST_LINK,
  parseHrLeaveOriginFocusId,
  parseHrLeaveReturnContext,
} from "../../../../../../lib/hr-leave-navigation-core";
import {
  RouteBackedWidgetOverlay,
  RouteBackedWidgetOverlayCloseButton,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import { HrLeaveRequestDetailFace } from "../../../../../workspace/hr/leave/[leaveRequestId]/leave-request-detail-face";

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
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={fallbackHref}
      label="Leave request detail"
      returnFocusId={originFocusId ?? "leave-detail-fallback-focus"}
    >
      <HrLeaveRequestDetailFace
        detail={detail}
        leadingControl={
          <RouteBackedWidgetOverlayCloseButton
            fallbackHref={fallbackHref}
            label="Close leave request detail"
          />
        }
        mode="overlay"
      />
    </RouteBackedWidgetOverlay>
  );
}
