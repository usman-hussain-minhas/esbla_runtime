import type { ZenV1SurfaceId } from "@esbla/contracts";

type Search = Readonly<Record<string, string | readonly string[] | undefined>>;

export type RouteBackedWidgetFallbackHref =
  | "/"
  | "/workspace/hr"
  | "/workspace/hr/leave"
  | "/workspace/my-work";

export interface RouteBackedWidgetOrigin {
  readonly fallbackHref: RouteBackedWidgetFallbackHref;
  readonly returnFocusId: string;
}

export interface RouteBackedWidgetReturnFocus extends RouteBackedWidgetOrigin {
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export const ROUTE_BACKED_WIDGET_RETURN_FOCUS_KEY = "esbla.route-backed-widget.return-focus.v1";
const ORIGIN_FOCUS_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,12}$/;
const FALLBACK_FOCUS_ID = "route-backed-widget-fallback-focus";

function surfaceToken(surfaceId: ZenV1SurfaceId): "hr-mission-control" | "mission-control" {
  return surfaceId === "surface.hr.mission-control" ? "hr-mission-control" : "mission-control";
}

function one(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseRouteBackedWidgetFallbackHref(
  value: unknown,
): RouteBackedWidgetFallbackHref | undefined {
  return value === "/" ||
    value === "/workspace/hr" ||
    value === "/workspace/hr/leave" ||
    value === "/workspace/my-work"
    ? value
    : undefined;
}

export function buildRouteBackedWidgetHref(
  route: string,
  surfaceId: ZenV1SurfaceId,
  originFocusId: string,
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
  const parameters = new URLSearchParams({
    originFocusId,
    returnSurface: surfaceToken(surfaceId),
  });
  return `${route}?${parameters.toString()}`;
}

export function parseRouteBackedWidgetOrigin(
  search: Search,
  canonicalFallback: "/" | "/workspace/hr",
): RouteBackedWidgetOrigin {
  const returnSurface = one(search.returnSurface);
  const originFocusId = one(search.originFocusId);
  const fallbackHref =
    returnSurface === "mission-control"
      ? "/"
      : returnSurface === "hr-mission-control"
        ? "/workspace/hr"
        : canonicalFallback;
  return Object.freeze({
    fallbackHref,
    returnFocusId:
      originFocusId && ORIGIN_FOCUS_PATTERN.test(originFocusId) ? originFocusId : FALLBACK_FOCUS_ID,
  });
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
