import { randomUUID } from "node:crypto";
import type {
  HrAssignedLeaveRequestSummary,
  HrLeaveRequestCursor,
} from "@esbla/contracts/hr-leave-api";
import type {
  AssignedWorkspaceTaskSummary,
  WorkspaceTaskCursor,
} from "@esbla/contracts/workspace-task-api";
import { ArrowRight, ClipboardCheck, Clock3 } from "lucide-react";
import { getAssignedLeaveRequests } from "../../../lib/hr-leave-assigned-list";
import { getAssignedWorkspaceTasks } from "../../../lib/workspace-task-assigned-list";
import { LeaveApprovalAction } from "./leave-approval-action";
import { LeaveRejectionAction } from "./leave-rejection-action";
import { TaskCompleteAction } from "./task-complete-action";

export const dynamic = "force-dynamic";

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

function taskCursorFrom(searchParams: Record<string, string | string[] | undefined>) {
  const taskId = single(searchParams.cursorTaskId);
  const createdAt = single(searchParams.cursorCreatedAt);
  if (!taskId && !createdAt) return undefined;
  if (!taskId || !createdAt) throw new Error("Incomplete assigned-task cursor");
  return { createdAt, taskId } satisfies WorkspaceTaskCursor;
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

function taskNextPageHref(cursor: WorkspaceTaskCursor) {
  const parameters = new URLSearchParams({
    cursorCreatedAt: cursor.createdAt,
    cursorTaskId: cursor.taskId,
  });
  return `/workspace/my-work?${parameters.toString()}`;
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

export default async function MyWorkPage({ searchParams }: MyWorkPageProps) {
  const parameters = await searchParams;
  const cursor = cursorFrom(parameters);
  const taskCursor = taskCursorFrom(parameters);
  const [page, taskPage] = await Promise.all([
    getAssignedLeaveRequests(cursor),
    getAssignedWorkspaceTasks(taskCursor),
  ]);
  const totalShown = page.items.length + taskPage.items.length;

  return (
    <section aria-labelledby="my-work-heading" className="work-surface my-work-surface">
      <header className="surface-heading my-work-heading">
        <div>
          <p className="surface-label">My Work</p>
          <h1 id="my-work-heading">Assigned work</h1>
          <p className="surface-summary">Approvals and tasks waiting for your action.</p>
        </div>
        <span className="work-count">{totalShown} shown</span>
      </header>

      {totalShown === 0 ? (
        <div className="empty-worklist">
          <span aria-hidden="true" className="empty-worklist-icon">
            <ClipboardCheck size={27} strokeWidth={1.6} />
          </span>
          <h2>Nothing needs your attention</h2>
          <p>Your assigned approval and task queues are clear.</p>
        </div>
      ) : (
        <>
          {taskPage.items.length > 0 ? (
            <ol aria-label="Assigned workspace tasks" className="work-queue">
              {taskPage.items.map((item) => (
                <TaskQueueItem item={item} key={item.workItemId} />
              ))}
            </ol>
          ) : null}

          {page.items.length > 0 ? (
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
                  <div className="work-queue-actions">
                    <a
                      className="text-command work-detail-link"
                      href={`/workspace/hr/leave/${item.leaveRequestId}`}
                    >
                      Review details
                      <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                    </a>
                    <LeaveApprovalAction
                      expectedVersion={item.version}
                      idempotencyKey={randomUUID()}
                      leaveRequestId={item.leaveRequestId}
                    />
                    <LeaveRejectionAction
                      expectedVersion={item.version}
                      idempotencyKey={randomUUID()}
                      leaveRequestId={item.leaveRequestId}
                    />
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      )}

      {page.nextCursor || cursor || taskPage.nextCursor || taskCursor ? (
        <nav aria-label="Assigned approval pages" className="list-pagination">
          {cursor || taskCursor ? (
            <a className="text-command" href="/workspace/my-work">
              Start over
            </a>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <a className="text-command" href={nextPageHref(page.nextCursor)}>
              Next approvals
            </a>
          ) : null}
          {taskPage.nextCursor ? (
            <a className="text-command" href={taskNextPageHref(taskPage.nextCursor)}>
              Next tasks
            </a>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
