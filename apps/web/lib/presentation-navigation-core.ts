import {
  getPresentationSemanticSurfaceDefinition,
  getPresentationServiceGroupDefinition,
  type PresentationNavigationDiscovery,
  type PresentationSemanticIconKey,
  type PresentationServiceGroupId,
  parseApiProblemDetails,
  parsePresentationNavigationDiscovery,
  type ZenV1SurfaceId,
  zenV1SurfaceIds,
} from "@esbla/contracts";

export class PresentationNavigationError extends Error {
  constructor() {
    super("Presentation navigation is unavailable");
    this.name = "PresentationNavigationError";
  }
}

export interface ZenNavigationDestination {
  readonly href: string;
  readonly id: string;
  readonly label: string;
  readonly semanticIcon: PresentationSemanticIconKey;
}

export interface ZenServiceGroupNavigation extends ZenNavigationDestination {
  readonly serviceGroupId: string;
}

export interface ZenContextualNavigation {
  readonly activeDestinationId?: string;
  readonly destinations: readonly ZenNavigationDestination[];
  readonly label: string;
  readonly serviceGroupId: string;
}

export interface ZenNavigationModel {
  readonly contextualMenu?: ZenContextualNavigation;
  readonly serviceGroups: readonly ZenServiceGroupNavigation[];
}

export interface ZenNavigationProjectionRegistry {
  readonly serviceGroup: (serviceGroupId: string) => Readonly<{
    href: string;
    label: string;
    semanticIcon: PresentationSemanticIconKey;
    serviceGroupId: string;
  }>;
  readonly surface: (surfaceId: string) => Readonly<{
    label: string;
    route: string;
    semanticIcon: PresentationSemanticIconKey;
    surfaceId: string;
  }>;
}

export interface ZenNavigationProjectionDiscovery {
  readonly serviceGroups: readonly Readonly<{
    serviceGroupId: string;
    surfaceIds: readonly string[];
  }>[];
}

export function getZenDiscoveredSurfaceIds(
  input: PresentationNavigationDiscovery,
): readonly ZenV1SurfaceId[] {
  const discovery = parsePresentationNavigationDiscovery(input);
  const discovered = new Set<ZenV1SurfaceId>([
    "surface.mission-control",
    ...discovery.serviceGroups.flatMap(({ surfaceIds }) => surfaceIds),
  ]);
  return zenV1SurfaceIds.filter((surfaceId) => discovered.has(surfaceId));
}

function matchesRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function projectZenNavigationModel(
  discovery: ZenNavigationProjectionDiscovery,
  pathname: string,
  registry: ZenNavigationProjectionRegistry,
): ZenNavigationModel {
  const serviceGroups = discovery.serviceGroups.map((discoveredGroup) => {
    const definition = registry.serviceGroup(discoveredGroup.serviceGroupId);
    const firstEligibleSurfaceId = discoveredGroup.surfaceIds[0];
    if (!firstEligibleSurfaceId) throw new PresentationNavigationError();
    const firstEligibleSurface = registry.surface(firstEligibleSurfaceId);
    return {
      href: firstEligibleSurface.route,
      id: `service_group.${definition.serviceGroupId}`,
      label: definition.label,
      semanticIcon: definition.semanticIcon,
      serviceGroupId: definition.serviceGroupId,
    };
  });
  const discoveredGroup = discovery.serviceGroups.find((group) => {
    const definition = registry.serviceGroup(group.serviceGroupId);
    return matchesRoute(pathname, definition.href);
  });
  if (!discoveredGroup) return { serviceGroups };

  const definition = registry.serviceGroup(discoveredGroup.serviceGroupId);
  const destinations: ZenNavigationDestination[] = discoveredGroup.surfaceIds.map((surfaceId) => {
    const surface = registry.surface(surfaceId);
    return {
      href: surface.route,
      id: surface.surfaceId,
      label: surface.label,
      semanticIcon: surface.semanticIcon,
    };
  });
  const activeDestination = [...destinations]
    .sort((left, right) => right.href.length - left.href.length)
    .find(({ href }) =>
      href === definition.href ? pathname === href : matchesRoute(pathname, href),
    );
  const activeDestinationId = activeDestination?.id;
  const meaningfulAlternatives = destinations.filter(({ id }) => id !== activeDestinationId).length;
  if (meaningfulAlternatives === 0) return { serviceGroups };
  return {
    contextualMenu: {
      ...(activeDestinationId ? { activeDestinationId } : {}),
      destinations,
      label: `${definition.label} surfaces`,
      serviceGroupId: definition.serviceGroupId,
    },
    serviceGroups,
  };
}

const zenNavigationRegistry: ZenNavigationProjectionRegistry = {
  serviceGroup: (serviceGroupId) =>
    getPresentationServiceGroupDefinition(serviceGroupId as PresentationServiceGroupId),
  surface: (surfaceId) => getPresentationSemanticSurfaceDefinition(surfaceId as ZenV1SurfaceId),
};

export function buildZenNavigationModel(
  input: PresentationNavigationDiscovery,
  pathname: string,
): ZenNavigationModel {
  return projectZenNavigationModel(
    parsePresentationNavigationDiscovery(input),
    pathname,
    zenNavigationRegistry,
  );
}

export async function decodePresentationNavigationDiscoveryResponse(
  responsePromise: Promise<Response>,
): Promise<PresentationNavigationDiscovery> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationNavigationError();
  }
  if (response.status !== 200) {
    try {
      parseApiProblemDetails(await response.json());
    } catch {}
    throw new PresentationNavigationError();
  }
  try {
    return parsePresentationNavigationDiscovery(await response.json());
  } catch {
    throw new PresentationNavigationError();
  }
}
