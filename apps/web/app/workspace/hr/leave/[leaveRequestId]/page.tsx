import type {
  HrLeaveEvidenceEvent,
  HrLeaveRequestDetailRequest,
} from "@esbla/contracts/hr-leave-api";
import { ArrowLeft, CalendarDays, Clock3, FileCheck2 } from "lucide-react";
import { notFound } from "next/navigation";
import { getLeaveRequestDetail } from "../../../../../lib/hr-leave-detail";

interface HrLeaveDetailPageProps {
  readonly params: Promise<{ leaveRequestId: string }>;
}

const categoryLabels = {
  annual: "Annual",
  other: "Other",
  sick: "Sick",
  unpaid: "Unpaid",
} as const;

const stateLabels = {
  approved: "Approved",
  rejected: "Rejected",
  submitted: "Submitted",
} as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    timeZoneName: "short",
    year: "numeric",
  }).format(new Date(value));
}

function dateRange(request: HrLeaveRequestDetailRequest) {
  const start = formatDate(request.startDate);
  return request.startDate === request.endDate
    ? start
    : `${start} - ${formatDate(request.endDate)}`;
}

function eventDescription(event: HrLeaveEvidenceEvent) {
  if (event.newState === "submitted") return "Request submitted for manager review.";
  if (event.newState === "approved") return "Manager approved the request.";
  return "Manager rejected the request.";
}

export default async function HrLeaveDetailPage({ params }: HrLeaveDetailPageProps) {
  const { leaveRequestId } = await params;
  const detail = await getLeaveRequestDetail(leaveRequestId);
  if (!detail) notFound();
  const { history, request } = detail;

  return (
    <section aria-labelledby="leave-detail-heading" className="work-surface leave-detail-surface">
      <a className="text-command detail-back" href="/workspace/my-work">
        <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
        Back to My Work
      </a>

      <header className="surface-heading leave-detail-heading">
        <div>
          <p className="surface-label">HR leave request</p>
          <h1 id="leave-detail-heading">{request.employeeDisplayName}</h1>
          <p className="surface-summary">
            {categoryLabels[request.categoryCode]} leave | {dateRange(request)}
          </p>
        </div>
        <span className={`leave-status leave-status-${request.status}`}>
          {stateLabels[request.status]}
        </span>
      </header>

      <div className="leave-detail-layout">
        <section aria-labelledby="request-details-heading" className="leave-detail-section">
          <div className="detail-section-heading">
            <CalendarDays aria-hidden="true" size={20} strokeWidth={1.7} />
            <h2 id="request-details-heading">Request details</h2>
          </div>
          <dl className="leave-detail-facts">
            <div>
              <dt>Leave type</dt>
              <dd>{categoryLabels[request.categoryCode]}</dd>
            </div>
            <div>
              <dt>Dates</dt>
              <dd>{dateRange(request)}</dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>
                <time dateTime={request.submittedAt}>{formatDateTime(request.submittedAt)}</time>
              </dd>
            </div>
            <div>
              <dt>Current status</dt>
              <dd>{stateLabels[request.status]}</dd>
            </div>
          </dl>

          <div className="leave-detail-copy">
            <h3>Reason</h3>
            <p>{request.reason || "No reason provided."}</p>
          </div>

          {request.decidedAt ? (
            <div className="leave-detail-copy leave-detail-decision">
              <h3>Decision</h3>
              <p>{request.decisionNote || "No decision note recorded."}</p>
              <span>
                Recorded{" "}
                <time dateTime={request.decidedAt}>{formatDateTime(request.decidedAt)}</time>
              </span>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="evidence-history-heading" className="leave-detail-section">
          <div className="detail-section-heading">
            <FileCheck2 aria-hidden="true" size={20} strokeWidth={1.7} />
            <h2 id="evidence-history-heading">Evidence history</h2>
          </div>
          <ol className="leave-history">
            {history.map((event) => (
              <li className="leave-history-item" key={`${event.eventType}-${event.occurredAt}`}>
                <span aria-hidden="true" className="leave-history-marker">
                  <Clock3 size={14} strokeWidth={1.8} />
                </span>
                <div>
                  <strong>{stateLabels[event.newState]}</strong>
                  <p>{eventDescription(event)}</p>
                  <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </section>
  );
}
