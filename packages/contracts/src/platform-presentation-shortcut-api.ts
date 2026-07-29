import { PRESENTATION_BILLING_STATE } from "./platform-presentation-api.js";
import {
  PRESENTATION_SERVICE_GROUP_DEFINITIONS,
  type PresentationNavigationDestinationId,
  type PresentationServiceGroupId,
  presentationServiceGroupIds,
} from "./platform-presentation-service-group.js";
import type { PresentationSemanticIconKey } from "./platform-presentation-widget.js";

export const presentationShortcutSettingKeys = [
  "navigation.universal_shortcuts.v1",
  "navigation.contextual_shortcuts.v1",
] as const;
export const PRESENTATION_SHORTCUT_MAXIMUM_ITEMS = 20;

export type PresentationShortcutSettingKey = (typeof presentationShortcutSettingKeys)[number];
export type PresentationShortcutTargetId =
  | "platform.mission_control"
  | `service_group.${PresentationServiceGroupId}.mission_control`
  | PresentationNavigationDestinationId;
export type PresentationShortcutContextKind = "global" | "service";

export interface PresentationShortcutTarget {
  readonly href: string;
  readonly id: PresentationShortcutTargetId;
  readonly label: string;
  readonly semanticIcon: PresentationSemanticIconKey;
}

export interface PresentationShortcutSet {
  readonly contextId: "global" | PresentationServiceGroupId;
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
  readonly contextServiceGroupId?: PresentationServiceGroupId;
}

export interface UpdatePresentationShortcutBody {
  readonly contextId: "global" | PresentationServiceGroupId;
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
  {
    href: "/",
    id: "platform.mission_control",
    label: "Mission Control",
    semanticIcon: "home",
  },
  ...PRESENTATION_SERVICE_GROUP_DEFINITIONS.flatMap((group) => [
    {
      href: group.href,
      id: `service_group.${group.serviceGroupId}.mission_control`,
      label: `${group.label} Mission Control`,
      semanticIcon: group.semanticIcon,
    } as const,
    ...group.services.flatMap(({ destinations }) =>
      destinations.map(({ destinationId, href, label, semanticIcon }) => ({
        href,
        id: destinationId,
        label,
        semanticIcon,
      })),
    ),
  ]),
] as const) satisfies readonly PresentationShortcutTarget[];

export const presentationShortcutTargetIds = PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.map(
  ({ id }) => id,
) as readonly PresentationShortcutTargetId[];

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
  if (targetId === "platform.mission_control") return null;
  for (const group of PRESENTATION_SERVICE_GROUP_DEFINITIONS) {
    if (
      targetId === `service_group.${group.serviceGroupId}.mission_control` ||
      group.services.some(({ destinations }) =>
        destinations.some(({ destinationId }) => destinationId === targetId),
      )
    ) {
      return group.serviceGroupId;
    }
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
  contextId: "global" | PresentationServiceGroupId,
): readonly PresentationShortcutTargetId[] {
  if (contextKind === "global" && contextId === "global") {
    return presentationShortcutTargetIds;
  }
  if (contextKind === "service" && isServiceGroupId(contextId)) {
    return presentationShortcutTargetIds.filter(
      (targetId) => getPresentationShortcutTargetServiceGroupId(targetId) === contextId,
    );
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
    (value.contextKind !== "global" && value.contextKind !== "service") ||
    (value.contextId !== "global" && !isServiceGroupId(value.contextId)) ||
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
      (contextKind !== "service" || !isServiceGroupId(contextId)))
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
  return { contextual, universal };
}

export function parsePresentationShortcutDiscoveryQuery(
  value: unknown,
): PresentationShortcutDiscoveryQuery {
  if (
    !exactRecord(
      value,
      typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "contextServiceGroupId" in value
        ? ["contextServiceGroupId"]
        : [],
    )
  ) {
    throw new Error("Invalid presentation shortcut query");
  }
  if (!("contextServiceGroupId" in value)) return {};
  if (!isServiceGroupId(value.contextServiceGroupId)) {
    throw new Error("Invalid presentation shortcut query");
  }
  return { contextServiceGroupId: value.contextServiceGroupId };
}

function assertUpdateContext(
  settingKey: PresentationShortcutSettingKey,
  contextKind: PresentationShortcutContextKind,
  contextId: "global" | PresentationServiceGroupId,
  targetId: PresentationShortcutTargetId,
): void {
  if (
    (settingKey === "navigation.universal_shortcuts.v1" &&
      (contextKind !== "global" || contextId !== "global")) ||
    (settingKey === "navigation.contextual_shortcuts.v1" &&
      (contextKind !== "service" || !isServiceGroupId(contextId)))
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
    (value.contextKind !== "global" && value.contextKind !== "service") ||
    (value.contextId !== "global" && !isServiceGroupId(value.contextId)) ||
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
    contextId: { enum: ["global", ...presentationServiceGroupIds] },
    contextKind: { enum: ["global", "service"] },
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
  properties: {
    contextServiceGroupId: { enum: presentationServiceGroupIds },
  },
  type: "object",
} as const;

export const updatePresentationShortcutBodySchema = {
  $id: "UpdatePresentationShortcutBodyV1",
  additionalProperties: false,
  properties: {
    contextId: { enum: ["global", ...presentationServiceGroupIds] },
    contextKind: { enum: ["global", "service"] },
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
