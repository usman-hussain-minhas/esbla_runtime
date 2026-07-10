import { Home, Inbox, ShieldAlert, ShieldCheck } from "lucide-react";
import { getServerDevelopmentSessionSummary } from "../lib/development-session";
import { ThemeModeControl } from "./theme-mode-control";

export const dynamic = "force-dynamic";

export default function WorkspacePage() {
  const session = getServerDevelopmentSessionSummary();
  const SessionIcon = session.state === "configured" ? ShieldCheck : ShieldAlert;

  return (
    <div className="esbla-shell">
      <a aria-label="Esbla home" className="chrome-button chrome-home" href="/" title="Home">
        <Home aria-hidden="true" size={19} strokeWidth={1.75} />
      </a>

      <nav aria-label="Current surface" className="page-menu">
        <a className="wordmark" href="/">
          Esbla
        </a>
        <span aria-hidden="true" className="page-menu-divider" />
        <a aria-current="page" className="page-menu-item" href="/">
          My Work
        </a>
      </nav>

      <div className="system-controls">
        <ThemeModeControl />
      </div>

      <main className="surface-frame">
        <div className="surface-scroll">
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
        </div>
      </main>

      <aside
        aria-label="Development identity status"
        className={`session-status session-status-${session.state}`}
        title={
          session.state === "configured" ? session.endpoint : "Development identity unavailable"
        }
      >
        <SessionIcon aria-hidden="true" size={17} strokeWidth={1.8} />
        <span>{session.label}</span>
      </aside>

      <div aria-label="Open work count" className="queue-status" role="status">
        <Inbox aria-hidden="true" size={17} strokeWidth={1.8} />
        <span>0</span>
      </div>
    </div>
  );
}
