import { BriefcaseBusiness, Home, Inbox, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { getServerDevelopmentSessionSummary } from "../lib/development-session";
import { ThemeModeControl } from "./theme-mode-control";

interface WorkspaceShellProps {
  readonly children: ReactNode;
  readonly currentSurface: "HR" | "My Work";
  readonly statusLabel: string;
}

const navigation = [
  { href: "/workspace/my-work", label: "My Work" },
  { href: "/workspace/hr/leave", label: "HR" },
] as const;

export function WorkspaceShell({ children, currentSurface, statusLabel }: WorkspaceShellProps) {
  const session = getServerDevelopmentSessionSummary();
  const SessionIcon = session.state === "configured" ? ShieldCheck : ShieldAlert;
  const StatusIcon = currentSurface === "HR" ? BriefcaseBusiness : Inbox;

  return (
    <div className="esbla-shell">
      <a aria-label="Esbla home" className="chrome-button chrome-home" href="/" title="Home">
        <Home aria-hidden="true" size={19} strokeWidth={1.75} />
      </a>

      <nav aria-label="Workspace surfaces" className="page-menu">
        <a className="wordmark" href="/workspace/my-work">
          Esbla
        </a>
        <span aria-hidden="true" className="page-menu-divider" />
        {navigation.map((item) => (
          <a
            aria-current={currentSurface === item.label ? "page" : undefined}
            className="page-menu-item"
            href={item.href}
            key={item.href}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="system-controls">
        <ThemeModeControl />
      </div>

      <main className="surface-frame">
        <div className="surface-scroll">{children}</div>
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

      <div aria-label={`${currentSurface} status`} className="queue-status" role="status">
        <StatusIcon aria-hidden="true" size={17} strokeWidth={1.8} />
        <span>{statusLabel}</span>
      </div>
    </div>
  );
}
