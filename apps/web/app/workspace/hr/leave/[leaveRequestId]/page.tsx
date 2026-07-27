import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getLeaveRequestDetail } from "../../../../../lib/hr-leave-detail";
import {
  getHrLeaveReturnLink,
  HR_LEAVE_CANONICAL_HOST_LINK,
  parseHrLeaveReturnContext,
} from "../../../../../lib/hr-leave-navigation-core";
import { HrLeaveRequestDetailFace } from "./leave-request-detail-face";

interface HrLeaveDetailPageProps {
  readonly params: Promise<{ leaveRequestId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HrLeaveDetailPage({ params, searchParams }: HrLeaveDetailPageProps) {
  const { leaveRequestId } = await params;
  const [detail, parameters] = await Promise.all([
    getLeaveRequestDetail(leaveRequestId),
    searchParams,
  ]);
  const returnContext = parseHrLeaveReturnContext(parameters.returnContext);
  const returnLink = getHrLeaveReturnLink(returnContext) ?? HR_LEAVE_CANONICAL_HOST_LINK;
  if (!detail) notFound();

  return (
    <HrLeaveRequestDetailFace
      detail={detail}
      leadingControl={
        <a className="text-command detail-back" href={returnLink.href}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
          {returnLink.label}
        </a>
      }
      mode="standalone"
    />
  );
}
