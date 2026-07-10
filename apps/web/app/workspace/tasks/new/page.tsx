import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import { WorkspaceTaskForm } from "./workspace-task-form";

export const dynamic = "force-dynamic";

export default function NewWorkspaceTaskPage() {
  return (
    <section aria-labelledby="new-task-heading" className="work-surface task-form-surface">
      <header className="surface-heading task-form-heading">
        <div>
          <p className="surface-label">Workspace</p>
          <h1 id="new-task-heading">New workspace task</h1>
          <p className="surface-summary">
            Assign a tenant-scoped task without provider or money effects.
          </p>
        </div>
        <a className="text-command" href="/workspace/tasks">
          <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
          Back to tasks
        </a>
      </header>

      <WorkspaceTaskForm idempotencyKey={randomUUID()} />
    </section>
  );
}
