import type {
  HrAssignedLeaveRequestSummary,
  HrLeaveRequestCursor,
} from "@esbla/contracts/hr-leave-api";
import { ArrowRight, ClipboardCheck, Clock3 } from "lucide-react";
import { getAssignedLeaveRequests } from "../../../lib/hr-leave-assigned-list";

interface MyWorkPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const categoryLabels = {
  annual: "Annual",
  other: "Other",
  sick: "Sick",
  unpaid: "Unpaid",
} as const;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cursorFrom(searchParams: Record<string, string | string[] | undefined>) {
  const leaveRequestId = single(searchParams.cursorLeaveRequestId);
  const submittedAt = single(searchParams.cursorSubmittedAt);
  if (!leaveRequestId && !submittedAt) return undefined;
  if (!leaveRequestId || !submittedAt) throw new Error("Incomplete assigned-work cursor");
  return { leaveRequestId, submittedAt } satisfies HrLeaveRequestCursor;
}

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
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

function dateRange(item: HrAssignedLeaveRequestSummary) {
  const start = formatDate(item.startDate);
  return item.startDate === item.endDate ? start : [start, formatDate(item.endDate)].join(" - ");
}

function nextPageHref(cursor: HrLeaveRequestCursor) {
  const parameters = new URLSearchParams({
    cursorLeaveRequestId: cursor.leaveRequestId,
    cursorSubmittedAt: cursor.submittedAt,
  });
  return `/workspace/my-work?${parameters.toString()}`;
}

export default async function MyWorkPage({ searchParams }: MyWorkPageProps) {
  const cursor = cursorFrom(await searchParams);
  const page = await getAssignedLeaveRequests(cursor);

  return (
    <section aria-labelledby="my-work-heading" className="work-surface my-work-surface">
      <header className="surface-heading my-work-heading">
        <div>
          <p className="surface-label">My Work</p>
          <h1 id="my-work-heading">Assigned approvals</h1>
          <p className="surface-summary">Leave requests waiting for your review.</p>
        </div>
        <span className="work-count">{page.items.length} shown</span>
      </header>

      {page.items.length === 0 ? (
        <div className="empty-worklist">
          <span aria-hidden="true" className="empty-worklist-icon">
            <ClipboardCheck size={27} strokeWidth={1.6} />
          </span>
          <h2>Nothing needs your attention</h2>
          <p>Your assigned leave queue is clear.</p>
        </div>
      ) : (
        <ol aria-label="Assigned leave approvals" className="work-queue">
          {page.items.map((item) => (
            <li className="work-queue-item" key={item.workItemId}>
              <div className="work-queue-primary">
                <div>
                  <p className="work-queue-kicker">{categoryLabels[item.categoryCode]} leave</p>
                  <h2>{item.employeeDisplayName}</h2>
                  <p className="work-queue-dates">{dateRange(item)}</p>
                </div>
                <span className="work-status">
                  <Clock3 aria-hidden="true" size={15} strokeWidth={1.8} />
                  Needs review
                </span>
              </div>

              {item.reason ? <p className="work-queue-reason">{item.reason}</p> : null}

              <dl className="work-queue-meta">
                <div>
                  <dt>Submitted</dt>
                  <dd>
                    <time dateTime={item.submittedAt}>{formatDateTime(item.submittedAt)}</time>
                  </dd>
                </div>
                <div>
                  <dt>Queue state</dt>
                  <dd>Open</dd>
                </div>
              </dl>
              <a
                className="text-command work-detail-link"
                href={`/workspace/hr/leave/${item.leaveRequestId}`}
              >
                Review details
                <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
              </a>
            </li>
          ))}
        </ol>
      )}

      {page.nextCursor || cursor ? (
        <nav aria-label="Assigned approval pages" className="list-pagination">
          {cursor ? (
            <a className="text-command" href="/workspace/my-work">
              Start over
            </a>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <a className="text-command" href={nextPageHref(page.nextCursor)}>
              Next page
            </a>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
