import type { WorkspaceTaskCursor } from "@esbla/contracts/workspace-task-api";
import { CheckSquare, Plus } from "lucide-react";
import { getAssignedWorkspaceTasks } from "../../../lib/workspace-task-assigned-list";

interface WorkspaceTasksPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cursorFrom(searchParams: Record<string, string | string[] | undefined>) {
  const taskId = single(searchParams.cursorTaskId);
  const createdAt = single(searchParams.cursorCreatedAt);
  if (!taskId && !createdAt) return undefined;
  if (!taskId || !createdAt) throw new Error("Incomplete workspace-task cursor");
  return { createdAt, taskId } satisfies WorkspaceTaskCursor;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

function nextPageHref(cursor: WorkspaceTaskCursor) {
  const parameters = new URLSearchParams({
    cursorCreatedAt: cursor.createdAt,
    cursorTaskId: cursor.taskId,
  });
  return `/workspace/tasks?${parameters.toString()}`;
}

export default async function WorkspaceTasksPage({ searchParams }: WorkspaceTasksPageProps) {
  const cursor = cursorFrom(await searchParams);
  const page = await getAssignedWorkspaceTasks(cursor);

  return (
    <section aria-labelledby="workspace-task-heading" className="work-surface tasks-surface">
      <header className="surface-heading tasks-heading">
        <div>
          <p className="surface-label">Workspace</p>
          <h1 id="workspace-task-heading">Workspace Tasks</h1>
          <p className="surface-summary">Assigned tasks rendered through the shared Theme host.</p>
        </div>
        <div className="surface-heading-actions">
          <span className="work-count">{page.items.length} shown</span>
          <a className="command-button command-button-primary" href="/workspace/tasks/new">
            <Plus aria-hidden="true" size={17} strokeWidth={1.8} />
            New task
          </a>
        </div>
      </header>

      {page.items.length === 0 ? (
        <div className="empty-worklist">
          <span aria-hidden="true" className="empty-worklist-icon">
            <CheckSquare size={27} strokeWidth={1.6} />
          </span>
          <h2>No assigned tasks</h2>
          <p>Tasks assigned to your development principal will appear here.</p>
        </div>
      ) : (
        <ol aria-label="Assigned workspace tasks" className="work-queue">
          {page.items.map((item) => (
            <li className="work-queue-item" key={item.workItemId}>
              <div className="work-queue-primary">
                <div>
                  <p className="work-queue-kicker">Workspace task</p>
                  <h2>{item.title}</h2>
                  {item.description ? (
                    <p className="work-queue-reason">{item.description}</p>
                  ) : null}
                </div>
                <span className="work-status">Open</span>
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
            </li>
          ))}
        </ol>
      )}

      {page.nextCursor || cursor ? (
        <nav aria-label="Workspace task pages" className="list-pagination">
          {cursor ? (
            <a className="text-command" href="/workspace/tasks">
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
