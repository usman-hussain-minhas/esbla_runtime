import type { ZenV1SurfaceId } from "@esbla/contracts";
import { notFound } from "next/navigation";
import { loadOwnResponsivePresentationSurfaceLayout } from "../../../../lib/presentation-surfaces";
import {
  getZenRegisteredSurfaceDescriptor,
  loadZenRegisteredSurfaceState,
} from "../../../../lib/zen-registered-surface-core";
import { getEligibleZenSurfaceSections } from "../../../../lib/zen-section-rail-core";
import { getSurfaceDefinition } from "../index";
import { ZenSectionRail } from "./zen-section-rail";
import { ZenSurfaceWidgets } from "./zen-surface-widgets";

export async function renderZenRegisteredSurface(surfaceId: ZenV1SurfaceId) {
  const descriptor = getZenRegisteredSurfaceDescriptor(surfaceId);
  const state = await loadZenRegisteredSurfaceState(
    surfaceId,
    loadOwnResponsivePresentationSurfaceLayout,
  );

  if (state.kind === "denied") notFound();

  const layout = state.kind === "ready" || state.kind === "empty" ? state.layout : undefined;
  const eligibleWidgetInstanceIds =
    layout?.layouts[0].placements.map(({ instanceId }) => instanceId) ?? [];
  const eligibleSections = getEligibleZenSurfaceSections(getSurfaceDefinition(surfaceId), {
    authorizedContentAnchorIds: [],
    eligibleWidgetInstanceIds,
  });

  return (
    <section
      aria-labelledby={descriptor.headingId}
      className="mission-control-surface"
      data-base-version={layout?.baseVersion}
      data-layout-source={layout?.source}
      data-overlay-version={layout?.overlayVersion}
      data-presentation-surface-id={surfaceId}
      data-presentation-surface-state={state.kind}
      data-zen-section-id="overview"
    >
      <ZenSectionRail sections={eligibleSections} />
      <header className="mission-control-heading">
        <div>
          <p className="surface-label">{descriptor.serviceGroupLabel}</p>
          <h1 data-zen-section-heading="overview" id={descriptor.headingId}>
            {descriptor.label}
          </h1>
        </div>
        <div className="surface-heading-actions">
          <p className="surface-summary">{descriptor.summary}</p>
        </div>
      </header>

      <div className="widget-grid">
        {state.kind === "ready" ? (
          <ZenSurfaceWidgets layout={state.layout} surfaceId={surfaceId} />
        ) : state.kind === "empty" ? (
          <div className="zen-surface-empty">
            <strong>No eligible {descriptor.label} widgets</strong>
            <p>Active services available to your account will appear here.</p>
          </div>
        ) : (
          <div className="zen-surface-unavailable" role="alert">
            <strong>{descriptor.label} is unavailable</strong>
            <p>This surface could not be loaded. No private error detail is shown.</p>
          </div>
        )}
      </div>
    </section>
  );
}
