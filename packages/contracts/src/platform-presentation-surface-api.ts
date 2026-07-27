import { PRESENTATION_BILLING_STATE } from "./platform-presentation-api.js";

export const zenV1SurfaceIds = ["surface.mission-control", "surface.hr.mission-control"] as const;
export type ZenV1SurfaceId = (typeof zenV1SurfaceIds)[number];

export interface PresentationWidgetPlacement {
  readonly column: number;
  readonly columnSpan: number;
  readonly instanceId: string;
  readonly row: number;
  readonly rowSpan: number;
  readonly widgetDefinitionId: string;
}

export interface ZenV1SurfaceContract {
  readonly basePlacements: readonly PresentationWidgetPlacement[];
  readonly baseVersion: 1;
  readonly definitionHash: string;
  readonly surfaceId: ZenV1SurfaceId;
}

export const ZEN_V1_SURFACE_CONTRACTS = [
  {
    basePlacements: [
      {
        column: 1,
        columnSpan: 4,
        instanceId: "mission-control.my-leave",
        row: 4,
        rowSpan: 3,
        widgetDefinitionId: "hr.leave.my-requests",
      },
    ],
    baseVersion: 1,
    definitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
    surfaceId: "surface.mission-control",
  },
  {
    basePlacements: [
      {
        column: 9,
        columnSpan: 4,
        instanceId: "hr-mission-control.my-leave",
        row: 4,
        rowSpan: 3,
        widgetDefinitionId: "hr.leave.my-requests",
      },
    ],
    baseVersion: 1,
    definitionHash: "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
    surfaceId: "surface.hr.mission-control",
  },
] as const satisfies readonly ZenV1SurfaceContract[];

export type PresentationSurfaceLayoutSource = "code_default" | "user_overlay";

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
    source: { enum: ["code_default", "user_overlay"] },
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
    (value.source !== "code_default" && value.source !== "user_overlay")
  ) {
    throw new Error("Invalid presentation surface layout");
  }
  const surfaceId = parseZenV1SurfaceId(value.surfaceId);
  const contract = getZenV1SurfaceContract(surfaceId);
  if (
    value.baseDefinitionHash !== contract.definitionHash ||
    value.baseVersion !== contract.baseVersion
  ) {
    throw new Error("Presentation surface definition drift");
  }
  const basePlacements = parsePlacements(value.basePlacements);
  const effectivePlacements = parsePlacements(value.effectivePlacements);
  const baseInstanceIds = new Set(basePlacements.map(({ instanceId }) => instanceId));
  const expectedEligibleBase = contract.basePlacements.filter(({ instanceId }) =>
    baseInstanceIds.has(instanceId),
  );
  if (canonicalPlacements(basePlacements) !== canonicalPlacements(expectedEligibleBase)) {
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
