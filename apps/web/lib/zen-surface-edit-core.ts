import { getPresentationSemanticSurfaceDefinition, type ZenV1SurfaceId } from "@esbla/contracts";

export interface ZenSurfaceEditDescriptor {
  readonly ariaLabel: string;
  readonly href: `/studio/surfaces/${ZenV1SurfaceId}/personal`;
  readonly route: string;
  readonly surfaceId: ZenV1SurfaceId;
}

export function getZenSurfaceEditDescriptor(surfaceId: ZenV1SurfaceId): ZenSurfaceEditDescriptor {
  const surface = getPresentationSemanticSurfaceDefinition(surfaceId);
  return {
    ariaLabel: `Edit ${surface.label} personal layout`,
    href: `/studio/surfaces/${surfaceId}/personal`,
    route: surface.route,
    surfaceId,
  };
}

export function selectZenSurfaceEditDescriptor(
  descriptors: readonly ZenSurfaceEditDescriptor[],
  pathname: string,
): ZenSurfaceEditDescriptor | undefined {
  return descriptors.find(({ route }) => route === pathname);
}
