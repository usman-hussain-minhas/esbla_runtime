import { loadOwnResponsivePresentationSurfaceLayout } from "../lib/presentation-surfaces";
import { getEligibleZenSurfaceSections } from "../lib/zen-section-rail-core";
import { getSurfaceDefinition } from "../theme/zen-theme/v1";
import { ZenSectionRail } from "../theme/zen-theme/v1/surfaces/zen-section-rail";
import { ZenSurfaceWidgets } from "../theme/zen-theme/v1/surfaces/zen-surface-widgets";
import { WorkspaceShell } from "./workspace-shell";

export const dynamic = "force-dynamic";

export default async function MissionControlPage() {
  const layout = await loadOwnResponsivePresentationSurfaceLayout("surface.mission-control").catch(
    () => undefined,
  );
  const eligibleWidgetInstanceIds =
    layout?.layouts[0].placements.map(({ instanceId }) => instanceId) ?? [];
  const eligibleSections = getEligibleZenSurfaceSections(
    getSurfaceDefinition("surface.mission-control"),
    {
      authorizedContentAnchorIds: [],
      eligibleWidgetInstanceIds,
    },
  );
  return (
    <WorkspaceShell currentSurface="Mission Control">
      <section
        aria-labelledby="mission-control-heading"
        className="mission-control-surface"
        data-zen-section-id="overview"
      >
        <ZenSectionRail sections={eligibleSections} />
        <header className="mission-control-heading">
          <div>
            <p className="surface-label">Mission Control</p>
            <h1 data-zen-section-heading="overview" id="mission-control-heading">
              Your work, one surface
            </h1>
          </div>
          <p className="surface-summary">Live service widgets share one source of Product truth.</p>
        </header>
        <div className="widget-grid">
          {layout && eligibleWidgetInstanceIds.length > 0 ? (
            <ZenSurfaceWidgets layout={layout} surfaceId="surface.mission-control" />
          ) : layout ? (
            <div className="zen-surface-empty">
              <strong>No eligible widgets</strong>
              <p>This surface is ready when an active service is available to your account.</p>
            </div>
          ) : (
            <div className="zen-surface-unavailable" role="alert">
              <strong>Mission Control layout is unavailable</strong>
              <p>Your saved layout could not be loaded. No private error detail is shown.</p>
            </div>
          )}
        </div>
      </section>
    </WorkspaceShell>
  );
}
