import { PRESENTATION_BILLING_STATE } from "./platform-presentation-api.js";
import {
  getPresentationSemanticSurfaceDefinition,
  PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS,
  type PresentationSemanticSurfaceDefinition,
} from "./platform-presentation-semantic-registry.js";
import {
  type PresentationServiceGroupId,
  presentationServiceGroupIds,
} from "./platform-presentation-service-group.js";
import { type ZenV1SurfaceId, zenV1SurfaceIds } from "./platform-presentation-surface-api.js";
import type { PresentationSemanticIconKey } from "./platform-presentation-widget.js";

export const presentationShortcutSettingKeys = [
  "navigation.universal_shortcuts.v1",
  "navigation.contextual_shortcuts.v1",
] as const;
export const PRESENTATION_SHORTCUT_MAXIMUM_ITEMS = 20;

export type PresentationShortcutSettingKey = (typeof presentationShortcutSettingKeys)[number];
export type PresentationShortcutTargetId = ZenV1SurfaceId;
export const presentationShortcutSurfaceContextIds = Object.freeze([
  ...zenV1SurfaceIds,
]) as readonly ZenV1SurfaceId[];
export type PresentationShortcutSurfaceContextId = ZenV1SurfaceId;
export type PresentationShortcutContextId = "global" | PresentationShortcutSurfaceContextId;
export type PresentationShortcutContextKind = "global" | "surface";

export interface PresentationShortcutTarget {
  readonly href: string;
  readonly id: PresentationShortcutTargetId;
  readonly label: string;
  readonly semanticIcon: PresentationSemanticIconKey;
}

export interface PresentationShortcutSet {
  readonly contextId: PresentationShortcutContextId;
  readonly contextKind: PresentationShortcutContextKind;
  readonly editable: boolean;
  readonly eligibleTargets: readonly PresentationShortcutTarget[];
  readonly items: readonly PresentationShortcutTarget[];
  readonly settingKey: PresentationShortcutSettingKey;
  readonly tombstoneCount: number;
  readonly version: number;
}

export interface PresentationShortcutDiscovery {
  readonly contextual: PresentationShortcutSet | null;
  readonly universal: PresentationShortcutSet;
}

export interface PresentationShortcutDiscoveryQuery {
  readonly contextSurfaceId?: PresentationShortcutSurfaceContextId;
}

export interface UpdatePresentationShortcutBody {
  readonly contextId: PresentationShortcutContextId;
  readonly contextKind: PresentationShortcutContextKind;
  readonly expectedVersion: number;
  readonly operation: "append" | "remove";
  readonly settingKey: PresentationShortcutSettingKey;
  readonly targetId: PresentationShortcutTargetId;
}

export interface UpdatePresentationShortcutResponse {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly replayed: boolean;
  readonly set: PresentationShortcutSet;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PRESENTATION_SHORTCUT_TARGET_DEFINITIONS = deepFreeze([
  ...PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.map(({ label, route, semanticIcon, surfaceId }) => ({
    href: route,
    id: surfaceId,
    label,
    semanticIcon,
  })),
] as const) satisfies readonly PresentationShortcutTarget[];

export const presentationShortcutTargetIds = PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.map(
  ({ id }) => id,
) as readonly PresentationShortcutTargetId[];

export interface PresentationShortcutSurfaceContextDefinition {
  readonly allowedTargetIds: readonly PresentationShortcutTargetId[];
  readonly contextId: PresentationShortcutSurfaceContextId;
  readonly label: string;
  readonly selfTargetId: PresentationShortcutTargetId;
}

function surfaceContextAllowedTargetIds(
  surface: PresentationSemanticSurfaceDefinition,
): readonly PresentationShortcutTargetId[] {
  return PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.filter(
    (candidate) =>
      candidate.surfaceId !== surface.surfaceId &&
      (surface.serviceGroupId === "universal" ||
        candidate.serviceGroupId === surface.serviceGroupId),
  ).map(({ surfaceId }) => surfaceId);
}

export const PRESENTATION_SHORTCUT_SURFACE_CONTEXT_DEFINITIONS = deepFreeze(
  PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.map((surface) => ({
    allowedTargetIds: surfaceContextAllowedTargetIds(surface),
    contextId: surface.surfaceId,
    label: `${surface.label} surface`,
    selfTargetId: surface.surfaceId,
  })),
) satisfies readonly PresentationShortcutSurfaceContextDefinition[];

function validatePresentationShortcutSurfaceContextRegistry(): void {
  const contextIds = PRESENTATION_SHORTCUT_SURFACE_CONTEXT_DEFINITIONS.map(
    ({ contextId }) => contextId,
  );
  if (
    contextIds.length !== presentationShortcutSurfaceContextIds.length ||
    new Set(contextIds).size !== contextIds.length ||
    JSON.stringify(contextIds) !== JSON.stringify(presentationShortcutSurfaceContextIds)
  ) {
    throw new Error("Invalid presentation shortcut surface context registry");
  }
  for (const definition of PRESENTATION_SHORTCUT_SURFACE_CONTEXT_DEFINITIONS) {
    if (
      definition.label.trim() !== definition.label ||
      definition.label.length < 1 ||
      new Set(definition.allowedTargetIds).size !== definition.allowedTargetIds.length ||
      definition.allowedTargetIds.includes(definition.selfTargetId) ||
      !presentationShortcutTargetIds.includes(definition.selfTargetId) ||
      definition.allowedTargetIds.some(
        (targetId) => !presentationShortcutTargetIds.includes(targetId),
      ) ||
      JSON.stringify(definition.allowedTargetIds) !==
        JSON.stringify(
          surfaceContextAllowedTargetIds(
            getPresentationSemanticSurfaceDefinition(definition.contextId),
          ),
        )
    ) {
      throw new Error("Invalid presentation shortcut surface context registry");
    }
  }
}

validatePresentationShortcutSurfaceContextRegistry();

const maximumVersion = 2_147_483_647;
const maximumMutationVersion = maximumVersion - 1;
const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

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

function isVersion(value: unknown, maximum = maximumVersion): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function isServiceGroupId(value: unknown): value is PresentationServiceGroupId {
  return (
    typeof value === "string" &&
    presentationServiceGroupIds.includes(value as PresentationServiceGroupId)
  );
}

function isSurfaceContextId(value: unknown): value is PresentationShortcutSurfaceContextId {
  return (
    typeof value === "string" &&
    presentationShortcutSurfaceContextIds.includes(value as PresentationShortcutSurfaceContextId)
  );
}

export function getPresentationShortcutSurfaceContextDefinition(
  contextId: string,
): PresentationShortcutSurfaceContextDefinition {
  const definition = PRESENTATION_SHORTCUT_SURFACE_CONTEXT_DEFINITIONS.find(
    (candidate) => candidate.contextId === contextId,
  );
  if (!definition) throw new Error("Unknown presentation shortcut surface context");
  return definition;
}

export function getPresentationShortcutContextLabel(
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
): string {
  if (contextKind === "global" && contextId === "global") return "Universal";
  if (contextKind === "surface" && isSurfaceContextId(contextId)) {
    return getPresentationShortcutSurfaceContextDefinition(contextId).label;
  }
  throw new Error("Invalid presentation shortcut context");
}

export function getPresentationShortcutTargetDefinition(
  targetId: string,
): PresentationShortcutTarget {
  const definition = PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.find(({ id }) => id === targetId);
  if (!definition) throw new Error("Unknown presentation shortcut target");
  return definition;
}

export function getPresentationShortcutTargetServiceGroupId(
  targetId: PresentationShortcutTargetId,
): PresentationServiceGroupId | null {
  const serviceGroupId = getPresentationSemanticSurfaceDefinition(targetId).serviceGroupId;
  if (serviceGroupId === "universal") return null;
  if (isServiceGroupId(serviceGroupId)) {
    return serviceGroupId;
  }
  throw new Error("Unknown presentation shortcut target");
}

function exactTarget(value: unknown): PresentationShortcutTarget {
  if (
    !exactRecord(value, ["href", "id", "label", "semanticIcon"]) ||
    typeof value.id !== "string"
  ) {
    throw new Error("Invalid presentation shortcuts");
  }
  let definition: PresentationShortcutTarget;
  try {
    definition = getPresentationShortcutTargetDefinition(value.id);
  } catch {
    throw new Error("Invalid presentation shortcuts");
  }
  if (
    value.href !== definition.href ||
    value.label !== definition.label ||
    value.semanticIcon !== definition.semanticIcon
  ) {
    throw new Error("Invalid presentation shortcuts");
  }
  return definition;
}

function allowedTargetIds(
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
): readonly PresentationShortcutTargetId[] {
  if (contextKind === "global" && contextId === "global") {
    return presentationShortcutTargetIds;
  }
  if (contextKind === "surface" && isSurfaceContextId(contextId)) {
    return getPresentationShortcutSurfaceContextDefinition(contextId).allowedTargetIds;
  }
  throw new Error("Invalid presentation shortcuts");
}

function parseShortcutSet(value: unknown): PresentationShortcutSet {
  if (
    !exactRecord(value, [
      "contextId",
      "contextKind",
      "editable",
      "eligibleTargets",
      "items",
      "settingKey",
      "tombstoneCount",
      "version",
    ]) ||
    (value.contextKind !== "global" && value.contextKind !== "surface") ||
    (value.contextId !== "global" && !isSurfaceContextId(value.contextId)) ||
    typeof value.editable !== "boolean" ||
    !Array.isArray(value.eligibleTargets) ||
    !Array.isArray(value.items) ||
    !presentationShortcutSettingKeys.includes(value.settingKey as PresentationShortcutSettingKey) ||
    !isVersion(value.tombstoneCount, PRESENTATION_SHORTCUT_MAXIMUM_ITEMS) ||
    !isVersion(value.version)
  ) {
    throw new Error("Invalid presentation shortcuts");
  }
  const contextKind = value.contextKind;
  const contextId = value.contextId;
  const settingKey = value.settingKey as PresentationShortcutSettingKey;
  if (
    (settingKey === "navigation.universal_shortcuts.v1" &&
      (contextKind !== "global" || contextId !== "global")) ||
    (settingKey === "navigation.contextual_shortcuts.v1" &&
      !(contextKind === "surface" && isSurfaceContextId(contextId)))
  ) {
    throw new Error("Invalid presentation shortcuts");
  }
  const allowed = allowedTargetIds(contextKind, contextId);
  const eligibleTargets = value.eligibleTargets.map(exactTarget);
  const eligibleIds = eligibleTargets.map(({ id }) => id);
  const canonicalEligibleIds = allowed.filter((targetId) => eligibleIds.includes(targetId));
  if (
    eligibleTargets.length > allowed.length ||
    new Set(eligibleIds).size !== eligibleIds.length ||
    JSON.stringify(eligibleIds) !== JSON.stringify(canonicalEligibleIds)
  ) {
    throw new Error("Invalid presentation shortcuts");
  }
  const items = value.items.map(exactTarget);
  const itemIds = items.map(({ id }) => id);
  if (
    items.length > PRESENTATION_SHORTCUT_MAXIMUM_ITEMS ||
    new Set(itemIds).size !== itemIds.length ||
    itemIds.some((targetId) => !eligibleIds.includes(targetId))
  ) {
    throw new Error("Invalid presentation shortcuts");
  }
  return {
    contextId,
    contextKind,
    editable: value.editable,
    eligibleTargets,
    items,
    settingKey,
    tombstoneCount: value.tombstoneCount,
    version: value.version,
  };
}

export function parsePresentationShortcutDiscovery(value: unknown): PresentationShortcutDiscovery {
  if (!exactRecord(value, ["contextual", "universal"])) {
    throw new Error("Invalid presentation shortcuts");
  }
  const universal = parseShortcutSet(value.universal);
  if (universal.settingKey !== "navigation.universal_shortcuts.v1") {
    throw new Error("Invalid presentation shortcuts");
  }
  const contextual = value.contextual === null ? null : parseShortcutSet(value.contextual);
  if (contextual !== null && contextual.settingKey !== "navigation.contextual_shortcuts.v1") {
    throw new Error("Invalid presentation shortcuts");
  }
  if (contextual !== null) {
    const universalEligibleIds = universal.eligibleTargets.map(({ id }) => id);
    const expectedContextualEligibleIds = allowedTargetIds(
      contextual.contextKind,
      contextual.contextId,
    ).filter((targetId) => universalEligibleIds.includes(targetId));
    const contextualEligibleIds = contextual.eligibleTargets.map(({ id }) => id);
    if (
      !universalEligibleIds.includes(contextual.contextId as PresentationShortcutTargetId) ||
      JSON.stringify(contextualEligibleIds) !== JSON.stringify(expectedContextualEligibleIds)
    ) {
      throw new Error("Invalid presentation shortcuts");
    }
  }
  return { contextual, universal };
}

export function parsePresentationShortcutDiscoveryQuery(
  value: unknown,
): PresentationShortcutDiscoveryQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid presentation shortcut query");
  }
  const keys = ["contextSurfaceId"].filter((key) => key in value);
  if (!exactRecord(value, keys)) {
    throw new Error("Invalid presentation shortcut query");
  }
  if ("contextSurfaceId" in value) {
    if (!isSurfaceContextId(value.contextSurfaceId)) {
      throw new Error("Invalid presentation shortcut query");
    }
    return { contextSurfaceId: value.contextSurfaceId };
  }
  return {};
}

function assertUpdateContext(
  settingKey: PresentationShortcutSettingKey,
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
  targetId: PresentationShortcutTargetId,
): void {
  if (
    (settingKey === "navigation.universal_shortcuts.v1" &&
      (contextKind !== "global" || contextId !== "global")) ||
    (settingKey === "navigation.contextual_shortcuts.v1" &&
      !(contextKind === "surface" && isSurfaceContextId(contextId)))
  ) {
    throw new Error("Invalid presentation shortcut update");
  }
  if (!allowedTargetIds(contextKind, contextId).includes(targetId)) {
    throw new Error("Invalid presentation shortcut update");
  }
}

export function parseUpdatePresentationShortcutBody(
  value: unknown,
): UpdatePresentationShortcutBody {
  if (
    !exactRecord(value, [
      "contextId",
      "contextKind",
      "expectedVersion",
      "operation",
      "settingKey",
      "targetId",
    ]) ||
    (value.contextKind !== "global" && value.contextKind !== "surface") ||
    (value.contextId !== "global" && !isSurfaceContextId(value.contextId)) ||
    !isVersion(value.expectedVersion, maximumMutationVersion) ||
    (value.operation !== "append" && value.operation !== "remove") ||
    !presentationShortcutSettingKeys.includes(value.settingKey as PresentationShortcutSettingKey) ||
    typeof value.targetId !== "string" ||
    !presentationShortcutTargetIds.includes(value.targetId as PresentationShortcutTargetId)
  ) {
    throw new Error("Invalid presentation shortcut update");
  }
  const settingKey = value.settingKey as PresentationShortcutSettingKey;
  const targetId = value.targetId as PresentationShortcutTargetId;
  assertUpdateContext(settingKey, value.contextKind, value.contextId, targetId);
  return {
    contextId: value.contextId,
    contextKind: value.contextKind,
    expectedVersion: value.expectedVersion,
    operation: value.operation,
    settingKey,
    targetId,
  };
}

export function parseUpdatePresentationShortcutResponse(
  value: unknown,
): UpdatePresentationShortcutResponse {
  if (
    !exactRecord(value, ["billingState", "evidenceEventId", "replayed", "set"]) ||
    value.billingState !== PRESENTATION_BILLING_STATE ||
    typeof value.evidenceEventId !== "string" ||
    !new RegExp(uuidPattern).test(value.evidenceEventId) ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("Invalid presentation shortcut response");
  }
  return {
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId: value.evidenceEventId,
    replayed: value.replayed,
    set: parseShortcutSet(value.set),
  };
}

const presentationShortcutTargetSchema = {
  additionalProperties: false,
  properties: {
    href: { pattern: "^/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$", type: "string" },
    id: { enum: presentationShortcutTargetIds },
    label: { maxLength: 120, minLength: 1, type: "string" },
    semanticIcon: { maxLength: 80, minLength: 1, type: "string" },
  },
  required: ["href", "id", "label", "semanticIcon"],
  type: "object",
} as const;

const presentationShortcutSetSchema = {
  additionalProperties: false,
  properties: {
    contextId: {
      enum: ["global", ...presentationShortcutSurfaceContextIds],
    },
    contextKind: { enum: ["global", "surface"] },
    editable: { type: "boolean" },
    eligibleTargets: {
      items: presentationShortcutTargetSchema,
      maxItems: presentationShortcutTargetIds.length,
      type: "array",
    },
    items: {
      items: presentationShortcutTargetSchema,
      maxItems: PRESENTATION_SHORTCUT_MAXIMUM_ITEMS,
      type: "array",
    },
    settingKey: { enum: presentationShortcutSettingKeys },
    tombstoneCount: {
      maximum: PRESENTATION_SHORTCUT_MAXIMUM_ITEMS,
      minimum: 0,
      type: "integer",
    },
    version: { maximum: maximumVersion, minimum: 0, type: "integer" },
  },
  required: [
    "contextId",
    "contextKind",
    "editable",
    "eligibleTargets",
    "items",
    "settingKey",
    "tombstoneCount",
    "version",
  ],
  type: "object",
} as const;

export const presentationShortcutDiscoverySchema = {
  $id: "PresentationShortcutDiscoveryV1",
  additionalProperties: false,
  properties: {
    contextual: { anyOf: [presentationShortcutSetSchema, { type: "null" }] },
    universal: presentationShortcutSetSchema,
  },
  required: ["contextual", "universal"],
  type: "object",
} as const;

export const presentationShortcutDiscoveryQuerySchema = {
  $id: "PresentationShortcutDiscoveryQueryV1",
  additionalProperties: false,
  maxProperties: 1,
  properties: {
    contextSurfaceId: { enum: presentationShortcutSurfaceContextIds },
  },
  type: "object",
} as const;

export const updatePresentationShortcutBodySchema = {
  $id: "UpdatePresentationShortcutBodyV1",
  additionalProperties: false,
  properties: {
    contextId: {
      enum: ["global", ...presentationShortcutSurfaceContextIds],
    },
    contextKind: { enum: ["global", "surface"] },
    expectedVersion: { maximum: maximumMutationVersion, minimum: 0, type: "integer" },
    operation: { enum: ["append", "remove"] },
    settingKey: { enum: presentationShortcutSettingKeys },
    targetId: { enum: presentationShortcutTargetIds },
  },
  required: ["contextId", "contextKind", "expectedVersion", "operation", "settingKey", "targetId"],
  type: "object",
} as const;

export const updatePresentationShortcutResponseSchema = {
  $id: "UpdatePresentationShortcutResponseV1",
  additionalProperties: false,
  properties: {
    billingState: { const: PRESENTATION_BILLING_STATE },
    evidenceEventId: { pattern: uuidPattern, type: "string" },
    replayed: { type: "boolean" },
    set: presentationShortcutSetSchema,
  },
  required: ["billingState", "evidenceEventId", "replayed", "set"],
  type: "object",
} as const;
