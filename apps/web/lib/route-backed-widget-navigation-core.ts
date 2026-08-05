import {
  getPresentationWidgetAdmissionDefinition,
  getPresentationWidgetDefinition,
  getZenV1RegisteredSurfaceInstances,
  PRESENTATION_SURFACE_DEFINITIONS,
  type PresentationWidgetExpansionMode,
  type ZenV1SurfaceId,
} from "@esbla/contracts";

type Search = Readonly<Record<string, string | readonly string[] | undefined>>;

export type RouteBackedWidgetFallbackHref = string;

export interface RouteBackedWidgetOrigin {
  readonly entryRoute: string | null;
  readonly expansionMode: PresentationWidgetExpansionMode | null;
  readonly fallbackHref: RouteBackedWidgetFallbackHref;
  readonly returnFocusId: string;
  readonly surfaceId: ZenV1SurfaceId;
  readonly widgetDefinitionId: string | null;
  readonly widgetDefinitionVersion: number | null;
}

export interface RouteBackedWidgetReturnFocus {
  readonly fallbackHref: RouteBackedWidgetFallbackHref;
  readonly returnFocusId: string;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export const ROUTE_BACKED_WIDGET_RETURN_FOCUS_KEY = "esbla.route-backed-widget.return-focus.v1";
const ORIGIN_FOCUS_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,12}$/;
const FALLBACK_FOCUS_ID = "route-backed-widget-fallback-focus";
const LEGACY_SURFACE_IDS = Object.freeze({
  "hr-mission-control": "surface.hr.mission-control",
  "mission-control": "surface.mission-control",
} as const satisfies Readonly<Record<string, ZenV1SurfaceId>>);
const NESTED_FALLBACK_HREFS = new Set(["/workspace/hr/leave", "/workspace/my-work"]);

function one(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function surfaceDefinition(surfaceId: ZenV1SurfaceId) {
  const definition = PRESENTATION_SURFACE_DEFINITIONS.find(({ id }) => id === surfaceId);
  if (!definition) throw new Error("Unknown route-backed widget surface");
  return definition;
}

function surfaceIdForRoute(route: string): ZenV1SurfaceId | undefined {
  return PRESENTATION_SURFACE_DEFINITIONS.find(({ route: candidate }) => candidate === route)?.id;
}

function parseSurfaceId(value: string | undefined): ZenV1SurfaceId | undefined {
  if (!value) return undefined;
  const legacy = LEGACY_SURFACE_IDS[value as keyof typeof LEGACY_SURFACE_IDS];
  if (legacy) return legacy;
  return PRESENTATION_SURFACE_DEFINITIONS.some(({ id }) => id === value)
    ? (value as ZenV1SurfaceId)
    : undefined;
}

function resolveRegisteredOrigin(
  surfaceId: ZenV1SurfaceId,
  returnFocusId: string,
  widgetDefinitionId?: string,
): RouteBackedWidgetOrigin {
  if (!ORIGIN_FOCUS_PATTERN.test(returnFocusId)) {
    throw new Error("Route-backed widget origin is invalid");
  }
  const matches = getZenV1RegisteredSurfaceInstances(surfaceId).filter(
    (instance) =>
      returnFocusId.startsWith(`${instance.instanceId}.`) &&
      (widgetDefinitionId === undefined || instance.widgetDefinitionId === widgetDefinitionId),
  );
  if (matches.length !== 1) {
    throw new Error("Route-backed widget origin is not registered on the surface");
  }
  const [instance] = matches;
  if (!instance) throw new Error("Route-backed widget origin is not registered on the surface");
  const admission = getPresentationWidgetAdmissionDefinition(
    instance.widgetDefinitionId,
    instance.widgetDefinitionVersion,
  );
  const widget = getPresentationWidgetDefinition(
    instance.widgetDefinitionId,
    instance.widgetDefinitionVersion,
  );
  if (admission.expansionMode === null || widget.fullScreenRoute === null) {
    throw new Error("Route-backed widget does not admit expansion");
  }
  return Object.freeze({
    entryRoute: widget.fullScreenRoute,
    expansionMode: admission.expansionMode,
    fallbackHref: surfaceDefinition(surfaceId).route,
    returnFocusId,
    surfaceId,
    widgetDefinitionId: instance.widgetDefinitionId,
    widgetDefinitionVersion: instance.widgetDefinitionVersion,
  });
}

export function createRouteBackedWidgetOrigin(
  surfaceId: ZenV1SurfaceId,
  returnFocusId: string,
  widgetDefinitionId: string,
): RouteBackedWidgetOrigin {
  return resolveRegisteredOrigin(surfaceId, returnFocusId, widgetDefinitionId);
}

export function parseRouteBackedWidgetFallbackHref(
  value: unknown,
): RouteBackedWidgetFallbackHref | undefined {
  return typeof value === "string" &&
    (surfaceIdForRoute(value) !== undefined || NESTED_FALLBACK_HREFS.has(value))
    ? value
    : undefined;
}

export function buildRouteBackedWidgetHref(
  route: string,
  surfaceId: ZenV1SurfaceId,
  originFocusId: string,
  widgetDefinitionId: string,
): string {
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("?") ||
    route.includes("#") ||
    !ORIGIN_FOCUS_PATTERN.test(originFocusId)
  ) {
    throw new Error("Route-backed widget origin is invalid");
  }
  const exactLauncherRegistered = getZenV1RegisteredSurfaceInstances(surfaceId).some(
    (instance) =>
      instance.widgetDefinitionId === widgetDefinitionId &&
      `${instance.instanceId}.full-screen` === originFocusId,
  );
  if (!exactLauncherRegistered) {
    throw new Error("Route-backed widget launcher is not registered on the surface");
  }
  const origin = createRouteBackedWidgetOrigin(surfaceId, originFocusId, widgetDefinitionId);
  if (origin.entryRoute !== route) {
    throw new Error("Route-backed widget route does not match its semantic admission");
  }
  const parameters = new URLSearchParams({
    originFocusId,
    returnSurface: origin.surfaceId,
    originWidgetDefinitionId: widgetDefinitionId,
  });
  return `${route}?${parameters.toString()}`;
}

export function getRouteBackedWidgetOriginParameters(origin: RouteBackedWidgetOrigin): Readonly<{
  originFocusId: string;
  originWidgetDefinitionId: string;
  returnSurface: ZenV1SurfaceId;
}> {
  if (!ORIGIN_FOCUS_PATTERN.test(origin.returnFocusId)) {
    throw new Error("Route-backed widget origin is invalid");
  }
  if (surfaceDefinition(origin.surfaceId).route !== origin.fallbackHref) {
    throw new Error("Nested route-backed widget origin is invalid");
  }
  if (origin.widgetDefinitionId === null) {
    throw new Error("Nested route-backed widget origin is not exact");
  }
  const current = resolveRegisteredOrigin(
    origin.surfaceId,
    origin.returnFocusId,
    origin.widgetDefinitionId,
  );
  if (
    current.entryRoute !== origin.entryRoute ||
    current.expansionMode !== origin.expansionMode ||
    current.widgetDefinitionVersion !== origin.widgetDefinitionVersion
  ) {
    throw new Error("Nested route-backed widget origin is stale");
  }
  return Object.freeze({
    originFocusId: origin.returnFocusId,
    originWidgetDefinitionId: origin.widgetDefinitionId,
    returnSurface: origin.surfaceId,
  });
}

export function buildNestedRouteBackedWidgetHref(
  href: string,
  origin: RouteBackedWidgetOrigin,
): string {
  let destination: URL;
  try {
    destination = new URL(href, "https://esbla.invalid");
  } catch {
    throw new Error("Nested route-backed widget destination is invalid");
  }
  const hasControlCharacter = Array.from(href).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
  if (
    !href.startsWith("/") ||
    href.startsWith("//") ||
    href.includes("#") ||
    href.includes("\\") ||
    hasControlCharacter ||
    destination.origin !== "https://esbla.invalid"
  ) {
    throw new Error("Nested route-backed widget destination is invalid");
  }
  const separator = href.indexOf("?");
  const pathname = separator === -1 ? href : href.slice(0, separator);
  if (!pathname || pathname.includes("?")) {
    throw new Error("Nested route-backed widget destination is invalid");
  }
  if (origin.widgetDefinitionId === null) return href;
  const parameters = new URLSearchParams(separator === -1 ? "" : href.slice(separator + 1));
  const encodedOrigin = getRouteBackedWidgetOriginParameters(origin);
  parameters.set("originFocusId", encodedOrigin.originFocusId);
  parameters.set("returnSurface", encodedOrigin.returnSurface);
  if (encodedOrigin.originWidgetDefinitionId) {
    parameters.set("originWidgetDefinitionId", encodedOrigin.originWidgetDefinitionId);
  }
  return `${pathname}?${parameters.toString()}`;
}

export function parseRouteBackedWidgetOrigin(
  search: Search,
  canonicalFallback: "/" | "/workspace/hr",
  expectedEntryRoutes: string | readonly string[],
): RouteBackedWidgetOrigin {
  const fallbackSurfaceId = surfaceIdForRoute(canonicalFallback);
  if (!fallbackSurfaceId) throw new Error("Route-backed widget fallback surface is invalid");
  return (
    parseOptionalRouteBackedWidgetOrigin(search, expectedEntryRoutes) ??
    Object.freeze({
      entryRoute: null,
      expansionMode: null,
      fallbackHref: canonicalFallback,
      returnFocusId: FALLBACK_FOCUS_ID,
      surfaceId: fallbackSurfaceId,
      widgetDefinitionId: null,
      widgetDefinitionVersion: null,
    })
  );
}

export function parseOptionalRouteBackedWidgetOrigin(
  search: Search,
  expectedEntryRoutes: string | readonly string[],
): RouteBackedWidgetOrigin | undefined {
  const allowedEntryRoutes =
    typeof expectedEntryRoutes === "string" ? [expectedEntryRoutes] : [...expectedEntryRoutes];
  if (
    allowedEntryRoutes.length === 0 ||
    allowedEntryRoutes.some(
      (route) =>
        !route.startsWith("/") ||
        route.startsWith("//") ||
        route.includes("?") ||
        route.includes("#"),
    )
  ) {
    throw new Error("Route-backed widget expected entry route is invalid");
  }
  const returnSurfaceToken = one(search.returnSurface);
  const surfaceId = parseSurfaceId(returnSurfaceToken);
  const originFocusId = one(search.originFocusId);
  const widgetDefinitionId = one(search.originWidgetDefinitionId);
  if (!surfaceId || !originFocusId || !ORIGIN_FOCUS_PATTERN.test(originFocusId)) return undefined;
  const legacyToken = Object.hasOwn(LEGACY_SURFACE_IDS, returnSurfaceToken ?? "");
  if (!legacyToken && !widgetDefinitionId) return undefined;
  try {
    const origin = resolveRegisteredOrigin(surfaceId, originFocusId, widgetDefinitionId);
    return origin.entryRoute && allowedEntryRoutes.includes(origin.entryRoute) ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function withoutRouteBackedWidgetOrigin(
  search: Search,
): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(search)
      .filter(
        ([key]) =>
          key !== "originFocusId" && key !== "originWidgetDefinitionId" && key !== "returnSurface",
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" || value === undefined ? value : [...value],
      ]),
  );
}

function parseScrollOffset(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 10_000_000
    ? value
    : undefined;
}

export function serializeRouteBackedWidgetReturnFocus(
  origin: RouteBackedWidgetReturnFocus,
): string {
  if (
    !parseRouteBackedWidgetFallbackHref(origin.fallbackHref) ||
    !ORIGIN_FOCUS_PATTERN.test(origin.returnFocusId) ||
    parseScrollOffset(origin.scrollLeft) === undefined ||
    parseScrollOffset(origin.scrollTop) === undefined
  ) {
    throw new Error("Route-backed widget return focus is invalid");
  }
  return JSON.stringify({
    fallbackHref: origin.fallbackHref,
    returnFocusId: origin.returnFocusId,
    scrollLeft: origin.scrollLeft,
    scrollTop: origin.scrollTop,
  });
}

export function parseRouteBackedWidgetReturnFocus(
  value: string | null,
): RouteBackedWidgetReturnFocus | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "fallbackHref,returnFocusId,scrollLeft,scrollTop"
    ) {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    const fallbackHref = parseRouteBackedWidgetFallbackHref(candidate.fallbackHref);
    const scrollLeft = parseScrollOffset(candidate.scrollLeft);
    const scrollTop = parseScrollOffset(candidate.scrollTop);
    if (
      !fallbackHref ||
      typeof candidate.returnFocusId !== "string" ||
      !ORIGIN_FOCUS_PATTERN.test(candidate.returnFocusId) ||
      scrollLeft === undefined ||
      scrollTop === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      fallbackHref,
      returnFocusId: candidate.returnFocusId,
      scrollLeft,
      scrollTop,
    });
  } catch {
    return undefined;
  }
}
