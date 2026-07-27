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
  readonly fullScreenRoute: string;
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
  readonly privacyClassification: "tenant_confidential";
  readonly proofRequirementIds: readonly string[];
  readonly readModelId: string;
  readonly refreshPolicy: "manual";
  readonly requiredCapabilityIds: readonly string[];
  readonly semanticIcon: PresentationSemanticIconKey;
  readonly showMoreEligible: boolean;
  readonly sourceServiceGroup: string;
  readonly sourceServiceKey: string;
  readonly supportedBreakpointVariants: readonly ("desktop" | "phone" | "tablet")[];
  readonly supportedStates: readonly PresentationWidgetState[];
  readonly supportedSurfaceTypes: readonly ("mission_control" | "service_group_mission_control")[];
}

export interface PresentationWidgetLayoutConstraint {
  readonly maximumColumnSpan: number;
  readonly maximumRowSpan: number;
  readonly minimumColumnSpan: number;
  readonly minimumRowSpan: number;
}

export type PresentationWidgetDefinitionWithoutHash = Omit<
  PresentationWidgetDefinition,
  "canonicalHash"
>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function canonicalizePresentationWidgetDefinition(
  definition: PresentationWidgetDefinitionWithoutHash,
): string {
  return JSON.stringify(canonicalValue(definition));
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
  displayName: "My leave",
  eligibilityPolicyId: "hr.leave.my-requests.eligible.v1",
  evidenceRequirements: ["current_authorization", "current_service_activation"],
  fullScreenRoute: "/workspace/hr/leave/[leaveRequestId]",
  id: "hr.leave.my-requests",
  inlineMutationEligible: false,
  layoutConstraints: {
    desktop: {
      maximumColumnSpan: 12,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
    },
    phone: {
      maximumColumnSpan: 4,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
    },
    tablet: {
      maximumColumnSpan: 8,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
    },
  },
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.leave.my-requests.v1",
  },
  privacyClassification: "tenant_confidential",
  proofRequirementIds: ["ZEN-WIDGET-001", "ZEN-WIDGET-002", "ZEN-FULL-001", "ZEN-SEC-001"],
  readModelId: "hr.leave.own_requests.v1",
  refreshPolicy: "manual",
  requiredCapabilityIds: ["hr.leave.list_own", "hr.leave.view"],
  semanticIcon: "calendar-check",
  showMoreEligible: true,
  sourceServiceGroup: "hr",
  sourceServiceKey: "hr.leave_request",
  supportedBreakpointVariants: ["desktop", "tablet", "phone"],
  supportedStates: presentationWidgetStates,
  supportedSurfaceTypes: ["mission_control", "service_group_mission_control"],
} as const satisfies PresentationWidgetDefinitionWithoutHash;

export const HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION = Object.freeze({
  ...HR_LEAVE_MY_REQUESTS_MANIFEST,
  canonicalHash: "2f3b5ac4d9196da275d6837b8fae40485c28bce9900a9ae58bae7e2fda5c8e22",
}) satisfies PresentationWidgetDefinition;

export const PRESENTATION_WIDGET_DEFINITIONS = Object.freeze([
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
]) satisfies readonly PresentationWidgetDefinition[];

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function parsePresentationWidgetDefinition(value: unknown): PresentationWidgetDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid presentation widget definition");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(record, [
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
    ]) ||
    record.id !== "hr.leave.my-requests" ||
    record.definitionVersion !== 1 ||
    record.activationServiceKey !== "hr.leave_request" ||
    record.sourceServiceKey !== "hr.leave_request" ||
    record.sourceServiceGroup !== "hr" ||
    record.eligibilityPolicyId !== "hr.leave.my-requests.eligible.v1" ||
    record.billingTreatment !== "non_billable" ||
    record.privacyClassification !== "tenant_confidential" ||
    record.cachePolicy !== "no_store" ||
    record.refreshPolicy !== "manual" ||
    !isPresentationSemanticIconKey(record.semanticIcon) ||
    typeof record.canonicalHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.canonicalHash) ||
    !Array.isArray(record.allowedCommandIds) ||
    record.allowedCommandIds.length !== 0 ||
    JSON.stringify(record.requiredCapabilityIds) !==
      JSON.stringify(["hr.leave.list_own", "hr.leave.view"]) ||
    JSON.stringify(record.supportedStates) !== JSON.stringify(presentationWidgetStates) ||
    typeof record.configurationSchema !== "object" ||
    record.configurationSchema === null ||
    typeof record.layoutConstraints !== "object" ||
    record.layoutConstraints === null ||
    typeof record.migration !== "object" ||
    record.migration === null
  ) {
    throw new Error("Invalid presentation widget definition");
  }
  return value as PresentationWidgetDefinition;
}

export function getPresentationWidgetDefinition(
  definitionId: string,
): PresentationWidgetDefinition {
  const definition = PRESENTATION_WIDGET_DEFINITIONS.find(
    (candidate) => candidate.id === definitionId,
  );
  if (!definition) throw new Error("Unknown presentation widget definition");
  return parsePresentationWidgetDefinition(definition);
}
