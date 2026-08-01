import { resolveResponsivePresentationSurfaceLayout } from "../../../lib/presentation-layout-core";
import { loadOwnPresentationPersonalSurfaceEditorWorkspace } from "../../../lib/presentation-surfaces";
import { getEligibleZenSurfaceSections } from "../../../lib/zen-section-rail-core";
import { getSurfaceDefinition } from "../../../theme/zen-theme/v1";
import { ZenSectionRail } from "../../../theme/zen-theme/v1/surfaces/zen-section-rail";
import { ZenSurfaceWidgets } from "../../../theme/zen-theme/v1/surfaces/zen-surface-widgets";

export const dynamic = "force-dynamic";

export default async function HrHubPage() {
  const editorWorkspace = await loadOwnPresentationPersonalSurfaceEditorWorkspace(
    "surface.hr.mission-control",
  ).catch(() => undefined);
  const layout = editorWorkspace
    ? resolveResponsivePresentationSurfaceLayout(editorWorkspace.layout)
    : undefined;
  const eligibleWidgetInstanceIds =
    layout?.layouts[0].placements.map(({ instanceId }) => instanceId) ?? [];
  const eligibleSections = getEligibleZenSurfaceSections(
    getSurfaceDefinition("surface.hr.mission-control"),
    {
      authorizedContentAnchorIds: [],
      eligibleWidgetInstanceIds,
    },
  );

  return (
    <section
      aria-labelledby="hr-hub-heading"
      className="mission-control-surface"
      data-zen-section-id="overview"
    >
      <ZenSectionRail sections={eligibleSections} />
      <header className="mission-control-heading">
        <div>
          <p className="surface-label">HR Mission Control</p>
          <h1 data-zen-section-heading="overview" id="hr-hub-heading">
            People and work
          </h1>
        </div>
        <div className="surface-heading-actions">
          <p className="surface-summary">
            Live HR widgets share the same authorized Product truth as their full-screen faces.
          </p>
        </div>
      </header>

      <div className="widget-grid">
        {layout && eligibleWidgetInstanceIds.length > 0 ? (
          <ZenSurfaceWidgets layout={layout} surfaceId="surface.hr.mission-control" />
        ) : layout ? (
          <div className="zen-surface-empty">
            <strong>No eligible HR widgets</strong>
            <p>Active HR services available to your account will appear here.</p>
          </div>
        ) : (
          <div className="zen-surface-unavailable" role="alert">
            <strong>HR layout is unavailable</strong>
            <p>Your saved layout could not be loaded. No private error detail is shown.</p>
          </div>
        )}
      </div>
    </section>
  );
}
