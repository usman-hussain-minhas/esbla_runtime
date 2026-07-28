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
}

export interface PresentationSurfaceDefaultInstance extends PresentationWidgetPlacement {
  readonly placementPolicy: "default_optional" | "default_required";
  readonly sectionId: "overview";
  readonly sourceOrder: number;
  readonly widgetDefinitionVersion: number;
}

export interface ZenV1SurfaceContract {
  readonly basePlacements: readonly PresentationWidgetPlacement[];
  readonly baseVersion: 1;
  readonly canonicalHash: string;
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
] as const) satisfies readonly PresentationSurfaceDefaultInstance[];

const HR_MISSION_CONTROL_DEFAULT_INSTANCES = deepFreeze([
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
] as const) satisfies readonly PresentationSurfaceDefaultInstance[];

function placementFromDefaultInstance({
  column,
  columnSpan,
  instanceId,
  row,
  rowSpan,
  widgetDefinitionId,
}: PresentationSurfaceDefaultInstance): PresentationWidgetPlacement {
  return { column, columnSpan, instanceId, row, rowSpan, widgetDefinitionId };
}

const UNIVERSAL_MISSION_CONTROL_CONTRACT = {
  basePlacements: [placementFromDefaultInstance(UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES[0])],
  baseVersion: 1,
  defaultInstances: UNIVERSAL_MISSION_CONTROL_DEFAULT_INSTANCES,
  definitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
  surfaceId: "surface.mission-control",
} as const satisfies ZenV1SurfaceContractWithoutHash;

const HR_MISSION_CONTROL_CONTRACT = {
  basePlacements: [placementFromDefaultInstance(HR_MISSION_CONTROL_DEFAULT_INSTANCES[0])],
  baseVersion: 1,
  defaultInstances: HR_MISSION_CONTROL_DEFAULT_INSTANCES,
  definitionHash: "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
  surfaceId: "surface.hr.mission-control",
} as const satisfies ZenV1SurfaceContractWithoutHash;

export const ZEN_V1_SURFACE_CONTRACTS = deepFreeze([
  {
    ...UNIVERSAL_MISSION_CONTROL_CONTRACT,
    canonicalHash: "7a4c5954613fee26b0bad983f564910044e48984edd84c9160bb73948d5aa0a4",
  },
  {
    ...HR_MISSION_CONTROL_CONTRACT,
    canonicalHash: "7419ed984a5647920d4a699307bd36b8027b3e7b65a855845456d2c8530de497",
  },
] as const) satisfies readonly ZenV1SurfaceContract[];

export type PresentationSurfaceLayoutSource = "code_default" | "tenant_base" | "user_overlay";

export interface PresentationSurfaceLayout {
  readonly baseDefinitionHash: string;
  readonly basePlacements: readonly PresentationWidgetPlacement[];
  readonly baseVersion: number;
  readonly effectivePlacements: readonly PresentationWidgetPlacement[];
  readonly overlayVersion: number;
  readonly source: PresentationSurfaceLayoutSource;
  readonly surfaceId: ZenV1SurfaceId;
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
  },
  required: ["column", "columnSpan", "instanceId", "row", "rowSpan", "widgetDefinitionId"],
  type: "object",
} as const;

export const presentationSurfaceLayoutSchema = {
  $id: "PresentationSurfaceLayoutV1",
  additionalProperties: false,
  properties: {
    baseDefinitionHash: { pattern: sha256Pattern, type: "string" },
    basePlacements: { items: presentationWidgetPlacementSchema, maxItems: 100, type: "array" },
    baseVersion: { maximum: 2_147_483_647, minimum: 1, type: "integer" },
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
    "effectivePlacements",
    "overlayVersion",
    "source",
    "surfaceId",
  ],
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
    !new RegExp(identifierPattern).test(value.widgetDefinitionId)
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
  });
  return {
    ...placement,
    placementPolicy: value.placementPolicy,
    sectionId: value.sectionId,
    sourceOrder: value.sourceOrder,
    widgetDefinitionVersion: value.widgetDefinitionVersion,
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
    const surfaceType: PresentationWidgetSurfaceType =
      surface.serviceGroup === "universal" ? "mission_control" : "service_group_mission_control";
    for (const instance of instances) {
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
  if (
    basePlacements.length !== expectedEligibleBase.length ||
    basePlacements.some(
      ({ instanceId, widgetDefinitionId }) =>
        expectedEligibleBase.find((candidate) => candidate.instanceId === instanceId)
          ?.widgetDefinitionId !== widgetDefinitionId,
    )
  ) {
    throw new Error("Presentation surface base drift");
  }
  const expectedInstances = new Map(
    basePlacements.map(({ instanceId, widgetDefinitionId }) => [instanceId, widgetDefinitionId]),
  );
  if (
    effectivePlacements.length !== basePlacements.length ||
    effectivePlacements.some(
      ({ instanceId, widgetDefinitionId }) =>
        expectedInstances.get(instanceId) !== widgetDefinitionId,
    ) ||
    (value.source === "code_default" &&
      (value.baseVersion !== contract.baseVersion ||
        canonicalPlacements(basePlacements) !== canonicalPlacements(expectedEligibleBase) ||
        value.overlayVersion !== 0 ||
        canonicalPlacements(effectivePlacements) !== canonicalPlacements(basePlacements))) ||
    (value.source === "tenant_base" &&
      (value.overlayVersion !== 0 ||
        canonicalPlacements(effectivePlacements) !== canonicalPlacements(basePlacements))) ||
    (value.source === "user_overlay" && value.overlayVersion < 1)
  ) {
    throw new Error("Presentation surface effective layout drift");
  }
  return {
    baseDefinitionHash: value.baseDefinitionHash,
    basePlacements,
    baseVersion: value.baseVersion,
    effectivePlacements,
    overlayVersion: value.overlayVersion,
    source: value.source,
    surfaceId,
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
