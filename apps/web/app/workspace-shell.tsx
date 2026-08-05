import type {
  PlatformNotificationPage,
  PresentationNavigationDiscovery,
  PresentationShortcutDiscovery,
  PresentationShortcutDiscoveryQuery,
  ZenV1SurfaceId,
} from "@esbla/contracts";
import type { ReactNode } from "react";
import { loadOwnNotifications } from "../lib/platform-notifications";
import { loadOwnPresentationNavigation } from "../lib/presentation-navigation";
import { loadOwnPresentationPreferences } from "../lib/presentation-preferences";
import { loadOwnPresentationShortcuts } from "../lib/presentation-shortcuts";
import type { ZenSurfaceEditDescriptor } from "../lib/zen-surface-edit-core";
import { ZenShellChrome } from "../theme/zen-theme/v1/chrome/zen-shell-chrome";
import { ZenSurfaceScrollRail } from "../theme/zen-theme/v1/surfaces/zen-surface-scroll-rail";
import type { WorkspaceSurfaceKey } from "./workspace-surfaces";

const WORKSPACE_SURFACE_SCROLL_OWNER_ID = "workspace-surface-scroll";

interface WorkspaceShellProps {
  readonly children: ReactNode;
  readonly currentSurface: WorkspaceSurfaceKey | ZenV1SurfaceId;
  readonly editSurfaces?: readonly ZenSurfaceEditDescriptor[] | undefined;
  readonly shortcutContext?: PresentationShortcutDiscoveryQuery | undefined;
}

export async function WorkspaceShell({
  children,
  currentSurface,
  editSurfaces,
  shortcutContext,
}: WorkspaceShellProps) {
  const [navigation, notifications, shortcuts, systemEligible] = await Promise.all([
    loadOwnPresentationNavigation().catch(
      (): PresentationNavigationDiscovery => ({ serviceGroups: [] }),
    ),
    loadOwnNotifications().catch((): PlatformNotificationPage | undefined => undefined),
    loadOwnPresentationShortcuts(shortcutContext).catch(
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
        editSurfaces={editSurfaces ?? []}
        initialNotifications={notifications}
        settingsAvailable
        shortcutDiscovery={shortcuts}
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
