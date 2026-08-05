import type {
  PresentationShortcutDiscovery,
  PresentationShortcutSet,
  PresentationSurfaceLayout,
} from "@esbla/contracts";
import { getPresentationSemanticSurfaceDefinition } from "@esbla/contracts";
import { loadOwnPresentationNavigation } from "../../lib/presentation-navigation";
import { getZenDiscoveredSurfaceIds } from "../../lib/presentation-navigation-core";
import {
  loadOwnPresentationPreferences,
  loadPresentationPreferenceCacheScope,
} from "../../lib/presentation-preferences";
import { loadOwnPresentationShortcuts } from "../../lib/presentation-shortcuts";
import { loadTenantPresentationSurfaceBaseWorkspace } from "../../lib/presentation-surface-bases";
import { loadOwnPresentationSurfaceLayout } from "../../lib/presentation-surfaces";
import { UniversalSettings } from "../../theme/zen-theme/v1/settings/universal-settings";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";

export default async function UniversalSettingsPage() {
  const [preferences, navigation, rootShortcuts, hrShortcuts] = await Promise.all([
    loadOwnPresentationPreferences().catch(() => undefined),
    loadOwnPresentationNavigation().catch(() => ({ serviceGroups: [] }) as const),
    loadOwnPresentationShortcuts({ contextSurfaceId: "surface.mission-control" }).catch(
      (): PresentationShortcutDiscovery | undefined => undefined,
    ),
    loadOwnPresentationShortcuts({ contextServiceGroupId: "hr" }).catch(
      (): PresentationShortcutDiscovery | undefined => undefined,
    ),
  ]);
  const surfaceDefinitions = getZenDiscoveredSurfaceIds(navigation).map((surfaceId) => ({
    label: getPresentationSemanticSurfaceDefinition(surfaceId).label,
    surfaceId,
  }));
  const [layoutResults, tenantBaseResults] = await Promise.all([
    Promise.allSettled(
      surfaceDefinitions.map(({ surfaceId }) => loadOwnPresentationSurfaceLayout(surfaceId)),
    ),
    Promise.allSettled(
      surfaceDefinitions.map(({ surfaceId }) =>
        loadTenantPresentationSurfaceBaseWorkspace(surfaceId),
      ),
    ),
  ]);
  const shortcutSets = [
    rootShortcuts?.universal ?? hrShortcuts?.universal,
    rootShortcuts?.contextual,
    hrShortcuts?.contextual,
  ].filter((set): set is PresentationShortcutSet => set !== undefined && set !== null);
  let cacheScope: string | null = null;
  try {
    cacheScope = loadPresentationPreferenceCacheScope();
  } catch {
    // Cross-tab messages stay disabled without an exact server-derived subject scope.
  }
  const layouts = surfaceDefinitions.map(({ label, surfaceId }, index) => ({
    label,
    layout:
      layoutResults[index]?.status === "fulfilled"
        ? (layoutResults[index].value as PresentationSurfaceLayout)
        : null,
    surfaceId,
    tenantBaseEditable:
      tenantBaseResults[index]?.status === "fulfilled" &&
      tenantBaseResults[index].value.actions.canDraft,
  }));

  return (
    <WorkspaceShell currentSurface="surface.mission-control">
      <section
        aria-labelledby="universal-settings-heading"
        className="work-surface universal-settings-surface"
      >
        <header className="surface-heading">
          <div>
            <p className="surface-label">Universal Settings</p>
            <h1 id="universal-settings-heading">Your Esbla, with its source visible</h1>
            <p className="surface-summary">
              Personal choices stay separate from tenant defaults, Product floors and published
              layouts.
            </p>
          </div>
        </header>
        <UniversalSettings
          cacheScope={cacheScope}
          initialLayouts={layouts}
          initialPreferences={preferences ?? null}
          initialShortcutSets={shortcutSets.length > 0 ? shortcutSets : undefined}
        />
      </section>
    </WorkspaceShell>
  );
}
