import {
  getPresentationServiceGroupDefinition,
  type PresentationNavigationDiscovery,
  type PresentationSemanticIconKey,
  parseApiProblemDetails,
  parsePresentationNavigationDiscovery,
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

function matchesRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function buildZenNavigationModel(
  input: PresentationNavigationDiscovery,
  pathname: string,
): ZenNavigationModel {
  const discovery = parsePresentationNavigationDiscovery(input);
  const serviceGroups = discovery.serviceGroups.map((discoveredGroup) => {
    const definition = getPresentationServiceGroupDefinition(discoveredGroup.serviceGroupId);
    return {
      href: definition.href,
      id: `service_group.${definition.serviceGroupId}`,
      label: definition.label,
      semanticIcon: definition.semanticIcon,
      serviceGroupId: definition.serviceGroupId,
    };
  });
  const discoveredGroup = discovery.serviceGroups.find((group) => {
    const definition = getPresentationServiceGroupDefinition(group.serviceGroupId);
    return matchesRoute(pathname, definition.href);
  });
  if (!discoveredGroup) return { serviceGroups };

  const definition = getPresentationServiceGroupDefinition(discoveredGroup.serviceGroupId);
  const eligibleDestinations = definition.services
    .flatMap(({ destinations }) => destinations)
    .filter(({ destinationId }) => discoveredGroup.destinationIds.includes(destinationId));
  const destinations: ZenNavigationDestination[] = [
    {
      href: definition.href,
      id: `service_group.${definition.serviceGroupId}.mission_control`,
      label: `${definition.label} Mission Control`,
      semanticIcon: definition.semanticIcon,
    },
    ...eligibleDestinations.map(({ destinationId, href, label, semanticIcon }) => ({
      href,
      id: destinationId,
      label,
      semanticIcon,
    })),
  ];
  const activeDestination = [...eligibleDestinations]
    .sort((left, right) => right.href.length - left.href.length)
    .find(({ href }) => matchesRoute(pathname, href));
  const activeDestinationId =
    activeDestination?.destinationId ??
    (pathname === definition.href
      ? `service_group.${definition.serviceGroupId}.mission_control`
      : undefined);
  const meaningfulAlternatives = destinations.filter(({ id }) => id !== activeDestinationId).length;
  if (meaningfulAlternatives === 0) return { serviceGroups };
  return {
    contextualMenu: {
      ...(activeDestinationId ? { activeDestinationId } : {}),
      destinations,
      label: `${definition.label} pages`,
      serviceGroupId: definition.serviceGroupId,
    },
    serviceGroups,
  };
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
