import { PRESENTATION_BILLING_STATE } from "./platform-presentation-api.js";
import {
  type PresentationWidgetDefinition,
  type PresentationWidgetSurfaceType,
  validatePresentationWidgetRegistry,
} from "./platform-presentation-widget.js";

export const zenV1SurfaceIds = ["surface.mission-control", "surface.hr.mission-control"] as const;
export type ZenV1SurfaceId = (typeof zenV1SurfaceIds)[number];

export interface PresentationSurfaceDefinition {
  readonly baseVersion: 1;
  readonly columnCount: 12;
  readonly compactColumnCount: 4;
  readonly definitionHash: string;
  readonly id: ZenV1SurfaceId;
  readonly mediumColumnCount: 8;
  readonly route: "/" | "/workspace/hr";
  readonly serviceGroup: "hr" | "universal";
}

export type PresentationSurfaceDefinitionWithoutHash = Omit<
  PresentationSurfaceDefinition,
  "definitionHash"
>;

export interface PresentationWidgetPlacement {
  readonly column: number;
  readonly columnSpan: number;
  readonly instanceId: string;
  readonly row: number;
  readonly rowSpan: number;
  readonly widgetDefinitionId: string;
  readonly widgetDefinitionVersion: number;
}

export interface PresentationSurfaceDefaultInstance extends PresentationWidgetPlacement {
  readonly placementPolicy: "default_optional" | "default_required";
  readonly sectionId: "overview";
  readonly sourceOrder: number;
}

export interface PresentationSurfaceCatalogueInstance extends PresentationWidgetPlacement {
  readonly placementPolicy: "catalogue_optional";
  readonly sectionId: "overview";
  readonly sourceOrder: number;
}

export type PresentationSurfaceRegisteredInstance =
  | PresentationSurfaceCatalogueInstance
  | PresentationSurfaceDefaultInstance;

export interface PresentationSurfaceBreakpointPlacements {
  readonly desktop: readonly PresentationWidgetPlacement[];
  readonly phone: readonly PresentationWidgetPlacement[];
  readonly tablet: readonly PresentationWidgetPlacement[];
}

export interface ZenV1SurfaceContract {
  readonly basePlacements: readonly PresentationWidgetPlacement[];
  readonly basePlacementsByBreakpoint: PresentationSurfaceBreakpointPlacements;
  readonly baseVersion: 1;
  readonly canonicalHash: string;
  readonly catalogueInstances: readonly PresentationSurfaceCatalogueInstance[];
  readonly defaultInstances: readonly PresentationSurfaceDefaultInstance[];
  readonly definitionHash: string;
  readonly surfaceId: ZenV1SurfaceId;
}

export type ZenV1SurfaceContractWithoutHash = Omit<ZenV1SurfaceContract, "canonicalHash">;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function canonicalizePresentationSurfaceDefinition(
  definition: PresentationSurfaceDefinitionWithoutHash,
): string {
  return JSON.stringify(canonicalValue(definition));
}

export function canonicalizePresentationSurfaceContract(
  contract: ZenV1SurfaceContractWithoutHash,
): string {
  return JSON.stringify(canonicalValue(contract));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const UNIVERSAL_MISSION_CONTROL_SURFACE = {
  baseVersion: 1,
  columnCount: 12,
  compactColumnCount: 4,
  id: "surface.mission-control",
  mediumColumnCount: 8,
  route: "/",
  serviceGroup: "universal",
} as const satisfies PresentationSurfaceDefinitionWithoutHash;

const HR_MISSION_CONTROL_SURFACE = {
  baseVersion: 1,
  columnCount: 12,
  compactColumnCount: 4,
  id: "surface.hr.mission-control",
  mediumColumnCount: 8,
  route: "/workspace/hr",
  serviceGroup: "hr",
} as const satisfies PresentationSurfaceDefinitionWithoutHash;

export const PRESENTATION_SURFACE_DEFINITIONS = deepFreeze([
  {
    ...UNIVERSAL_MISSION_CONTROL_SURFACE,
    definitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
  },
  {
    ...HR_MISSION_CONTROL_SURFACE,
    definitionHash: "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
  },
] as const) satisfies readonly PresentationSurfaceDefinition[];

const UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES = deepFreeze([
  {
    column: 1,
    columnSpan: 7,
    instanceId: "mission-control.my-work",
    placementPolicy: "default_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 1,
    widgetDefinitionId: "platform.my-work.queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 8,
    columnSpan: 5,
    instanceId: "mission-control.my-published-shifts",
    placementPolicy: "default_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 2,
    widgetDefinitionId: "hr.shift.my-published",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.my-leave",
    placementPolicy: "default_optional",
    row: 4,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 3,
    widgetDefinitionId: "hr.leave.my-requests",
    widgetDefinitionVersion: 1,
  },
  {
    column: 5,
    columnSpan: 4,
    instanceId: "mission-control.my-attendance",
    placementPolicy: "default_optional",
    row: 4,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 4,
    widgetDefinitionId: "hr.attendance.my-observations",
    widgetDefinitionVersion: 1,
  },
  {
    column: 9,
    columnSpan: 4,
    instanceId: "mission-control.my-timesheets",
    placementPolicy: "default_optional",
    row: 4,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 5,
    widgetDefinitionId: "hr.timesheet.mine",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.my-expenses",
    placementPolicy: "default_optional",
    row: 7,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 6,
    widgetDefinitionId: "hr.expense.mine",
    widgetDefinitionVersion: 1,
  },
  {
    column: 5,
    columnSpan: 4,
    instanceId: "mission-control.my-profile",
    placementPolicy: "default_optional",
    row: 7,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 7,
    widgetDefinitionId: "hr.workforce.my-profile",
    widgetDefinitionVersion: 1,
  },
  {
    column: 9,
    columnSpan: 4,
    instanceId: "mission-control.direct-reports",
    placementPolicy: "default_optional",
    row: 7,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 8,
    widgetDefinitionId: "hr.workforce.direct-reports",
    widgetDefinitionVersion: 1,
  },
] as const) satisfies readonly PresentationSurfaceDefaultInstance[];

const HR_MISSION_CONTROL_DEFAULT_INSTANCES = deepFreeze([
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.my-profile",
    placementPolicy: "default_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 1,
    widgetDefinitionId: "hr.workforce.my-profile",
    widgetDefinitionVersion: 1,
  },
  {
    column: 5,
    columnSpan: 4,
    instanceId: "hr-mission-control.current-employment",
    placementPolicy: "default_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 2,
    widgetDefinitionId: "hr.employment.current-facts",
    widgetDefinitionVersion: 1,
  },
  {
    column: 9,
    columnSpan: 4,
    instanceId: "hr-mission-control.my-work",
    placementPolicy: "default_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 3,
    widgetDefinitionId: "platform.my-work.queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.my-published-shifts",
    placementPolicy: "default_optional",
    row: 4,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 4,
    widgetDefinitionId: "hr.shift.my-published",
    widgetDefinitionVersion: 1,
  },
  {
    column: 5,
    columnSpan: 4,
    instanceId: "hr-mission-control.my-attendance",
    placementPolicy: "default_optional",
    row: 4,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 5,
    widgetDefinitionId: "hr.attendance.my-observations",
    widgetDefinitionVersion: 1,
  },
  {
    column: 9,
    columnSpan: 4,
    instanceId: "hr-mission-control.my-leave",
    placementPolicy: "default_optional",
    row: 4,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 6,
    widgetDefinitionId: "hr.leave.my-requests",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 6,
    instanceId: "hr-mission-control.my-timesheets",
    placementPolicy: "default_optional",
    row: 7,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 7,
    widgetDefinitionId: "hr.timesheet.mine",
    widgetDefinitionVersion: 1,
  },
  {
    column: 7,
    columnSpan: 6,
    instanceId: "hr-mission-control.my-expenses",
    placementPolicy: "default_optional",
    row: 7,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 8,
    widgetDefinitionId: "hr.expense.mine",
    widgetDefinitionVersion: 1,
  },
] as const) satisfies readonly PresentationSurfaceDefaultInstance[];

const UNIVERSAL_MISSION_CONTROL_CATALOGUE_INSTANCES = deepFreeze([
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.employment-admin",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 9,
    widgetDefinitionId: "hr.employment.admin-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.employment-history",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 10,
    widgetDefinitionId: "hr.employment.history",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.workforce-admin",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 11,
    widgetDefinitionId: "hr.workforce.admin-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.workforce-status",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 12,
    widgetDefinitionId: "hr.workforce.status-reporting",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.my-tasks",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 13,
    widgetDefinitionId: "workspace.tasks.mine",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.roster-overview",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 14,
    widgetDefinitionId: "hr.shift.roster-overview",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.roster-publish",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 15,
    widgetDefinitionId: "hr.shift.publish-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.attendance-reports",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 16,
    widgetDefinitionId: "hr.attendance.reports",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.attendance-corrections",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 17,
    widgetDefinitionId: "hr.attendance.correction-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.leave-assigned",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 18,
    widgetDefinitionId: "hr.leave.assigned",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.leave-history",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 19,
    widgetDefinitionId: "hr.leave.history",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "mission-control.leave-request",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 20,
    widgetDefinitionId: "hr.leave.request-form",
    widgetDefinitionVersion: 1,
  },
] as const) satisfies readonly PresentationSurfaceCatalogueInstance[];

const HR_MISSION_CONTROL_CATALOGUE_INSTANCES = deepFreeze([
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.employment-admin",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 9,
    widgetDefinitionId: "hr.employment.admin-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.employment-history",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 10,
    widgetDefinitionId: "hr.employment.history",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.workforce-admin",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 11,
    widgetDefinitionId: "hr.workforce.admin-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.workforce-status",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 12,
    widgetDefinitionId: "hr.workforce.status-reporting",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.roster-overview",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 13,
    widgetDefinitionId: "hr.shift.roster-overview",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.roster-publish",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 14,
    widgetDefinitionId: "hr.shift.publish-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.attendance-reports",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 15,
    widgetDefinitionId: "hr.attendance.reports",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.attendance-corrections",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 16,
    widgetDefinitionId: "hr.attendance.correction-queue",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.leave-assigned",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 17,
    widgetDefinitionId: "hr.leave.assigned",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.leave-history",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 18,
    widgetDefinitionId: "hr.leave.history",
    widgetDefinitionVersion: 1,
  },
  {
    column: 1,
    columnSpan: 4,
    instanceId: "hr-mission-control.leave-request",
    placementPolicy: "catalogue_optional",
    row: 1,
    rowSpan: 3,
    sectionId: "overview",
    sourceOrder: 19,
    widgetDefinitionId: "hr.leave.request-form",
    widgetDefinitionVersion: 1,
  },
] as const) satisfies readonly PresentationSurfaceCatalogueInstance[];

function placementFromDefaultInstance({
  column,
  columnSpan,
  instanceId,
  row,
  rowSpan,
  widgetDefinitionId,
  widgetDefinitionVersion,
}: PresentationSurfaceRegisteredInstance): PresentationWidgetPlacement {
  return {
    column,
    columnSpan,
    instanceId,
    row,
    rowSpan,
    widgetDefinitionId,
    widgetDefinitionVersion,
  };
}

function compactPlacements(
  instances: readonly PresentationSurfaceDefaultInstance[],
  columnCount: 4 | 8,
): readonly PresentationWidgetPlacement[] {
  const perRow = columnCount / 4;
  return instances.map(({ instanceId, widgetDefinitionId, widgetDefinitionVersion }, index) => ({
    column: (index % perRow) * 4 + 1,
    columnSpan: 4,
    instanceId,
    row: Math.floor(index / perRow) * 3 + 1,
    rowSpan: 3,
    widgetDefinitionId,
    widgetDefinitionVersion,
  }));
}

const UNIVERSAL_MISSION_CONTROL_CONTRACT = {
  basePlacements: UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES.map(placementFromDefaultInstance),
  basePlacementsByBreakpoint: {
    desktop: UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES.map(placementFromDefaultInstance),
    phone: compactPlacements(UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES, 4),
    tablet: compactPlacements(UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES, 8),
  },
  baseVersion: 1,
  catalogueInstances: UNIVERSAL_MISSION_CONTROL_CATALOGUE_INSTANCES,
  defaultInstances: UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES,
  definitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
  surfaceId: "surface.mission-control",
} as const satisfies ZenV1SurfaceContractWithoutHash;

const HR_MISSION_CONTROL_CONTRACT = {
  basePlacements: HR_MISSION_CONTROL_DEFAULT_INSTANCES.map(placementFromDefaultInstance),
  basePlacementsByBreakpoint: {
    desktop: HR_MISSION_CONTROL_DEFAULT_INSTANCES.map(placementFromDefaultInstance),
    phone: compactPlacements(HR_MISSION_CONTROL_DEFAULT_INSTANCES, 4),
    tablet: compactPlacements(HR_MISSION_CONTROL_DEFAULT_INSTANCES, 8),
  },
  baseVersion: 1,
  catalogueInstances: HR_MISSION_CONTROL_CATALOGUE_INSTANCES,
  defaultInstances: HR_MISSION_CONTROL_DEFAULT_INSTANCES,
  definitionHash: "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
  surfaceId: "surface.hr.mission-control",
} as const satisfies ZenV1SurfaceContractWithoutHash;

export const ZEN_V1_SURFACE_CONTRACTS = deepFreeze([
  {
    ...UNIVERSAL_MISSION_CONTROL_CONTRACT,
    canonicalHash: "f7283bfdae04208b9df95275cfb353d917420b0d810c31c7cfa0351601b8eec6",
  },
  {
    ...HR_MISSION_CONTROL_CONTRACT,
    canonicalHash: "9a6a91db25a8e97ffbbc9dce6651fedc53575c69719b753b23864ac60a5aebc6",
  },
] as const) satisfies readonly ZenV1SurfaceContract[];

export type PresentationSurfaceLayoutSource = "code_default" | "tenant_base" | "user_overlay";
export type PresentationSurfaceLayoutDiagnostic = Readonly<{
  code: "overlay_placement_conflict";
  instanceId: string;
}>;

export interface PresentationSurfaceLayout {
  readonly baseDefinitionHash: string;
  readonly basePlacements: readonly PresentationWidgetPlacement[];
  readonly baseVersion: number;
  readonly diagnostics: readonly PresentationSurfaceLayoutDiagnostic[];
  readonly effectivePlacements: readonly PresentationWidgetPlacement[];
  readonly overlayVersion: number;
  readonly source: PresentationSurfaceLayoutSource;
  readonly surfaceId: ZenV1SurfaceId;
}

export type PresentationPersonalizationLockReason =
  | "layout_write_capability_absent"
  | "tenant_personalization_disabled";

export interface PresentationPersonalSurfaceEditorWorkspace {
  readonly availablePlacements: readonly PresentationWidgetPlacement[];
  readonly editable: boolean;
  readonly layout: PresentationSurfaceLayout;
  readonly lockReason: PresentationPersonalizationLockReason | null;
  readonly resettable: boolean;
}

export interface UpdatePresentationSurfaceOverlayBody {
  readonly expectedVersion: number;
  readonly placements: readonly PresentationWidgetPlacement[];
}

export interface UpdatePresentationSurfaceOverlayResponse extends PresentationSurfaceLayout {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly replayed: boolean;
}

export interface PresentationSurfacePath {
  readonly surfaceId: ZenV1SurfaceId;
}

const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const sha256Pattern = "^[0-9a-f]{64}$";
const identifierPattern = "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$";

export const presentationWidgetPlacementSchema = {
  additionalProperties: false,
  properties: {
    column: { maximum: 12, minimum: 1, type: "integer" },
    columnSpan: { maximum: 12, minimum: 1, type: "integer" },
    instanceId: { maxLength: 160, pattern: identifierPattern, type: "string" },
    row: { maximum: 1_000, minimum: 1, type: "integer" },
    rowSpan: { maximum: 100, minimum: 1, type: "integer" },
    widgetDefinitionId: { maxLength: 160, pattern: identifierPattern, type: "string" },
    widgetDefinitionVersion: {
      maximum: 2_147_483_647,
      minimum: 1,
      type: "integer",
    },
  },
  required: [
    "column",
    "columnSpan",
    "instanceId",
    "row",
    "rowSpan",
    "widgetDefinitionId",
    "widgetDefinitionVersion",
  ],
  type: "object",
} as const;

export const presentationSurfaceLayoutSchema = {
  $id: "PresentationSurfaceLayoutV1",
  additionalProperties: false,
  properties: {
    baseDefinitionHash: { pattern: sha256Pattern, type: "string" },
    basePlacements: { items: presentationWidgetPlacementSchema, maxItems: 100, type: "array" },
    baseVersion: { maximum: 2_147_483_647, minimum: 1, type: "integer" },
    diagnostics: {
      items: {
        additionalProperties: false,
        properties: {
          code: { const: "overlay_placement_conflict" },
          instanceId: { maxLength: 160, pattern: identifierPattern, type: "string" },
        },
        required: ["code", "instanceId"],
        type: "object",
      },
      maxItems: 100,
      type: "array",
    },
    effectivePlacements: {
      items: presentationWidgetPlacementSchema,
      maxItems: 100,
      type: "array",
    },
    overlayVersion: { maximum: 2_147_483_647, minimum: 0, type: "integer" },
    source: { enum: ["code_default", "tenant_base", "user_overlay"] },
    surfaceId: { enum: zenV1SurfaceIds },
  },
  required: [
    "baseDefinitionHash",
    "basePlacements",
    "baseVersion",
    "diagnostics",
    "effectivePlacements",
    "overlayVersion",
    "source",
    "surfaceId",
  ],
  type: "object",
} as const;

export const presentationPersonalSurfaceEditorWorkspaceSchema = {
  $id: "PresentationPersonalSurfaceEditorWorkspaceV1",
  additionalProperties: false,
  properties: {
    availablePlacements: {
      items: presentationWidgetPlacementSchema,
      maxItems: 100,
      type: "array",
    },
    editable: { type: "boolean" },
    layout: { $ref: "PresentationSurfaceLayoutV1#" },
    lockReason: {
      anyOf: [
        {
          enum: ["layout_write_capability_absent", "tenant_personalization_disabled"],
          type: "string",
        },
        { type: "null" },
      ],
    },
    resettable: { type: "boolean" },
  },
  required: ["availablePlacements", "editable", "layout", "lockReason", "resettable"],
  type: "object",
} as const;

export const presentationSurfacePathSchema = {
  $id: "PresentationSurfacePathV1",
  additionalProperties: false,
  properties: {
    surfaceId: { enum: zenV1SurfaceIds },
  },
  required: ["surfaceId"],
  type: "object",
} as const;

export const updatePresentationSurfaceOverlayBodySchema = {
  $id: "UpdatePresentationSurfaceOverlayBodyV1",
  additionalProperties: false,
  properties: {
    expectedVersion: { maximum: 2_147_483_646, minimum: 0, type: "integer" },
    placements: { items: presentationWidgetPlacementSchema, maxItems: 100, type: "array" },
  },
  required: ["expectedVersion", "placements"],
  type: "object",
} as const;

export const updatePresentationSurfaceOverlayResponseSchema = {
  $id: "UpdatePresentationSurfaceOverlayResponseV1",
  additionalProperties: false,
  properties: {
    ...presentationSurfaceLayoutSchema.properties,
    billingState: { const: PRESENTATION_BILLING_STATE },
    evidenceEventId: { pattern: uuidPattern, type: "string" },
    replayed: { type: "boolean" },
  },
  required: [
    ...presentationSurfaceLayoutSchema.required,
    "billingState",
    "evidenceEventId",
    "replayed",
  ],
  type: "object",
} as const;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function parsePresentationSurfaceDefinition(value: unknown): PresentationSurfaceDefinition {
  if (
    !exactRecord(value, [
      "baseVersion",
      "columnCount",
      "compactColumnCount",
      "definitionHash",
      "id",
      "mediumColumnCount",
      "route",
      "serviceGroup",
    ]) ||
    value.baseVersion !== 1 ||
    value.columnCount !== 12 ||
    value.compactColumnCount !== 4 ||
    value.mediumColumnCount !== 8 ||
    typeof value.definitionHash !== "string" ||
    !new RegExp(sha256Pattern).test(value.definitionHash) ||
    !zenV1SurfaceIds.includes(value.id as ZenV1SurfaceId) ||
    !(
      (value.id === "surface.mission-control" &&
        value.route === "/" &&
        value.serviceGroup === "universal") ||
      (value.id === "surface.hr.mission-control" &&
        value.route === "/workspace/hr" &&
        value.serviceGroup === "hr")
    )
  ) {
    throw new Error("Invalid presentation surface definition");
  }
  return value as unknown as PresentationSurfaceDefinition;
}

function parsePlacement(value: unknown): PresentationWidgetPlacement {
  const keys = [
    "column",
    "columnSpan",
    "instanceId",
    "row",
    "rowSpan",
    "widgetDefinitionId",
    "widgetDefinitionVersion",
  ] as const;
  if (
    !exactRecord(value, keys) ||
    !safeInteger(value.column, 1, 12) ||
    !safeInteger(value.columnSpan, 1, 12) ||
    Number(value.column) + Number(value.columnSpan) - 1 > 12 ||
    typeof value.instanceId !== "string" ||
    value.instanceId.length > 160 ||
    !new RegExp(identifierPattern).test(value.instanceId) ||
    !safeInteger(value.row, 1, 1_000) ||
    !safeInteger(value.rowSpan, 1, 100) ||
    typeof value.widgetDefinitionId !== "string" ||
    value.widgetDefinitionId.length > 160 ||
    !new RegExp(identifierPattern).test(value.widgetDefinitionId) ||
    !safeInteger(value.widgetDefinitionVersion, 1, 2_147_483_647)
  ) {
    throw new Error("Invalid presentation widget placement");
  }
  return {
    column: value.column,
    columnSpan: value.columnSpan,
    instanceId: value.instanceId,
    row: value.row,
    rowSpan: value.rowSpan,
    widgetDefinitionId: value.widgetDefinitionId,
    widgetDefinitionVersion: value.widgetDefinitionVersion,
  };
}

function parseDefaultInstance(value: unknown): PresentationSurfaceDefaultInstance {
  if (
    !exactRecord(value, [
      "column",
      "columnSpan",
      "instanceId",
      "placementPolicy",
      "row",
      "rowSpan",
      "sectionId",
      "sourceOrder",
      "widgetDefinitionId",
      "widgetDefinitionVersion",
    ]) ||
    (value.placementPolicy !== "default_optional" &&
      value.placementPolicy !== "default_required") ||
    value.sectionId !== "overview" ||
    !safeInteger(value.sourceOrder, 1, 10_000) ||
    !safeInteger(value.widgetDefinitionVersion, 1, 2_147_483_647)
  ) {
    throw new Error("Invalid presentation surface default instance");
  }
  const placement = parsePlacement({
    column: value.column,
    columnSpan: value.columnSpan,
    instanceId: value.instanceId,
    row: value.row,
    rowSpan: value.rowSpan,
    widgetDefinitionId: value.widgetDefinitionId,
    widgetDefinitionVersion: value.widgetDefinitionVersion,
  });
  return {
    ...placement,
    placementPolicy: value.placementPolicy,
    sectionId: value.sectionId,
    sourceOrder: value.sourceOrder,
  };
}

function parseCatalogueInstance(value: unknown): PresentationSurfaceCatalogueInstance {
  if (
    !exactRecord(value, [
      "column",
      "columnSpan",
      "instanceId",
      "placementPolicy",
      "row",
      "rowSpan",
      "sectionId",
      "sourceOrder",
      "widgetDefinitionId",
      "widgetDefinitionVersion",
    ]) ||
    value.placementPolicy !== "catalogue_optional" ||
    value.sectionId !== "overview" ||
    !safeInteger(value.sourceOrder, 1, 10_000) ||
    !safeInteger(value.widgetDefinitionVersion, 1, 2_147_483_647)
  ) {
    throw new Error("Invalid presentation surface catalogue instance");
  }
  const placement = parsePlacement({
    column: value.column,
    columnSpan: value.columnSpan,
    instanceId: value.instanceId,
    row: value.row,
    rowSpan: value.rowSpan,
    widgetDefinitionId: value.widgetDefinitionId,
    widgetDefinitionVersion: value.widgetDefinitionVersion,
  });
  return {
    ...placement,
    placementPolicy: value.placementPolicy,
    sectionId: value.sectionId,
    sourceOrder: value.sourceOrder,
  };
}

function parsePlacements(value: unknown): readonly PresentationWidgetPlacement[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Invalid presentation widget placements");
  }
  const placements = value.map(parsePlacement);
  if (new Set(placements.map(({ instanceId }) => instanceId)).size !== placements.length) {
    throw new Error("Duplicate presentation widget instance");
  }
  for (let left = 0; left < placements.length; left += 1) {
    for (let right = left + 1; right < placements.length; right += 1) {
      const a = placements[left];
      const b = placements[right];
      if (
        a &&
        b &&
        a.column < b.column + b.columnSpan &&
        b.column < a.column + a.columnSpan &&
        a.row < b.row + b.rowSpan &&
        b.row < a.row + a.rowSpan
      ) {
        throw new Error("Overlapping presentation widget instances");
      }
    }
  }
  return placements;
}

export function parsePresentationWidgetPlacements(
  value: unknown,
): readonly PresentationWidgetPlacement[] {
  return parsePlacements(value);
}

export function parsePresentationSurfaceRegisteredPlacementTemplates(
  surfaceId: ZenV1SurfaceId,
  value: unknown,
): readonly PresentationWidgetPlacement[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Invalid presentation surface catalogue");
  }
  const placements = value.map(parsePlacement);
  if (new Set(placements.map(({ instanceId }) => instanceId)).size !== placements.length) {
    throw new Error("Invalid presentation surface catalogue");
  }
  const registered = new Map(
    getZenV1RegisteredSurfaceInstances(surfaceId).map(
      ({ instanceId, widgetDefinitionId, widgetDefinitionVersion }) => [
        instanceId,
        `${widgetDefinitionId}@${widgetDefinitionVersion}`,
      ],
    ),
  );
  if (
    placements.some(
      ({ instanceId, widgetDefinitionId, widgetDefinitionVersion }) =>
        registered.get(instanceId) !== `${widgetDefinitionId}@${widgetDefinitionVersion}`,
    )
  ) {
    throw new Error("Presentation surface catalogue drift");
  }
  return Object.freeze(placements);
}

export function validatePresentationCompositionRegistries(
  surfaceDefinitions: readonly PresentationSurfaceDefinition[],
  surfaceContracts: readonly ZenV1SurfaceContract[],
  widgetDefinitions: readonly PresentationWidgetDefinition[],
): void {
  if (
    surfaceDefinitions.length !== zenV1SurfaceIds.length ||
    surfaceContracts.length !== surfaceDefinitions.length ||
    JSON.stringify(surfaceContracts.map(({ surfaceId }) => surfaceId)) !==
      JSON.stringify(zenV1SurfaceIds)
  ) {
    throw new Error("Invalid presentation surface registry");
  }
  validatePresentationWidgetRegistry(widgetDefinitions);

  const surfaceIds = new Set<string>();
  const surfaceHashes = new Set<string>();
  const routes = new Set<string>();
  const surfaces = new Map<ZenV1SurfaceId, PresentationSurfaceDefinition>();
  for (const candidate of surfaceDefinitions) {
    const definition = parsePresentationSurfaceDefinition(candidate);
    if (
      surfaceIds.has(definition.id) ||
      surfaceHashes.has(definition.definitionHash) ||
      routes.has(definition.route)
    ) {
      throw new Error("Duplicate presentation surface definition");
    }
    surfaceIds.add(definition.id);
    surfaceHashes.add(definition.definitionHash);
    routes.add(definition.route);
    surfaces.set(definition.id, definition);
  }
  if (JSON.stringify(surfaceDefinitions.map(({ id }) => id)) !== JSON.stringify(zenV1SurfaceIds)) {
    throw new Error("Invalid presentation surface registry order");
  }

  const widgets = new Map(
    widgetDefinitions.map((definition) => [
      `${definition.id}@${definition.definitionVersion}`,
      definition,
    ]),
  );
  const contractSurfaceIds = new Set<string>();
  const globalInstanceIds = new Set<string>();
  for (const contract of surfaceContracts) {
    const surface = surfaces.get(contract.surfaceId);
    if (
      !surface ||
      contractSurfaceIds.has(contract.surfaceId) ||
      contract.baseVersion !== surface.baseVersion ||
      !new RegExp(sha256Pattern).test(contract.canonicalHash) ||
      contract.definitionHash !== surface.definitionHash ||
      contract.defaultInstances.length !== contract.basePlacements.length
    ) {
      throw new Error("Invalid presentation surface contract");
    }
    contractSurfaceIds.add(contract.surfaceId);

    const instances = contract.defaultInstances.map(parseDefaultInstance);
    const catalogueInstances = contract.catalogueInstances.map(parseCatalogueInstance);
    if (
      new Set(instances.map(({ sourceOrder }) => sourceOrder)).size !== instances.length ||
      instances.some(
        ({ sourceOrder }, index) =>
          index > 0 && sourceOrder <= (instances[index - 1]?.sourceOrder ?? 0),
      ) ||
      JSON.stringify(instances.map(placementFromDefaultInstance)) !==
        JSON.stringify(contract.basePlacements)
    ) {
      throw new Error("Invalid presentation surface default registry");
    }
    const registeredInstances = [...instances, ...catalogueInstances];
    if (
      new Set(registeredInstances.map(({ sourceOrder }) => sourceOrder)).size !==
        registeredInstances.length ||
      registeredInstances.some(
        ({ sourceOrder }, index) =>
          index > 0 && sourceOrder <= (registeredInstances[index - 1]?.sourceOrder ?? 0),
      )
    ) {
      throw new Error("Invalid presentation surface catalogue registry");
    }
    const surfaceType: PresentationWidgetSurfaceType =
      surface.serviceGroup === "universal" ? "mission_control" : "service_group_mission_control";
    for (const instance of registeredInstances) {
      if (globalInstanceIds.has(instance.instanceId)) {
        throw new Error("Duplicate presentation surface instance");
      }
      globalInstanceIds.add(instance.instanceId);
      const widget = widgets.get(
        `${instance.widgetDefinitionId}@${instance.widgetDefinitionVersion}`,
      );
      if (!widget) throw new Error("Unknown presentation widget definition");
      if (!widget.supportedSurfaceTypes.includes(surfaceType)) {
        throw new Error("Unsupported presentation widget surface");
      }
      const bounds = widget.layoutConstraints.desktop;
      if (
        instance.columnSpan < bounds.minimumColumnSpan ||
        instance.columnSpan > bounds.maximumColumnSpan ||
        instance.rowSpan < bounds.minimumRowSpan ||
        instance.rowSpan > bounds.maximumRowSpan
      ) {
        throw new Error("Invalid presentation widget default geometry");
      }
    }
    parsePlacements(contract.basePlacements);
    const responsiveBases = contract.basePlacementsByBreakpoint;
    if (
      !responsiveBases ||
      typeof responsiveBases !== "object" ||
      !exactRecord(responsiveBases, ["desktop", "phone", "tablet"]) ||
      !Object.isFrozen(responsiveBases) ||
      !Array.isArray(responsiveBases.desktop) ||
      !Array.isArray(responsiveBases.tablet) ||
      !Array.isArray(responsiveBases.phone) ||
      !Object.isFrozen(responsiveBases.desktop) ||
      !Object.isFrozen(responsiveBases.tablet) ||
      !Object.isFrozen(responsiveBases.phone) ||
      canonicalPlacements(responsiveBases.desktop) !== canonicalPlacements(contract.basePlacements)
    ) {
      throw new Error("Invalid presentation surface breakpoint bases");
    }
    for (const [breakpoint, columns] of [
      ["desktop", 12],
      ["tablet", 8],
      ["phone", 4],
    ] as const) {
      const placements = parsePlacements(responsiveBases[breakpoint]);
      if (
        placements.length !== instances.length ||
        placements.some(
          (placement, index) =>
            placement.instanceId !== instances[index]?.instanceId ||
            placement.widgetDefinitionId !== instances[index]?.widgetDefinitionId ||
            placement.widgetDefinitionVersion !== instances[index]?.widgetDefinitionVersion ||
            placement.column + placement.columnSpan - 1 > columns,
        )
      ) {
        throw new Error("Invalid presentation surface breakpoint bases");
      }
      for (const placement of placements) {
        const instance = instances.find(({ instanceId }) => instanceId === placement.instanceId);
        const widget = instance
          ? widgets.get(`${instance.widgetDefinitionId}@${instance.widgetDefinitionVersion}`)
          : undefined;
        const bounds = widget?.layoutConstraints[breakpoint];
        if (
          !widget ||
          !bounds ||
          !widget.supportedBreakpointVariants.includes(breakpoint) ||
          placement.columnSpan < bounds.minimumColumnSpan ||
          placement.columnSpan > bounds.maximumColumnSpan ||
          placement.rowSpan < bounds.minimumRowSpan ||
          placement.rowSpan > bounds.maximumRowSpan
        ) {
          throw new Error("Invalid presentation surface breakpoint geometry");
        }
      }
    }
  }
}

function canonicalPlacements(placements: readonly PresentationWidgetPlacement[]): string {
  return JSON.stringify(
    placements.map((placement) => ({
      column: placement.column,
      columnSpan: placement.columnSpan,
      instanceId: placement.instanceId,
      row: placement.row,
      rowSpan: placement.rowSpan,
      widgetDefinitionId: placement.widgetDefinitionId,
      widgetDefinitionVersion: placement.widgetDefinitionVersion,
    })),
  );
}

export function parseZenV1SurfaceId(value: unknown): ZenV1SurfaceId {
  if (value !== "surface.mission-control" && value !== "surface.hr.mission-control") {
    throw new Error("Invalid Zen surface");
  }
  return value;
}

export function parsePresentationSurfacePath(value: unknown): PresentationSurfacePath {
  if (!exactRecord(value, ["surfaceId"])) {
    throw new Error("Invalid presentation surface path");
  }
  return { surfaceId: parseZenV1SurfaceId(value.surfaceId) };
}

export function getPresentationSurfaceDefinition(
  surfaceId: ZenV1SurfaceId,
): PresentationSurfaceDefinition {
  const definition = PRESENTATION_SURFACE_DEFINITIONS.find(
    (candidate) => candidate.id === surfaceId,
  );
  if (!definition) throw new Error("Unknown presentation surface definition");
  return parsePresentationSurfaceDefinition(definition);
}

export function getZenV1SurfaceContract(surfaceId: ZenV1SurfaceId): ZenV1SurfaceContract {
  const contract = ZEN_V1_SURFACE_CONTRACTS.find((candidate) => candidate.surfaceId === surfaceId);
  if (!contract) throw new Error("Unknown Zen surface");
  return contract;
}

export function getZenV1RegisteredSurfaceInstances(
  surfaceId: ZenV1SurfaceId,
): readonly PresentationSurfaceRegisteredInstance[] {
  const contract = getZenV1SurfaceContract(surfaceId);
  return Object.freeze([...contract.defaultInstances, ...contract.catalogueInstances]);
}

export function getZenV1RegisteredSurfacePlacements(
  surfaceId: ZenV1SurfaceId,
): readonly PresentationWidgetPlacement[] {
  return Object.freeze(
    getZenV1RegisteredSurfaceInstances(surfaceId).map((instance) =>
      Object.freeze(placementFromDefaultInstance(instance)),
    ),
  );
}

export function parseUpdatePresentationSurfaceOverlayBody(
  value: unknown,
): UpdatePresentationSurfaceOverlayBody {
  if (
    !exactRecord(value, ["expectedVersion", "placements"]) ||
    !safeInteger(value.expectedVersion, 0, 2_147_483_646)
  ) {
    throw new Error("Invalid presentation surface overlay update");
  }
  return {
    expectedVersion: value.expectedVersion,
    placements: parsePlacements(value.placements),
  };
}

export function parsePresentationSurfaceLayout(value: unknown): PresentationSurfaceLayout {
  if (
    !exactRecord(value, [
      "baseDefinitionHash",
      "basePlacements",
      "baseVersion",
      "diagnostics",
      "effectivePlacements",
      "overlayVersion",
      "source",
      "surfaceId",
    ]) ||
    typeof value.baseDefinitionHash !== "string" ||
    !new RegExp(sha256Pattern).test(value.baseDefinitionHash) ||
    !safeInteger(value.baseVersion, 1, 2_147_483_647) ||
    !safeInteger(value.overlayVersion, 0, 2_147_483_647) ||
    (value.source !== "code_default" &&
      value.source !== "tenant_base" &&
      value.source !== "user_overlay")
  ) {
    throw new Error("Invalid presentation surface layout");
  }
  const surfaceId = parseZenV1SurfaceId(value.surfaceId);
  const contract = getZenV1SurfaceContract(surfaceId);
  if (value.baseDefinitionHash !== contract.definitionHash) {
    throw new Error("Presentation surface definition drift");
  }
  const basePlacements = parsePlacements(value.basePlacements);
  const effectivePlacements = parsePlacements(value.effectivePlacements);
  const baseInstanceIds = new Set(basePlacements.map(({ instanceId }) => instanceId));
  const expectedEligibleBase = contract.basePlacements.filter(({ instanceId }) =>
    baseInstanceIds.has(instanceId),
  );
  const registeredInstances = new Map(
    getZenV1RegisteredSurfaceInstances(surfaceId).map(
      ({ instanceId, widgetDefinitionId, widgetDefinitionVersion }) => [
        instanceId,
        `${widgetDefinitionId}@${widgetDefinitionVersion}`,
      ],
    ),
  );
  if (
    basePlacements.some(({ instanceId, widgetDefinitionId, widgetDefinitionVersion }) => {
      return (
        registeredInstances.get(instanceId) !== `${widgetDefinitionId}@${widgetDefinitionVersion}`
      );
    })
  ) {
    throw new Error("Presentation surface base drift");
  }
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 100) {
    throw new Error("Invalid presentation surface diagnostics");
  }
  const diagnosticIds = new Set<string>();
  const diagnostics = value.diagnostics.map((diagnostic) => {
    if (
      !exactRecord(diagnostic, ["code", "instanceId"]) ||
      diagnostic.code !== "overlay_placement_conflict" ||
      typeof diagnostic.instanceId !== "string" ||
      !registeredInstances.has(diagnostic.instanceId) ||
      diagnosticIds.has(diagnostic.instanceId)
    ) {
      throw new Error("Invalid presentation surface diagnostics");
    }
    diagnosticIds.add(diagnostic.instanceId);
    return Object.freeze({
      code: "overlay_placement_conflict" as const,
      instanceId: diagnostic.instanceId,
    });
  });
  if (
    effectivePlacements.some(
      ({ instanceId, widgetDefinitionId, widgetDefinitionVersion }) =>
        registeredInstances.get(instanceId) !== `${widgetDefinitionId}@${widgetDefinitionVersion}`,
    ) ||
    (value.source === "code_default" &&
      (effectivePlacements.length !== basePlacements.length ||
        basePlacements.length !== expectedEligibleBase.length ||
        value.baseVersion !== contract.baseVersion ||
        canonicalPlacements(basePlacements) !== canonicalPlacements(expectedEligibleBase) ||
        value.overlayVersion !== 0 ||
        canonicalPlacements(effectivePlacements) !== canonicalPlacements(basePlacements))) ||
    (value.source === "tenant_base" &&
      (effectivePlacements.length !== basePlacements.length ||
        value.overlayVersion !== 0 ||
        canonicalPlacements(effectivePlacements) !== canonicalPlacements(basePlacements))) ||
    (value.source === "user_overlay" && value.overlayVersion < 1) ||
    (value.source !== "user_overlay" && diagnostics.length > 0)
  ) {
    throw new Error("Presentation surface effective layout drift");
  }
  return {
    baseDefinitionHash: value.baseDefinitionHash,
    basePlacements,
    baseVersion: value.baseVersion,
    diagnostics: Object.freeze(diagnostics),
    effectivePlacements,
    overlayVersion: value.overlayVersion,
    source: value.source,
    surfaceId,
  };
}

export function parsePresentationPersonalSurfaceEditorWorkspace(
  value: unknown,
): PresentationPersonalSurfaceEditorWorkspace {
  if (
    !exactRecord(value, [
      "availablePlacements",
      "editable",
      "layout",
      "lockReason",
      "resettable",
    ]) ||
    typeof value.editable !== "boolean" ||
    typeof value.resettable !== "boolean" ||
    (value.lockReason !== null &&
      value.lockReason !== "layout_write_capability_absent" &&
      value.lockReason !== "tenant_personalization_disabled") ||
    (value.editable && value.lockReason !== null) ||
    (!value.editable && value.lockReason === null)
  ) {
    throw new Error("Invalid personal surface editor workspace");
  }
  const layout = parsePresentationSurfaceLayout(value.layout);
  const availablePlacements = parsePresentationSurfaceRegisteredPlacementTemplates(
    layout.surfaceId,
    value.availablePlacements,
  );
  const availableInstances = new Set(availablePlacements.map(({ instanceId }) => instanceId));
  if (
    layout.effectivePlacements.some(({ instanceId }) => !availableInstances.has(instanceId)) ||
    layout.basePlacements.some(({ instanceId }) => !availableInstances.has(instanceId))
  ) {
    throw new Error("Personal surface editor catalogue drift");
  }
  return {
    availablePlacements,
    editable: value.editable,
    layout,
    lockReason: value.lockReason,
    resettable: value.resettable,
  };
}

export function parseUpdatePresentationSurfaceOverlayResponse(
  value: unknown,
): UpdatePresentationSurfaceOverlayResponse {
  if (
    !exactRecord(value, [
      "baseDefinitionHash",
      "basePlacements",
      "baseVersion",
      "billingState",
      "diagnostics",
      "effectivePlacements",
      "evidenceEventId",
      "overlayVersion",
      "replayed",
      "source",
      "surfaceId",
    ]) ||
    value.billingState !== PRESENTATION_BILLING_STATE ||
    typeof value.evidenceEventId !== "string" ||
    !new RegExp(uuidPattern).test(value.evidenceEventId) ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("Invalid presentation surface overlay response");
  }
  return {
    ...parsePresentationSurfaceLayout({
      baseDefinitionHash: value.baseDefinitionHash,
      basePlacements: value.basePlacements,
      baseVersion: value.baseVersion,
      diagnostics: value.diagnostics,
      effectivePlacements: value.effectivePlacements,
      overlayVersion: value.overlayVersion,
      source: value.source,
      surfaceId: value.surfaceId,
    }),
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId: value.evidenceEventId,
    replayed: value.replayed,
  };
}
