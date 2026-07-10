import { Inbox } from "lucide-react";
import { WorkspaceShell } from "./workspace-shell";

export const dynamic = "force-dynamic";

export default function WorkspacePage() {
  return (
    <WorkspaceShell currentSurface="My Work" statusLabel="0">
      <section aria-labelledby="my-work-heading" className="work-surface">
        <header className="surface-heading">
          <div>
            <p className="surface-label">My Work</p>
            <h1 id="my-work-heading">Your operating queue</h1>
            <p className="surface-summary">Assigned work and approvals appear here.</p>
          </div>
          <span className="work-count">0 open</span>
        </header>

        <div className="empty-worklist">
          <span aria-hidden="true" className="empty-worklist-icon">
            <Inbox size={27} strokeWidth={1.6} />
          </span>
          <h2>Nothing needs your attention</h2>
          <p>Your queue is clear.</p>
        </div>
      </section>
    </WorkspaceShell>
  );
}
