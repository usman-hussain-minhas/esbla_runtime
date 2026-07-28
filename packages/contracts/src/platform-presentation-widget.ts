export const presentationWidgetStates = [
  "idle",
  "loading",
  "populated",
  "empty",
  "unavailable",
  "operational_error",
  "permission_denied",
  "service_inactive",
  "not_found",
  "stale_retrying",
] as const;

export type PresentationWidgetState = (typeof presentationWidgetStates)[number];

export const presentationSemanticIconKeys = [
  "home",
  "modules",
  "menu",
  "user",
  "settings",
  "edit",
  "sun",
  "moon",
  "contrast",
  "search",
  "bell",
  "warning",
  "team",
  "plus",
  "fullscreen",
  "x",
  "users-round",
  "user-round",
  "briefcase-business",
  "calendar-range",
  "clock-3",
  "calendar-check",
  "list-checks",
  "receipt-text",
  "diamond",
  "check-square",
  "generic-service",
] as const;

export type PresentationSemanticIconKey = (typeof presentationSemanticIconKeys)[number];

export const presentationWidgetKinds = [
  "instant",
  "detailed",
  "operational",
  "configuration_aware",
  "composite",
] as const;
export type PresentationWidgetKind = (typeof presentationWidgetKinds)[number];

export const presentationWidgetSurfaceTypes = [
  "mission_control",
  "service_group_mission_control",
  "standalone",
] as const;
export type PresentationWidgetSurfaceType = (typeof presentationWidgetSurfaceTypes)[number];

export const presentationWidgetBreakpointVariants = ["desktop", "tablet", "phone"] as const;
export type PresentationWidgetBreakpointVariant =
  (typeof presentationWidgetBreakpointVariants)[number];

function isPresentationSemanticIconKey(value: unknown): value is PresentationSemanticIconKey {
  return (
    typeof value === "string" &&
    presentationSemanticIconKeys.includes(value as PresentationSemanticIconKey)
  );
}

export function parsePresentationSemanticIconKey(value: unknown): PresentationSemanticIconKey {
  if (!isPresentationSemanticIconKey(value)) {
    throw new Error("Invalid presentation semantic icon");
  }
  return value;
}

export interface PresentationWidgetLayoutConstraint {
  readonly maximumColumnSpan: number;
  readonly maximumRowSpan: number;
  readonly minimumColumnSpan: number;
  readonly minimumRowSpan: number;
  readonly preferredColumnSpan: number;
  readonly preferredRowSpan: number;
}

export interface PresentationWidgetDefinition {
  readonly activationServiceKey: string;
  readonly allowedCommandIds: readonly string[];
  readonly billingTreatment: "non_billable";
  readonly cachePolicy: "no_store";
  readonly canonicalHash: string;
  readonly configurationSchema: Readonly<Record<string, unknown>>;
  readonly definitionVersion: number;
  readonly displayName: string;
  readonly eligibilityPolicyId: string;
  readonly evidenceRequirements: readonly string[];
  readonly fullScreenRoute: string | null;
  readonly fullWidthEligible: boolean;
  readonly id: string;
  readonly inlineMutationEligible: boolean;
  readonly layoutConstraints: {
    readonly desktop: PresentationWidgetLayoutConstraint;
    readonly phone: PresentationWidgetLayoutConstraint;
    readonly tablet: PresentationWidgetLayoutConstraint;
  };
  readonly migration: {
    readonly compatibleFrom: number;
    readonly compatibleThrough: number;
    readonly id: string;
  };
  readonly privacyClassification: "confidential";
  readonly proofRequirementIds: readonly string[];
  readonly readModelId: string;
  readonly refreshPolicy: "manual";
  readonly requiredCapabilityIds: readonly string[];
  readonly semanticIcon: PresentationSemanticIconKey;
  readonly showMoreEligible: boolean;
  readonly sourceServiceGroup: string;
  readonly sourceServiceKey: string;
  readonly supportedBreakpointVariants: readonly PresentationWidgetBreakpointVariant[];
  readonly supportedStates: readonly PresentationWidgetState[];
  readonly supportedSurfaceTypes: readonly PresentationWidgetSurfaceType[];
  readonly widgetKind: PresentationWidgetKind;
}

export type PresentationWidgetDefinitionWithoutHash = Omit<
  PresentationWidgetDefinition,
  "canonicalHash"
>;

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

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

export function canonicalizePresentationWidgetDefinition(
  definition: PresentationWidgetDefinitionWithoutHash,
): string {
  return JSON.stringify(canonicalValue(definition));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function boundedString(value: unknown, maximum = 200): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum
  );
}

function identifier(value: unknown): value is string {
  return boundedString(value, 160) && identifierPattern.test(value);
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function uniqueStringArray(
  value: unknown,
  options: { readonly allowEmpty: boolean; readonly identifierOnly: boolean },
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    (options.allowEmpty || value.length > 0) &&
    value.every((candidate) =>
      options.identifierOnly ? identifier(candidate) : boundedString(candidate, 200),
    ) &&
    new Set(value).size === value.length
  );
}

function validateJsonValue(
  value: unknown,
  state: { count: number; readonly path: WeakSet<object> },
  depth: number,
): boolean {
  state.count += 1;
  if (depth > 20 || state.count > 2_000) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (state.path.has(value)) return false;
  state.path.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((candidate) =>
    validateJsonValue(candidate, state, depth + 1),
  );
  state.path.delete(value);
  return valid;
}

function isJsonValue(value: unknown): boolean {
  return validateJsonValue(value, { count: 0, path: new WeakSet<object>() }, 0);
}

function validLayoutConstraint(
  value: unknown,
  maximumColumns: number,
): value is PresentationWidgetLayoutConstraint {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "maximumColumnSpan",
      "maximumRowSpan",
      "minimumColumnSpan",
      "minimumRowSpan",
      "preferredColumnSpan",
      "preferredRowSpan",
    ]) ||
    !safeInteger(value.minimumColumnSpan, 1, maximumColumns) ||
    !safeInteger(value.preferredColumnSpan, 1, maximumColumns) ||
    !safeInteger(value.maximumColumnSpan, 1, maximumColumns) ||
    !safeInteger(value.minimumRowSpan, 1, 100) ||
    !safeInteger(value.preferredRowSpan, 1, 100) ||
    !safeInteger(value.maximumRowSpan, 1, 100)
  ) {
    return false;
  }
  return (
    value.minimumColumnSpan <= value.preferredColumnSpan &&
    value.preferredColumnSpan <= value.maximumColumnSpan &&
    value.minimumRowSpan <= value.preferredRowSpan &&
    value.preferredRowSpan <= value.maximumRowSpan
  );
}

function validInternalRoute(value: unknown): value is string | null {
  return (
    value === null ||
    (boundedString(value, 300) &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("?") &&
      !value.includes("#"))
  );
}

const HR_LEAVE_MY_REQUESTS_MANIFEST = {
  activationServiceKey: "hr.leave_request",
  allowedCommandIds: [],
  billingTreatment: "non_billable",
  cachePolicy: "no_store",
  configurationSchema: {
    additionalProperties: false,
    properties: {},
    type: "object",
  },
  definitionVersion: 1,
  displayName: "My Leave Requests",
  eligibilityPolicyId: "current_tenant_activation_and_capability_v1",
  evidenceRequirements: ["current_authorization", "current_service_activation"],
  fullScreenRoute: "/workspace/hr/leave",
  fullWidthEligible: true,
  id: "hr.leave.my-requests",
  inlineMutationEligible: false,
  layoutConstraints: {
    desktop: {
      maximumColumnSpan: 12,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
      preferredColumnSpan: 4,
      preferredRowSpan: 3,
    },
    phone: {
      maximumColumnSpan: 4,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
      preferredColumnSpan: 4,
      preferredRowSpan: 3,
    },
    tablet: {
      maximumColumnSpan: 8,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
      preferredColumnSpan: 4,
      preferredRowSpan: 3,
    },
  },
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.leave.my-requests.v1",
  },
  privacyClassification: "confidential",
  proofRequirementIds: ["ZEN-WIDGET-001", "ZEN-WIDGET-002", "ZEN-FULL-001", "ZEN-SEC-001"],
  readModelId: "hr.leave.my-requests.read.v1",
  refreshPolicy: "manual",
  requiredCapabilityIds: ["hr.leave.list_own", "hr.leave.view"],
  semanticIcon: "calendar-check",
  showMoreEligible: true,
  sourceServiceGroup: "hr",
  sourceServiceKey: "leave_request",
  supportedBreakpointVariants: presentationWidgetBreakpointVariants,
  supportedStates: presentationWidgetStates,
  supportedSurfaceTypes: presentationWidgetSurfaceTypes,
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

export const HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION = deepFreeze({
  ...HR_LEAVE_MY_REQUESTS_MANIFEST,
  canonicalHash: "b114b88d602b8b7c79fb2597a6ece9d818c4c530d40759f89df55eea171c3705",
}) satisfies PresentationWidgetDefinition;

export const PRESENTATION_WIDGET_DEFINITIONS = deepFreeze([
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
] as const) satisfies readonly PresentationWidgetDefinition[];

export function parsePresentationWidgetDefinition(value: unknown): PresentationWidgetDefinition {
  if (!isRecord(value)) throw new Error("Invalid presentation widget definition");
  if (
    !exactKeys(value, [
      "activationServiceKey",
      "allowedCommandIds",
      "billingTreatment",
      "cachePolicy",
      "canonicalHash",
      "configurationSchema",
      "definitionVersion",
      "displayName",
      "eligibilityPolicyId",
      "evidenceRequirements",
      "fullScreenRoute",
      "fullWidthEligible",
      "id",
      "inlineMutationEligible",
      "layoutConstraints",
      "migration",
      "privacyClassification",
      "proofRequirementIds",
      "readModelId",
      "refreshPolicy",
      "requiredCapabilityIds",
      "semanticIcon",
      "showMoreEligible",
      "sourceServiceGroup",
      "sourceServiceKey",
      "supportedBreakpointVariants",
      "supportedStates",
      "supportedSurfaceTypes",
      "widgetKind",
    ]) ||
    !identifier(value.id) ||
    !safeInteger(value.definitionVersion, 1, 2_147_483_647) ||
    !boundedString(value.displayName, 160) ||
    !isPresentationSemanticIconKey(value.semanticIcon) ||
    !identifier(value.sourceServiceGroup) ||
    !identifier(value.sourceServiceKey) ||
    !identifier(value.activationServiceKey) ||
    !identifier(value.readModelId) ||
    !identifier(value.eligibilityPolicyId) ||
    !presentationWidgetKinds.includes(value.widgetKind as PresentationWidgetKind) ||
    !uniqueStringArray(value.allowedCommandIds, { allowEmpty: true, identifierOnly: true }) ||
    !uniqueStringArray(value.requiredCapabilityIds, {
      allowEmpty: false,
      identifierOnly: true,
    }) ||
    !Array.isArray(value.supportedSurfaceTypes) ||
    value.supportedSurfaceTypes.length === 0 ||
    value.supportedSurfaceTypes.some(
      (candidate) =>
        !presentationWidgetSurfaceTypes.includes(candidate as PresentationWidgetSurfaceType),
    ) ||
    new Set(value.supportedSurfaceTypes).size !== value.supportedSurfaceTypes.length ||
    JSON.stringify(value.supportedSurfaceTypes) !==
      JSON.stringify(
        presentationWidgetSurfaceTypes.filter((candidate) =>
          (value.supportedSurfaceTypes as readonly unknown[]).includes(candidate),
        ),
      ) ||
    !Array.isArray(value.supportedBreakpointVariants) ||
    JSON.stringify(value.supportedBreakpointVariants) !==
      JSON.stringify(presentationWidgetBreakpointVariants) ||
    !Array.isArray(value.supportedStates) ||
    JSON.stringify(value.supportedStates) !== JSON.stringify(presentationWidgetStates) ||
    typeof value.fullWidthEligible !== "boolean" ||
    typeof value.showMoreEligible !== "boolean" ||
    typeof value.inlineMutationEligible !== "boolean" ||
    !validInternalRoute(value.fullScreenRoute) ||
    !isRecord(value.layoutConstraints) ||
    !exactKeys(value.layoutConstraints, ["desktop", "phone", "tablet"]) ||
    !validLayoutConstraint(value.layoutConstraints.desktop, 12) ||
    !validLayoutConstraint(value.layoutConstraints.tablet, 8) ||
    !validLayoutConstraint(value.layoutConstraints.phone, 4) ||
    !isRecord(value.configurationSchema) ||
    !isJsonValue(value.configurationSchema) ||
    value.cachePolicy !== "no_store" ||
    value.refreshPolicy !== "manual" ||
    !uniqueStringArray(value.evidenceRequirements, {
      allowEmpty: false,
      identifierOnly: true,
    }) ||
    value.billingTreatment !== "non_billable" ||
    value.privacyClassification !== "confidential" ||
    !uniqueStringArray(value.proofRequirementIds, {
      allowEmpty: false,
      identifierOnly: false,
    }) ||
    !isRecord(value.migration) ||
    !exactKeys(value.migration, ["compatibleFrom", "compatibleThrough", "id"]) ||
    !identifier(value.migration.id) ||
    !safeInteger(value.migration.compatibleFrom, 1, 2_147_483_647) ||
    !safeInteger(value.migration.compatibleThrough, 1, 2_147_483_647) ||
    value.migration.compatibleFrom > value.definitionVersion ||
    value.migration.compatibleThrough < value.definitionVersion ||
    !boundedString(value.canonicalHash, 64) ||
    !sha256Pattern.test(value.canonicalHash)
  ) {
    throw new Error("Invalid presentation widget definition");
  }
  return value as unknown as PresentationWidgetDefinition;
}

export function validatePresentationWidgetRegistry<
  T extends readonly PresentationWidgetDefinition[],
>(registry: T): T {
  if (registry.length === 0 || registry.length > 100) {
    throw new Error("Invalid presentation widget registry");
  }
  const identities = new Set<string>();
  const hashes = new Set<string>();
  let previousIdentity: string | undefined;
  for (const candidate of registry) {
    const definition = parsePresentationWidgetDefinition(candidate);
    const identity = `${definition.id}@${definition.definitionVersion}`;
    if (identities.has(identity) || hashes.has(definition.canonicalHash)) {
      throw new Error("Duplicate presentation widget definition");
    }
    if (previousIdentity !== undefined && compareCodeUnits(previousIdentity, identity) > 0) {
      throw new Error("Invalid presentation widget registry order");
    }
    identities.add(identity);
    hashes.add(definition.canonicalHash);
    previousIdentity = identity;
  }
  return registry;
}

export function getPresentationWidgetDefinition(
  definitionId: string,
  definitionVersion = 1,
): PresentationWidgetDefinition {
  const definition = PRESENTATION_WIDGET_DEFINITIONS.find(
    (candidate) =>
      candidate.id === definitionId && candidate.definitionVersion === definitionVersion,
  );
  if (!definition) throw new Error("Unknown presentation widget definition");
  return parsePresentationWidgetDefinition(definition);
}
