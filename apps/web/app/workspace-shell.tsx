import { getPresentationServiceGroupDefinition } from "@esbla/contracts";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { getServerDevelopmentSessionSummary } from "../lib/development-session";
import { loadOwnPresentationPreferences } from "../lib/presentation-preferences";
import { loadOwnPresentationServiceGroups } from "../lib/presentation-service-groups";
import { SemanticIcon } from "../theme/zen-theme/v1/semantic-icons";
import { UserSystemControl } from "./theme-mode-control";
import { getWorkspaceSurface, type WorkspaceSurfaceKey } from "./workspace-surfaces";

const hrGroup = getPresentationServiceGroupDefinition("hr");

interface WorkspaceShellProps {
  readonly children: ReactNode;
  readonly currentSurface: WorkspaceSurfaceKey;
}

export async function WorkspaceShell({ children, currentSurface }: WorkspaceShellProps) {
  const session = getServerDevelopmentSessionSummary();
  const surface = getWorkspaceSurface(currentSurface);
  const SessionIcon = session.state === "configured" ? ShieldCheck : ShieldAlert;
  const [hrEligible, systemEligible] = await Promise.all([
    loadOwnPresentationServiceGroups()
      .then(({ serviceGroupIds }) => serviceGroupIds.includes(hrGroup.serviceGroupId))
      .catch(() => false),
    loadOwnPresentationPreferences()
      .then(() => true)
      .catch(() => false),
  ]);

  return (
    <div className="esbla-shell">
      <a aria-label="Esbla home" className="chrome-button chrome-home" href="/" title="Home">
        <SemanticIcon aria-hidden="true" semanticKey="home" size={19} strokeWidth={1.75} />
      </a>

      <nav aria-label="Workspace surfaces" className="page-menu">
        <a className="wordmark" href="/">
          {surface.label}
        </a>
        <span aria-hidden="true" className="page-menu-divider" />
        {hrEligible ? (
          <a
            aria-current={currentSurface === "HR" ? "page" : undefined}
            aria-label="HR"
            className="page-menu-item"
            href={hrGroup.href}
            title="HR"
          >
            <SemanticIcon aria-hidden="true" semanticKey={hrGroup.semanticIcon} size={15} />
            <span>HR</span>
          </a>
        ) : null}
      </nav>

      {systemEligible ? (
        <div className="system-controls">
          <UserSystemControl />
        </div>
      ) : null}

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
    </div>
  );
}
