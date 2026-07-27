import {
  canonicalizePresentationWidgetDefinition,
  getPresentationWidgetDefinition,
  getZenV1SurfaceContract,
  type PresentationWidgetDefinition,
  type PresentationWidgetPlacement,
} from "@esbla/contracts";
import { ZEN_THEME_ALIASES, ZEN_THEME_DEFINITION, type ZenPalette } from "./identity";

export type { ZenPalette };
export { ZEN_THEME_ALIASES, ZEN_THEME_DEFINITION };

export interface SurfaceDefinition {
  readonly baseVersion: 1;
  readonly columnCount: 12;
  readonly compactColumnCount: 4;
  readonly definitionHash: string;
  readonly id: "surface.hr.mission-control" | "surface.mission-control";
  readonly mediumColumnCount: 8;
  readonly route: "/" | "/workspace/hr";
  readonly serviceGroup: "hr" | "universal";
}

export type WidgetDefinition = PresentationWidgetDefinition;

export interface DefaultSurfaceInstance {
  readonly column: number;
  readonly columnSpan: number;
  readonly id: string;
  readonly row: number;
  readonly rowSpan: number;
  readonly sourceOrder: number;
  readonly surfaceId: SurfaceDefinition["id"];
  readonly widgetDefinitionId: string;
}

export const SURFACE_DEFINITIONS = [
  {
    baseVersion: 1,
    columnCount: 12,
    compactColumnCount: 4,
    definitionHash: getZenV1SurfaceContract("surface.mission-control").definitionHash,
    id: "surface.mission-control",
    mediumColumnCount: 8,
    route: "/",
    serviceGroup: "universal",
  },
  {
    baseVersion: 1,
    columnCount: 12,
    compactColumnCount: 4,
    definitionHash: getZenV1SurfaceContract("surface.hr.mission-control").definitionHash,
    id: "surface.hr.mission-control",
    mediumColumnCount: 8,
    route: "/workspace/hr",
    serviceGroup: "hr",
  },
] as const satisfies readonly SurfaceDefinition[];

export const WIDGET_DEFINITIONS = [
  getPresentationWidgetDefinition("hr.leave.my-requests"),
] as const satisfies readonly WidgetDefinition[];

export const DEFAULT_SURFACE_INSTANCES = [
  {
    column: 1,
    columnSpan: 4,
    id: "mission-control.my-leave",
    row: 4,
    rowSpan: 3,
    sourceOrder: 3,
    surfaceId: "surface.mission-control",
    widgetDefinitionId: "hr.leave.my-requests",
  },
  {
    column: 9,
    columnSpan: 4,
    id: "hr-mission-control.my-leave",
    row: 4,
    rowSpan: 3,
    sourceOrder: 6,
    surfaceId: "surface.hr.mission-control",
    widgetDefinitionId: "hr.leave.my-requests",
  },
] as const satisfies readonly DefaultSurfaceInstance[];

export const APPEARANCE_SETTING_DEFINITIONS = [
  {
    allowedValues: ["light", "dark"],
    defaultValue: "light",
    id: "appearance.palette.v1",
  },
  {
    allowedValues: [false, true],
    defaultValue: false,
    id: "appearance.high_contrast.v1",
  },
] as const;

export function getSurfaceDefinition(surfaceId: SurfaceDefinition["id"]): SurfaceDefinition {
  const definition = SURFACE_DEFINITIONS.find((candidate) => candidate.id === surfaceId);
  if (!definition) throw new Error("Unknown Zen surface definition");
  return definition;
}

export function getWidgetDefinition(widgetDefinitionId: string): WidgetDefinition {
  return getPresentationWidgetDefinition(widgetDefinitionId);
}

export const canonicalizeWidgetDefinition = canonicalizePresentationWidgetDefinition;

export function getDefaultSurfacePlacement(
  surfaceId: SurfaceDefinition["id"],
  widgetDefinitionId: string,
): PresentationWidgetPlacement {
  const placement = getZenV1SurfaceContract(surfaceId).basePlacements.find(
    (candidate) => candidate.widgetDefinitionId === widgetDefinitionId,
  );
  if (!placement) throw new Error("Widget is not registered for this Zen surface");
  return placement;
}
