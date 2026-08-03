import { randomUUID } from "node:crypto";
import type { HrExpenseClaimListItem } from "@esbla/contracts/hr-expense-claim-api";
import type { HrAssignedLeaveRequestSummary } from "@esbla/contracts/hr-leave-api";
import type { HrTimesheetListItem } from "@esbla/contracts/hr-timesheet-api";
import type { AssignedWorkspaceTaskSummary } from "@esbla/contracts/workspace-task-api";
import { ArrowRight, ClipboardCheck, Clock3 } from "lucide-react";
import { LeaveApprovalAction } from "../../../components/leave-approval-action";
import {
  loadAssignedProviderView,
  toAssignedProviderMasterCursorParameters,
} from "../../../lib/assigned-provider-core";
import { getAssignedExpenseClaims } from "../../../lib/hr-expense-claim";
import { getAssignedLeaveRequests } from "../../../lib/hr-leave-assigned-list";
import { getAssignedTimesheets } from "../../../lib/hr-timesheet";
import {
  buildNestedRouteBackedWidgetHref,
  type RouteBackedWidgetOrigin,
  withoutRouteBackedWidgetOrigin,
} from "../../../lib/route-backed-widget-navigation-core";
import { getAssignedWorkspaceTasks } from "../../../lib/workspace-task-assigned-list";
import { RouteBackedWidgetLink } from "../../../theme/zen-theme/v1/route-backed-widget-link";
import { LeaveRejectionAction } from "./leave-rejection-action";
import { TaskCompleteAction } from "./task-complete-action";

export const dynamic = "force-dynamic";

interface MyWorkPageProps {
  readonly focusOrigin?: RouteBackedWidgetOrigin | undefined;
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

function dateRange(item: HrAssignedLeaveRequestSummary) {
  const start = formatDate(item.startDate);
  return item.startDate === item.endDate ? start : [start, formatDate(item.endDate)].join(" - ");
}

function TaskQueueItem({ item }: { readonly item: AssignedWorkspaceTaskSummary }) {
  return (
    <li className="work-queue-item" key={item.workItemId}>
      <div className="work-queue-primary">
        <div>
          <p className="work-queue-kicker">Workspace task</p>
          <h2>{item.title}</h2>
          {item.description ? <p className="work-queue-reason">{item.description}</p> : null}
        </div>
        <span className="work-status">
          <Clock3 aria-hidden="true" size={15} strokeWidth={1.8} />
          Open
        </span>
      </div>

      <dl className="work-queue-meta">
        <div>
          <dt>Created by</dt>
          <dd>{item.createdByDisplayName}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
          </dd>
        </div>
      </dl>
      <div className="work-queue-actions">
        <TaskCompleteAction
          expectedVersion={item.version}
          idempotencyKey={randomUUID()}
          taskId={item.taskId}
        />
      </div>
    </li>
  );
}

function minutes(value: number): string {
  return `${Math.floor(value / 60)}h ${value % 60}m`;
}

function assignedDetailHref(
  pathname: string,
  masterCursorParameters: Readonly<Record<string, string>>,
): string {
  const query = new URLSearchParams({
    returnContext: "my-work",
    ...masterCursorParameters,
  });
  return `${pathname}?${query}`;
}

function TimesheetQueueItem({
  focusOrigin,
  item,
  masterCursorParameters,
}: {
  readonly focusOrigin?: RouteBackedWidgetOrigin | undefined;
  readonly item: HrTimesheetListItem;
  readonly masterCursorParameters: Readonly<Record<string, string>>;
}) {
  return (
    <li className="work-queue-item" key={item.workItemId}>
      <div className="work-queue-primary">
        <div>
          <p className="work-queue-kicker">Timesheet approval</p>
          <h2>
            {item.periodStart} to {item.periodEnd}
          </h2>
          <p className="work-queue-dates">{minutes(item.totalMinutes)}</p>
        </div>
        <span className="work-status">
          <Clock3 aria-hidden="true" size={15} strokeWidth={1.8} />
          Needs review
        </span>
      </div>
      <dl className="work-queue-meta">
        <div>
          <dt>Worker profile</dt>
          <dd>{item.workerProfileId}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>
            {item.submittedAt ? (
              <time dateTime={item.submittedAt}>{formatDateTime(item.submittedAt)}</time>
            ) : (
              "Unavailable"
            )}
          </dd>
        </div>
      </dl>
      <div className="work-queue-actions">
        <RouteBackedWidgetLink
          className="text-command work-detail-link"
          focusOrigin={focusOrigin}
          href={assignedDetailHref(
            `/workspace/hr/timesheets/by-id/${item.timesheetId}`,
            masterCursorParameters,
          )}
        >
          Review Timesheet
          <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
        </RouteBackedWidgetLink>
      </div>
    </li>
  );
}

function expenseAmount(value: number, currency: string): string {
  return `${new Intl.NumberFormat("en").format(value)} ${currency} minor units`;
}

function ExpenseQueueItem({
  focusOrigin,
  item,
  masterCursorParameters,
}: {
  readonly focusOrigin?: RouteBackedWidgetOrigin | undefined;
  readonly item: HrExpenseClaimListItem;
  readonly masterCursorParameters: Readonly<Record<string, string>>;
}) {
  return (
    <li className="work-queue-item" key={item.workItemId}>
      <div className="work-queue-primary">
        <div>
          <p className="work-queue-kicker">Expense Claim approval</p>
          <h2>{expenseAmount(item.totalAmountMinor, item.currencyCode)}</h2>
          <p className="work-queue-dates">Version {item.version}</p>
        </div>
        <span className="work-status">
          <Clock3 aria-hidden="true" size={15} strokeWidth={1.8} />
          Needs review
        </span>
      </div>
      <dl className="work-queue-meta">
        <div>
          <dt>Worker profile</dt>
          <dd>{item.workerProfileId}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>
            {item.submittedAt ? (
              <time dateTime={item.submittedAt}>{formatDateTime(item.submittedAt)}</time>
            ) : (
              "Unavailable"
            )}
          </dd>
        </div>
      </dl>
      <div className="work-queue-actions">
        <RouteBackedWidgetLink
          className="text-command work-detail-link"
          focusOrigin={focusOrigin}
          href={assignedDetailHref(
            `/workspace/hr/expenses/by-id/${item.expenseClaimId}`,
            masterCursorParameters,
          )}
        >
          Review Expense Claim
          <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
        </RouteBackedWidgetLink>
      </div>
    </li>
  );
}

function QueueNotice({ heading, summary }: { readonly heading: string; readonly summary: string }) {
  return (
    <div className="empty-worklist">
      <span aria-hidden="true" className="empty-worklist-icon">
        <ClipboardCheck size={27} strokeWidth={1.6} />
      </span>
      <h2>{heading}</h2>
      <p>{summary}</p>
    </div>
  );
}

export default async function MyWorkPage({ focusOrigin, searchParams }: MyWorkPageProps) {
  const parameters = await searchParams;
  const productParameters = withoutRouteBackedWidgetOrigin(parameters);
  const masterCursorParameters = toAssignedProviderMasterCursorParameters(productParameters);
  const view = await loadAssignedProviderView({
    loadExpense: (cursor) => getAssignedExpenseClaims(cursor),
    loadHr: (cursor) => getAssignedLeaveRequests(cursor),
    loadTimesheet: (cursor) => getAssignedTimesheets(cursor),
    loadWorkspace: (cursor) => getAssignedWorkspaceTasks(cursor),
    searchParams: productParameters,
  });

  return (
    <section aria-labelledby="my-work-heading" className="work-surface my-work-surface">
      <header className="surface-heading my-work-heading">
        <div>
          <p className="surface-label">My Work</p>
          <h1 id="my-work-heading">Assigned work</h1>
          <p className="surface-summary">Approvals and tasks waiting for your action.</p>
        </div>
        <span className="work-count">{view.totalShown} shown</span>
      </header>

      {view.queuesClear ? (
        <div className="empty-worklist">
          <span aria-hidden="true" className="empty-worklist-icon">
            <ClipboardCheck size={27} strokeWidth={1.6} />
          </span>
          <h2>Nothing needs your attention</h2>
          <p>Your assigned approval and task queues are clear.</p>
        </div>
      ) : (
        <>
          {view.workspace.unavailable ? (
            <QueueNotice
              heading="Workspace tasks unavailable"
              summary="This queue is unavailable right now."
            />
          ) : !view.workspace.empty ? (
            <ol aria-label="Assigned workspace tasks" className="work-queue">
              {view.workspace.page.items.map((item) => (
                <TaskQueueItem item={item} key={item.workItemId} />
              ))}
            </ol>
          ) : (
            <QueueNotice
              heading="No workspace tasks on this page"
              summary="No workspace tasks are shown at this position."
            />
          )}

          {view.hr.unavailable ? (
            <QueueNotice
              heading="Leave approvals unavailable"
              summary="This queue is unavailable right now."
            />
          ) : !view.hr.empty ? (
            <ol aria-label="Assigned leave approvals" className="work-queue">
              {view.hr.page.items.map((item) => (
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
                  <div className="work-queue-actions">
                    {(() => {
                      const detailHref = assignedDetailHref(
                        `/workspace/hr/leave/${item.leaveRequestId}`,
                        masterCursorParameters,
                      );
                      const successHref = focusOrigin
                        ? buildNestedRouteBackedWidgetHref(detailHref, focusOrigin)
                        : detailHref;
                      return (
                        <>
                          <RouteBackedWidgetLink
                            className="text-command work-detail-link"
                            focusOrigin={focusOrigin}
                            href={detailHref}
                          >
                            Review details
                            <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                          </RouteBackedWidgetLink>
                          <LeaveApprovalAction
                            expectedVersion={item.version}
                            idempotencyKey={randomUUID()}
                            leaveRequestId={item.leaveRequestId}
                            successHref={successHref}
                          />
                          <LeaveRejectionAction
                            expectedVersion={item.version}
                            idempotencyKey={randomUUID()}
                            leaveRequestId={item.leaveRequestId}
                            successHref={successHref}
                          />
                        </>
                      );
                    })()}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <QueueNotice
              heading="No leave approvals on this page"
              summary="No leave approvals are shown at this position."
            />
          )}

          {view.timesheet.unavailable ? (
            <QueueNotice
              heading="Timesheet approvals unavailable"
              summary="This queue is unavailable right now."
            />
          ) : !view.timesheet.empty ? (
            <ol aria-label="Assigned Timesheet approvals" className="work-queue">
              {view.timesheet.page.items.map((item) => (
                <TimesheetQueueItem
                  focusOrigin={focusOrigin}
                  item={item}
                  key={item.workItemId}
                  masterCursorParameters={masterCursorParameters}
                />
              ))}
            </ol>
          ) : (
            <QueueNotice
              heading="No Timesheet approvals on this page"
              summary="No Timesheet approvals are shown at this position."
            />
          )}

          {view.expense.unavailable ? (
            <QueueNotice
              heading="Expense Claim approvals unavailable"
              summary="This queue is unavailable right now."
            />
          ) : !view.expense.empty ? (
            <ol aria-label="Assigned Expense Claim approvals" className="work-queue">
              {view.expense.page.items.map((item) => (
                <ExpenseQueueItem
                  focusOrigin={focusOrigin}
                  item={item}
                  key={item.workItemId}
                  masterCursorParameters={masterCursorParameters}
                />
              ))}
            </ol>
          ) : (
            <QueueNotice
              heading="No Expense Claim approvals on this page"
              summary="No Expense Claim approvals are shown at this position."
            />
          )}
        </>
      )}

      {view.nextApprovalsHref ||
      view.nextExpensesHref ||
      view.nextTasksHref ||
      view.nextTimesheetsHref ||
      view.startOverHref ? (
        <nav aria-label="Assigned approval pages" className="list-pagination">
          {view.startOverHref ? (
            <RouteBackedWidgetLink
              className="text-command"
              focusOrigin={focusOrigin}
              href={view.startOverHref}
            >
              Start over
            </RouteBackedWidgetLink>
          ) : (
            <span />
          )}
          {view.nextApprovalsHref ? (
            <RouteBackedWidgetLink
              className="text-command"
              focusOrigin={focusOrigin}
              href={view.nextApprovalsHref}
            >
              Next approvals
            </RouteBackedWidgetLink>
          ) : null}
          {view.nextTasksHref ? (
            <RouteBackedWidgetLink
              className="text-command"
              focusOrigin={focusOrigin}
              href={view.nextTasksHref}
            >
              Next tasks
            </RouteBackedWidgetLink>
          ) : null}
          {view.nextTimesheetsHref ? (
            <RouteBackedWidgetLink
              className="text-command"
              focusOrigin={focusOrigin}
              href={view.nextTimesheetsHref}
            >
              Next Timesheets
            </RouteBackedWidgetLink>
          ) : null}
          {view.nextExpensesHref ? (
            <RouteBackedWidgetLink
              className="text-command"
              focusOrigin={focusOrigin}
              href={view.nextExpensesHref}
            >
              Next Expense Claims
            </RouteBackedWidgetLink>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
