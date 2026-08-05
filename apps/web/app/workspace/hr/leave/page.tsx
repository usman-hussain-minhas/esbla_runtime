import type { HrLeaveRequest } from "@esbla/contracts/hr-leave-api";
import { ArrowRight, CalendarDays, Plus } from "lucide-react";
import Link from "next/link";
import { getOwnLeaveRequests } from "../../../../lib/hr-leave-list";
import {
  buildHrLeaveDetailHref,
  buildHrLeaveListHref,
  buildHrLeaveNewHref,
  type HrLeaveFocusNavigation,
  parseHrLeaveListCursor,
} from "../../../../lib/hr-leave-navigation-core";

interface LeaveListPageProps {
  readonly focusNavigation?: HrLeaveFocusNavigation;
  readonly mode?: "focus-master" | "standalone";
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const categoryLabels = {
  annual: "Annual",
  other: "Other",
  sick: "Sick",
  unpaid: "Unpaid",
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

export default async function HrLeaveListPage({
  focusNavigation,
  mode = "standalone",
  searchParams,
}: LeaveListPageProps) {
  const parameters = await searchParams;
  const cursor = parseHrLeaveListCursor(parameters);
  const page = await getOwnLeaveRequests(cursor);

  return (
    <section
      aria-labelledby="leave-list-heading"
      className={`work-surface leave-list-surface leave-list-${mode}`}
    >
      <header className="surface-heading leave-list-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="leave-list-heading">My Leave Requests</h1>
          <p className="surface-summary">Current and historical whole-day requests.</p>
        </div>
        <div className="surface-heading-actions">
          <span className="work-count">{page.items.length} shown</span>
          <Link
            className="command-button command-button-primary"
            href={buildHrLeaveNewHref(focusNavigation)}
          >
            <Plus aria-hidden="true" size={17} strokeWidth={1.8} />
            New request
          </Link>
        </div>
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
                <th scope="col">Actions</th>
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
                  <td data-label="Actions">
                    <Link
                      className="text-command work-detail-link"
                      href={buildHrLeaveDetailHref(
                        request.leaveRequestId,
                        focusNavigation?.returnContext ?? "leave-list",
                        focusNavigation?.originFocusId,
                        cursor,
                        focusNavigation?.routeOrigin,
                      )}
                      prefetch={false}
                    >
                      View details
                      <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                    </Link>
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
            <Link className="text-command" href={buildHrLeaveListHref(focusNavigation)}>
              Start over
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <Link
              className="text-command"
              href={buildHrLeaveListHref(focusNavigation, page.nextCursor)}
            >
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
