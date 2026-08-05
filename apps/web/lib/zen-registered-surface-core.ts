import { getPresentationSemanticSurfaceDefinition, type ZenV1SurfaceId } from "@esbla/contracts";
import type { ResolvedResponsivePresentationSurfaceLayout } from "./presentation-layout-core";
import { PresentationSurfaceError } from "./presentation-surfaces-core";
import { ZEN_SURFACE_SECTION_REGISTRY } from "./zen-section-rail-core";

export interface ZenRegisteredSurfaceDescriptor {
  readonly headingId: string;
  readonly label: string;
  readonly route: string;
  readonly serviceGroupLabel: string;
  readonly summary: string;
  readonly surfaceId: ZenV1SurfaceId;
}

export type ZenRegisteredSurfaceState =
  | Readonly<{
      kind: "ready" | "empty";
      layout: ResolvedResponsivePresentationSurfaceLayout;
    }>
  | Readonly<{ kind: "denied" | "unavailable" }>;

export type ZenRegisteredSurfaceLoader = (
  surfaceId: ZenV1SurfaceId,
) => Promise<ResolvedResponsivePresentationSurfaceLayout>;

export function getZenRegisteredSurfaceDescriptor(
  surfaceId: ZenV1SurfaceId,
): ZenRegisteredSurfaceDescriptor {
  const semantic = getPresentationSemanticSurfaceDefinition(surfaceId);
  const overviewSection = ZEN_SURFACE_SECTION_REGISTRY[surfaceId].sections.find(
    ({ id }) => id === "overview",
  );
  if (!overviewSection) throw new Error("Registered Zen surface lacks an overview section");

  return {
    headingId: overviewSection.headingId,
    label: semantic.label,
    route: semantic.route,
    serviceGroupLabel: `${semantic.serviceGroupId.toUpperCase()} surface`,
    summary: semantic.taskOutcome,
    surfaceId,
  };
}

export async function loadZenRegisteredSurfaceState(
  surfaceId: ZenV1SurfaceId,
  loadLayout: ZenRegisteredSurfaceLoader,
): Promise<ZenRegisteredSurfaceState> {
  let layout: ResolvedResponsivePresentationSurfaceLayout;
  try {
    layout = await loadLayout(surfaceId);
  } catch (error) {
    if (error instanceof PresentationSurfaceError && error.kind === "forbidden") {
      return { kind: "denied" };
    }
    return { kind: "unavailable" };
  }

  if (layout.surfaceId !== surfaceId) return { kind: "unavailable" };
  if (layout.layouts[0].placements.length > 0) return { kind: "ready", layout };

  const semantic = getPresentationSemanticSurfaceDefinition(surfaceId);
  return semantic.zeroEligibleBehavior === "render_empty"
    ? { kind: "empty", layout }
    : { kind: "denied" };
}
