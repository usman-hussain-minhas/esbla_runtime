import type { PresentationSurfaceLayout } from "@esbla/contracts";
import {
  loadOwnPresentationPreferences,
  loadPresentationPreferenceCacheScope,
} from "../../lib/presentation-preferences";
import { loadOwnPresentationShortcuts } from "../../lib/presentation-shortcuts";
import { loadOwnPresentationSurfaceLayout } from "../../lib/presentation-surfaces";
import { UniversalSettings } from "../../theme/zen-theme/v1/settings/universal-settings";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";

const surfaceDefinitions = [
  { label: "Mission Control", surfaceId: "surface.mission-control" },
  { label: "HR Mission Control", surfaceId: "surface.hr.mission-control" },
] as const;

export default async function UniversalSettingsPage() {
  const preferences = await loadOwnPresentationPreferences().catch(() => undefined);
  const shortcuts = await loadOwnPresentationShortcuts("hr").catch(() => undefined);
  let cacheScope: string | null = null;
  try {
    cacheScope = loadPresentationPreferenceCacheScope();
  } catch {
    // Cross-tab messages stay disabled without an exact server-derived subject scope.
  }
  const layoutResults = await Promise.allSettled(
    surfaceDefinitions.map(({ surfaceId }) => loadOwnPresentationSurfaceLayout(surfaceId)),
  );
  const layouts = surfaceDefinitions.map(({ label, surfaceId }, index) => ({
    label,
    layout:
      layoutResults[index]?.status === "fulfilled"
        ? (layoutResults[index].value as PresentationSurfaceLayout)
        : null,
    surfaceId,
  }));

  return (
    <WorkspaceShell currentSurface="Mission Control">
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
          initialShortcuts={shortcuts}
        />
      </section>
    </WorkspaceShell>
  );
}
