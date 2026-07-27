import {
  canonicalizePresentationWidgetDefinition,
  getPresentationSurfaceDefinition,
  getPresentationWidgetDefinition,
  getZenV1SurfaceContract,
  PRESENTATION_SURFACE_DEFINITIONS,
  PRESENTATION_WIDGET_DEFINITIONS,
  type PresentationSurfaceDefaultInstance,
  type PresentationSurfaceDefinition,
  type PresentationWidgetDefinition,
  type PresentationWidgetPlacement,
  ZEN_V1_SURFACE_CONTRACTS,
} from "@esbla/contracts";
import { ZEN_THEME_ALIASES, ZEN_THEME_DEFINITION, type ZenPalette } from "./identity";

export type { ZenPalette };
export { ZEN_THEME_ALIASES, ZEN_THEME_DEFINITION };

export type SurfaceDefinition = PresentationSurfaceDefinition;
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
  readonly widgetDefinitionVersion: number;
}

export const SURFACE_DEFINITIONS = PRESENTATION_SURFACE_DEFINITIONS;

export const WIDGET_DEFINITIONS = PRESENTATION_WIDGET_DEFINITIONS;

export const DEFAULT_SURFACE_INSTANCES = Object.freeze(
  ZEN_V1_SURFACE_CONTRACTS.flatMap(({ defaultInstances, surfaceId }) =>
    defaultInstances.map(
      ({
        column,
        columnSpan,
        instanceId,
        row,
        rowSpan,
        sourceOrder,
        widgetDefinitionId,
        widgetDefinitionVersion,
      }) =>
        Object.freeze({
          column,
          columnSpan,
          id: instanceId,
          row,
          rowSpan,
          sourceOrder,
          surfaceId,
          widgetDefinitionId,
          widgetDefinitionVersion,
        }),
    ),
  ),
) satisfies readonly DefaultSurfaceInstance[];

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
  return getPresentationSurfaceDefinition(surfaceId);
}

export function getWidgetDefinition(
  widgetDefinitionId: string,
  widgetDefinitionVersion = 1,
): WidgetDefinition {
  return getPresentationWidgetDefinition(widgetDefinitionId, widgetDefinitionVersion);
}

export const canonicalizeWidgetDefinition = canonicalizePresentationWidgetDefinition;

export function getRegisteredSurfaceInstance(
  surfaceId: SurfaceDefinition["id"],
  widgetDefinitionId: string,
): PresentationSurfaceDefaultInstance {
  const instance = getZenV1SurfaceContract(surfaceId).defaultInstances.find(
    (candidate) => candidate.widgetDefinitionId === widgetDefinitionId,
  );
  if (!instance) throw new Error("Widget is not registered for this Zen surface");
  return instance;
}

export function getDefaultSurfacePlacement(
  surfaceId: SurfaceDefinition["id"],
  widgetDefinitionId: string,
): PresentationWidgetPlacement {
  return getRegisteredSurfaceInstance(surfaceId, widgetDefinitionId);
}
