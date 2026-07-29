import type {
  PresentationNavigationDiscovery,
  PresentationShortcutDiscovery,
} from "@esbla/contracts";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { getServerDevelopmentSessionSummary } from "../lib/development-session";
import { loadOwnPresentationNavigation } from "../lib/presentation-navigation";
import { loadOwnPresentationPreferences } from "../lib/presentation-preferences";
import { loadOwnPresentationShortcuts } from "../lib/presentation-shortcuts";
import { ZenShellChrome } from "../theme/zen-theme/v1/chrome/zen-shell-chrome";
import type { WorkspaceSurfaceKey } from "./workspace-surfaces";

interface WorkspaceShellProps {
  readonly children: ReactNode;
  readonly currentSurface: WorkspaceSurfaceKey;
}

export async function WorkspaceShell({ children, currentSurface }: WorkspaceShellProps) {
  const session = getServerDevelopmentSessionSummary();
  const SessionIcon = session.state === "configured" ? ShieldCheck : ShieldAlert;
  const [navigation, shortcuts, systemEligible] = await Promise.all([
    loadOwnPresentationNavigation().catch(
      (): PresentationNavigationDiscovery => ({ serviceGroups: [] }),
    ),
    loadOwnPresentationShortcuts(currentSurface === "HR" ? "hr" : undefined).catch(
      (): PresentationShortcutDiscovery | undefined => undefined,
    ),
    loadOwnPresentationPreferences()
      .then(() => true)
      .catch(() => false),
  ]);

  return (
    <div className="esbla-shell" data-current-surface={currentSurface}>
      <ZenShellChrome
        appearanceAvailable={systemEligible}
        discovery={navigation}
        shortcutDiscovery={shortcuts}
      />

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
