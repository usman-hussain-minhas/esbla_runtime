import { PRESENTATION_BILLING_STATE } from "./platform-presentation-api.js";
import {
  getZenV1SurfaceContract,
  type PresentationSurfaceLayout,
  type PresentationWidgetPlacement,
  parsePresentationSurfaceLayout,
  parsePresentationWidgetPlacements,
  presentationWidgetPlacementSchema,
  type ZenV1SurfaceId,
} from "./platform-presentation-surface-api.js";

export interface PresentationSurfaceBaseVersion {
  readonly basedOnVersion: number | null;
  readonly baseVersion: number;
  readonly definitionHash: string;
  readonly placements: readonly PresentationWidgetPlacement[];
  readonly surfaceId: ZenV1SurfaceId;
}

export interface PresentationSurfaceDraft {
  readonly basedOnVersion: number;
  readonly candidateBaseVersion: number;
  readonly definitionHash: string;
  readonly draftVersion: number;
  readonly placements: readonly PresentationWidgetPlacement[];
  readonly surfaceId: ZenV1SurfaceId;
}

export interface PresentationSurfaceBaseWorkspace {
  readonly currentBase: PresentationSurfaceBaseVersion;
  readonly draft: PresentationSurfaceDraft | null;
  readonly headRowVersion: number;
  readonly history: readonly PresentationSurfaceBaseVersion[];
}

export interface UpsertPresentationSurfaceDraftBody {
  readonly expectedDraftVersion: number;
  readonly expectedHeadRowVersion: number;
  readonly placements: readonly PresentationWidgetPlacement[];
}

export interface UpsertPresentationSurfaceDraftResponse {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly draft: PresentationSurfaceDraft;
  readonly evidenceEventId: string;
  readonly replayed: boolean;
}

export interface ValidatePresentationSurfaceDraftBody {
  readonly expectedDraftVersion: number;
  readonly expectedHeadRowVersion: number;
}

export interface ValidatePresentationSurfaceDraftResponse {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly diagnostics: readonly string[];
  readonly draftVersion: number;
  readonly headRowVersion: number;
  readonly preview: readonly PresentationWidgetPlacement[];
  readonly valid: boolean;
}

export type PublishPresentationSurfaceDraftBody = ValidatePresentationSurfaceDraftBody;

export interface PresentationSurfaceBaseMutationResponse extends PresentationSurfaceBaseVersion {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly headRowVersion: number;
  readonly replayed: boolean;
}

export interface RollbackPresentationSurfaceBaseBody {
  readonly expectedHeadRowVersion: number;
  readonly sourceBaseVersion: number;
}

export interface ResetPresentationSurfaceOverlayBody {
  readonly expectedVersion: number;
}

export interface ResetPresentationSurfaceOverlayResponse extends PresentationSurfaceLayout {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly replayed: boolean;
}

const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const sha256Pattern = "^[0-9a-f]{64}$";
const maximumVersion = 2_147_483_647;

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

function safeInteger(value: unknown, minimum: number, maximum = maximumVersion): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
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

export function parseExactPresentationSurfacePlacementSet(
  surfaceId: ZenV1SurfaceId,
  value: unknown,
): readonly PresentationWidgetPlacement[] {
  const placements = parsePresentationWidgetPlacements(value);
  const contract = getZenV1SurfaceContract(surfaceId);
  const expected = new Map(
    contract.basePlacements.map(({ instanceId, widgetDefinitionId }) => [
      instanceId,
      widgetDefinitionId,
    ]),
  );
  if (
    placements.length !== expected.size ||
    placements.some(
      ({ instanceId, widgetDefinitionId }) => expected.get(instanceId) !== widgetDefinitionId,
    )
  ) {
    throw new Error("Invalid presentation surface instance set");
  }
  return placements;
}

export function parsePresentationSurfaceBaseVersion(
  value: unknown,
): PresentationSurfaceBaseVersion {
  if (
    !exactRecord(value, [
      "basedOnVersion",
      "baseVersion",
      "definitionHash",
      "placements",
      "surfaceId",
    ]) ||
    !safeInteger(value.baseVersion, 1) ||
    !(
      (value.baseVersion === 1 && value.basedOnVersion === null) ||
      (Number(value.baseVersion) > 1 &&
        safeInteger(value.basedOnVersion, 1, Number(value.baseVersion) - 1))
    ) ||
    typeof value.definitionHash !== "string" ||
    !new RegExp(sha256Pattern).test(value.definitionHash) ||
    (value.surfaceId !== "surface.mission-control" &&
      value.surfaceId !== "surface.hr.mission-control")
  ) {
    throw new Error("Invalid presentation surface base version");
  }
  const surfaceId = value.surfaceId;
  const contract = getZenV1SurfaceContract(surfaceId);
  const placements = parseExactPresentationSurfacePlacementSet(surfaceId, value.placements);
  if (
    value.definitionHash !== contract.definitionHash ||
    (value.baseVersion === 1 &&
      canonicalPlacements(placements) !== canonicalPlacements(contract.basePlacements))
  ) {
    throw new Error("Presentation surface base version drift");
  }
  return {
    basedOnVersion: value.basedOnVersion as number | null,
    baseVersion: value.baseVersion,
    definitionHash: value.definitionHash,
    placements,
    surfaceId,
  };
}

export function parsePresentationSurfaceDraft(value: unknown): PresentationSurfaceDraft {
  if (
    !exactRecord(value, [
      "basedOnVersion",
      "candidateBaseVersion",
      "definitionHash",
      "draftVersion",
      "placements",
      "surfaceId",
    ]) ||
    !safeInteger(value.basedOnVersion, 1, maximumVersion - 1) ||
    value.candidateBaseVersion !== Number(value.basedOnVersion) + 1 ||
    !safeInteger(value.draftVersion, 1) ||
    typeof value.definitionHash !== "string" ||
    !new RegExp(sha256Pattern).test(value.definitionHash) ||
    (value.surfaceId !== "surface.mission-control" &&
      value.surfaceId !== "surface.hr.mission-control")
  ) {
    throw new Error("Invalid presentation surface draft");
  }
  const surfaceId = value.surfaceId;
  const contract = getZenV1SurfaceContract(surfaceId);
  if (value.definitionHash !== contract.definitionHash) {
    throw new Error("Presentation surface draft definition drift");
  }
  return {
    basedOnVersion: value.basedOnVersion,
    candidateBaseVersion: value.candidateBaseVersion as number,
    definitionHash: value.definitionHash,
    draftVersion: value.draftVersion,
    placements: parseExactPresentationSurfacePlacementSet(surfaceId, value.placements),
    surfaceId,
  };
}

export function parsePresentationSurfaceBaseWorkspace(
  value: unknown,
): PresentationSurfaceBaseWorkspace {
  if (
    !exactRecord(value, ["currentBase", "draft", "headRowVersion", "history"]) ||
    !safeInteger(value.headRowVersion, 0) ||
    !Array.isArray(value.history) ||
    value.history.length < 1 ||
    value.history.length > 1_000
  ) {
    throw new Error("Invalid presentation surface base workspace");
  }
  const currentBase = parsePresentationSurfaceBaseVersion(value.currentBase);
  const draft = value.draft === null ? null : parsePresentationSurfaceDraft(value.draft);
  const history = value.history.map(parsePresentationSurfaceBaseVersion);
  if (
    history[0]?.baseVersion !== currentBase.baseVersion ||
    history.some(
      (version, index) =>
        version.surfaceId !== currentBase.surfaceId ||
        (index > 0 && version.baseVersion >= (history[index - 1]?.baseVersion ?? 0)),
    ) ||
    (draft !== null &&
      (draft.surfaceId !== currentBase.surfaceId ||
        draft.basedOnVersion !== currentBase.baseVersion))
  ) {
    throw new Error("Presentation surface base workspace drift");
  }
  return { currentBase, draft, headRowVersion: value.headRowVersion, history };
}

export function parseUpsertPresentationSurfaceDraftBody(
  value: unknown,
): UpsertPresentationSurfaceDraftBody {
  if (
    !exactRecord(value, ["expectedDraftVersion", "expectedHeadRowVersion", "placements"]) ||
    !safeInteger(value.expectedDraftVersion, 0, maximumVersion - 1) ||
    !safeInteger(value.expectedHeadRowVersion, 0, maximumVersion - 1)
  ) {
    throw new Error("Invalid presentation surface draft update");
  }
  return {
    expectedDraftVersion: value.expectedDraftVersion,
    expectedHeadRowVersion: value.expectedHeadRowVersion,
    placements: parsePresentationWidgetPlacements(value.placements),
  };
}

export function parseValidatePresentationSurfaceDraftBody(
  value: unknown,
): ValidatePresentationSurfaceDraftBody {
  if (
    !exactRecord(value, ["expectedDraftVersion", "expectedHeadRowVersion"]) ||
    !safeInteger(value.expectedDraftVersion, 0) ||
    !safeInteger(value.expectedHeadRowVersion, 0)
  ) {
    throw new Error("Invalid presentation surface draft validation");
  }
  return {
    expectedDraftVersion: value.expectedDraftVersion,
    expectedHeadRowVersion: value.expectedHeadRowVersion,
  };
}

export function parseRollbackPresentationSurfaceBaseBody(
  value: unknown,
): RollbackPresentationSurfaceBaseBody {
  if (
    !exactRecord(value, ["expectedHeadRowVersion", "sourceBaseVersion"]) ||
    !safeInteger(value.expectedHeadRowVersion, 1, maximumVersion - 1) ||
    !safeInteger(value.sourceBaseVersion, 1, maximumVersion - 1)
  ) {
    throw new Error("Invalid presentation surface base rollback");
  }
  return {
    expectedHeadRowVersion: value.expectedHeadRowVersion,
    sourceBaseVersion: value.sourceBaseVersion,
  };
}

export function parseResetPresentationSurfaceOverlayBody(
  value: unknown,
): ResetPresentationSurfaceOverlayBody {
  if (
    !exactRecord(value, ["expectedVersion"]) ||
    !safeInteger(value.expectedVersion, 1, maximumVersion - 1)
  ) {
    throw new Error("Invalid presentation surface overlay reset");
  }
  return { expectedVersion: value.expectedVersion };
}

function parseEvidenceFields(value: Readonly<Record<string, unknown>>): {
  readonly evidenceEventId: string;
  readonly replayed: boolean;
} {
  if (
    value.billingState !== PRESENTATION_BILLING_STATE ||
    typeof value.evidenceEventId !== "string" ||
    !new RegExp(uuidPattern).test(value.evidenceEventId) ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("Invalid presentation mutation evidence");
  }
  return { evidenceEventId: value.evidenceEventId, replayed: value.replayed };
}

export function parseUpsertPresentationSurfaceDraftResponse(
  value: unknown,
): UpsertPresentationSurfaceDraftResponse {
  if (!exactRecord(value, ["billingState", "draft", "evidenceEventId", "replayed"])) {
    throw new Error("Invalid presentation surface draft response");
  }
  return {
    billingState: PRESENTATION_BILLING_STATE,
    draft: parsePresentationSurfaceDraft(value.draft),
    ...parseEvidenceFields(value),
  };
}

export function parseValidatePresentationSurfaceDraftResponse(
  value: unknown,
): ValidatePresentationSurfaceDraftResponse {
  if (
    !exactRecord(value, [
      "billingState",
      "diagnostics",
      "draftVersion",
      "headRowVersion",
      "preview",
      "valid",
    ]) ||
    value.billingState !== PRESENTATION_BILLING_STATE ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 100 ||
    value.diagnostics.some(
      (diagnostic) =>
        typeof diagnostic !== "string" || diagnostic.length < 1 || diagnostic.length > 160,
    ) ||
    !safeInteger(value.draftVersion, 1) ||
    !safeInteger(value.headRowVersion, 1) ||
    typeof value.valid !== "boolean"
  ) {
    throw new Error("Invalid presentation surface draft validation response");
  }
  return {
    billingState: PRESENTATION_BILLING_STATE,
    diagnostics: value.diagnostics as readonly string[],
    draftVersion: value.draftVersion,
    headRowVersion: value.headRowVersion,
    preview: parsePresentationWidgetPlacements(value.preview),
    valid: value.valid,
  };
}

export function parsePresentationSurfaceBaseMutationResponse(
  value: unknown,
): PresentationSurfaceBaseMutationResponse {
  if (
    !exactRecord(value, [
      "basedOnVersion",
      "baseVersion",
      "billingState",
      "definitionHash",
      "evidenceEventId",
      "headRowVersion",
      "placements",
      "replayed",
      "surfaceId",
    ]) ||
    !safeInteger(value.headRowVersion, 1)
  ) {
    throw new Error("Invalid presentation surface base mutation response");
  }
  return {
    ...parsePresentationSurfaceBaseVersion({
      basedOnVersion: value.basedOnVersion,
      baseVersion: value.baseVersion,
      definitionHash: value.definitionHash,
      placements: value.placements,
      surfaceId: value.surfaceId,
    }),
    billingState: PRESENTATION_BILLING_STATE,
    ...parseEvidenceFields(value),
    headRowVersion: value.headRowVersion,
  };
}

export function parseResetPresentationSurfaceOverlayResponse(
  value: unknown,
): ResetPresentationSurfaceOverlayResponse {
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
    ])
  ) {
    throw new Error("Invalid presentation surface overlay reset response");
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
    ...parseEvidenceFields(value),
  };
}

export const upsertPresentationSurfaceDraftBodySchema = {
  $id: "UpsertPresentationSurfaceDraftBodyV1",
  additionalProperties: false,
  properties: {
    expectedDraftVersion: { maximum: maximumVersion - 1, minimum: 0, type: "integer" },
    expectedHeadRowVersion: { maximum: maximumVersion - 1, minimum: 0, type: "integer" },
    placements: { items: presentationWidgetPlacementSchema, maxItems: 100, type: "array" },
  },
  required: ["expectedDraftVersion", "expectedHeadRowVersion", "placements"],
  type: "object",
} as const;

export const validatePresentationSurfaceDraftBodySchema = {
  $id: "ValidatePresentationSurfaceDraftBodyV1",
  additionalProperties: false,
  properties: {
    expectedDraftVersion: { maximum: maximumVersion, minimum: 0, type: "integer" },
    expectedHeadRowVersion: { maximum: maximumVersion, minimum: 0, type: "integer" },
  },
  required: ["expectedDraftVersion", "expectedHeadRowVersion"],
  type: "object",
} as const;

export const rollbackPresentationSurfaceBaseBodySchema = {
  $id: "RollbackPresentationSurfaceBaseBodyV1",
  additionalProperties: false,
  properties: {
    expectedHeadRowVersion: { maximum: maximumVersion - 1, minimum: 1, type: "integer" },
    sourceBaseVersion: { maximum: maximumVersion - 1, minimum: 1, type: "integer" },
  },
  required: ["expectedHeadRowVersion", "sourceBaseVersion"],
  type: "object",
} as const;

export const resetPresentationSurfaceOverlayBodySchema = {
  $id: "ResetPresentationSurfaceOverlayBodyV1",
  additionalProperties: false,
  properties: {
    expectedVersion: { maximum: maximumVersion - 1, minimum: 1, type: "integer" },
  },
  required: ["expectedVersion"],
  type: "object",
} as const;
