import type { HrLeaveRequest, HrLeaveRequestCursor } from "@esbla/contracts/hr-leave-api";
import { CalendarDays } from "lucide-react";
import { getOwnLeaveRequests } from "../../../../lib/hr-leave-list";

interface LeaveListPageProps {
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
  if (!leaveRequestId || !submittedAt) throw new Error("Incomplete leave-request cursor");
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

function dateRange(request: HrLeaveRequest) {
  const start = formatDate(request.startDate);
  return request.startDate === request.endDate
    ? start
    : `${start} - ${formatDate(request.endDate)}`;
}

function nextPageHref(cursor: HrLeaveRequestCursor) {
  const parameters = new URLSearchParams({
    cursorLeaveRequestId: cursor.leaveRequestId,
    cursorSubmittedAt: cursor.submittedAt,
  });
  return `/workspace/hr/leave?${parameters.toString()}`;
}

export default async function HrLeaveListPage({ searchParams }: LeaveListPageProps) {
  const parameters = await searchParams;
  const cursor = cursorFrom(parameters);
  const page = await getOwnLeaveRequests(cursor);

  return (
    <section aria-labelledby="leave-list-heading" className="work-surface leave-list-surface">
      <header className="surface-heading leave-list-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="leave-list-heading">My Leave Requests</h1>
          <p className="surface-summary">Current and historical whole-day requests.</p>
        </div>
        <span className="work-count">{page.items.length} shown</span>
      </header>

      {page.items.length === 0 ? (
        <div className="empty-worklist leave-list-empty">
          <span aria-hidden="true" className="empty-worklist-icon">
            <CalendarDays size={27} strokeWidth={1.6} />
          </span>
          <h2>No leave requests yet</h2>
          <p>Your submitted requests will appear here.</p>
        </div>
      ) : (
        <div className="leave-table-wrap">
          <table className="leave-table">
            <caption className="visually-hidden">Your leave requests</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Type</th>
                <th scope="col">Dates</th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((request) => (
                <tr key={request.leaveRequestId}>
                  <td data-label="Status">
                    <span className={`leave-status leave-status-${request.status}`}>
                      {request.status}
                    </span>
                  </td>
                  <td data-label="Type">{categoryLabels[request.categoryCode]}</td>
                  <td data-label="Dates">{dateRange(request)}</td>
                  <td data-label="Submitted">
                    <time dateTime={request.submittedAt}>
                      {formatDateTime(request.submittedAt)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page.nextCursor || cursor ? (
        <nav aria-label="Leave request pages" className="list-pagination">
          {cursor ? (
            <a className="text-command" href="/workspace/hr/leave">
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
