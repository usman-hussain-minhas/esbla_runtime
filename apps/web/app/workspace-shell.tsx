import type {
  PlatformNotificationPage,
  PresentationNavigationDiscovery,
  PresentationShortcutDiscovery,
  ZenV1SurfaceId,
} from "@esbla/contracts";
import type { ReactNode } from "react";
import { loadOwnNotifications } from "../lib/platform-notifications";
import { loadOwnPresentationNavigation } from "../lib/presentation-navigation";
import { loadOwnPresentationPreferences } from "../lib/presentation-preferences";
import { loadOwnPresentationShortcuts } from "../lib/presentation-shortcuts";
import { getPresentationShortcutContextSurfaceIds } from "../lib/presentation-shortcuts-core";
import type { ZenSurfaceEditDescriptor } from "../lib/zen-surface-edit-core";
import { ZenShellChrome } from "../theme/zen-theme/v1/chrome/zen-shell-chrome";
import { ZenSurfaceScrollRail } from "../theme/zen-theme/v1/surfaces/zen-surface-scroll-rail";
import type { WorkspaceSurfaceKey } from "./workspace-surfaces";

const WORKSPACE_SURFACE_SCROLL_OWNER_ID = "workspace-surface-scroll";

interface WorkspaceShellProps {
  readonly children: ReactNode;
  readonly currentSurface: WorkspaceSurfaceKey | ZenV1SurfaceId;
  readonly editSurfaces?: readonly ZenSurfaceEditDescriptor[] | undefined;
  readonly shortcutSurfaceId?: ZenV1SurfaceId | undefined;
}

export async function WorkspaceShell({
  children,
  currentSurface,
  editSurfaces,
  shortcutSurfaceId,
}: WorkspaceShellProps) {
  const [navigation, notifications, universalShortcuts, systemEligible] = await Promise.all([
    loadOwnPresentationNavigation().catch(
      (): PresentationNavigationDiscovery => ({ serviceGroups: [] }),
    ),
    loadOwnNotifications().catch((): PlatformNotificationPage | undefined => undefined),
    loadOwnPresentationShortcuts().catch(
      (): PresentationShortcutDiscovery | undefined => undefined,
    ),
    loadOwnPresentationPreferences()
      .then(() => true)
      .catch(() => false),
  ]);
  const contextualShortcuts = await Promise.all(
    getPresentationShortcutContextSurfaceIds(navigation).map((contextSurfaceId) =>
      loadOwnPresentationShortcuts({ contextSurfaceId }).catch(
        (): PresentationShortcutDiscovery | undefined => undefined,
      ),
    ),
  );
  const shortcutDiscoveries = [universalShortcuts, ...contextualShortcuts].filter(
    (discovery): discovery is PresentationShortcutDiscovery => discovery !== undefined,
  );

  return (
    <div className="esbla-shell" data-current-surface={currentSurface}>
      <ZenShellChrome
        appearanceAvailable={systemEligible}
        discovery={navigation}
        editSurfaces={editSurfaces ?? []}
        initialNotifications={notifications}
        settingsAvailable
        shortcutDiscoveries={shortcutDiscoveries}
        shortcutSurfaceId={shortcutSurfaceId}
      />

      <ZenSurfaceScrollRail scrollOwnerId={WORKSPACE_SURFACE_SCROLL_OWNER_ID} />
      <main className="surface-frame">
        <div className="surface-scroll" id={WORKSPACE_SURFACE_SCROLL_OWNER_ID}>
          {children}
        </div>
      </main>
    </div>
  );
}
