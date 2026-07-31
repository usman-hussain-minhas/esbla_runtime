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
  readonly activationPolicy: "any_provider" | "exact_service";
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
  readonly providerEligibility: readonly PresentationWidgetProviderEligibility[];
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

export interface PresentationWidgetProviderEligibility {
  readonly activationServiceKey: string;
  readonly requiredCapabilityIds: readonly string[];
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

function validProviderEligibility(
  value: unknown,
): value is readonly PresentationWidgetProviderEligibility[] {
  if (!Array.isArray(value) || value.length > 20) return false;
  const serviceKeys = new Set<string>();
  for (const provider of value) {
    if (
      !isRecord(provider) ||
      !exactKeys(provider, ["activationServiceKey", "requiredCapabilityIds"]) ||
      !identifier(provider.activationServiceKey) ||
      serviceKeys.has(provider.activationServiceKey) ||
      !uniqueStringArray(provider.requiredCapabilityIds, {
        allowEmpty: false,
        identifierOnly: true,
      })
    ) {
      return false;
    }
    serviceKeys.add(provider.activationServiceKey);
  }
  return true;
}

const COMMON_WIDGET_MANIFEST = {
  billingTreatment: "non_billable",
  cachePolicy: "no_store",
  configurationSchema: {
    additionalProperties: false,
    properties: {},
    type: "object",
  },
  eligibilityPolicyId: "current_tenant_activation_and_capability_v1",
  evidenceRequirements: ["current_authorization", "current_service_activation"],
  fullWidthEligible: true,
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
  privacyClassification: "confidential",
  proofRequirementIds: ["ZEN-WIDGET-001", "ZEN-WIDGET-002", "ZEN-FULL-001", "ZEN-SEC-001"],
  refreshPolicy: "manual",
  showMoreEligible: true,
  supportedBreakpointVariants: presentationWidgetBreakpointVariants,
  supportedStates: presentationWidgetStates,
  supportedSurfaceTypes: presentationWidgetSurfaceTypes,
} as const;

const HR_ATTENDANCE_MY_OBSERVATIONS_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "attendance",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "My Attendance Observations",
  fullScreenRoute: "/workspace/hr/attendance",
  id: "hr.attendance.my-observations",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.attendance.my-observations.v1",
  },
  providerEligibility: [],
  readModelId: "hr.attendance.my-observations.read.v1",
  requiredCapabilityIds: ["hr.attendance.list_own", "hr.attendance.view_detail"],
  semanticIcon: "clock-3",
  sourceServiceGroup: "hr",
  sourceServiceKey: "attendance",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_ATTENDANCE_CORRECTION_QUEUE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "attendance",
  allowedCommandIds: ["hr.attendance.record_manual", "hr.attendance.correct"],
  definitionVersion: 1,
  displayName: "Attendance Correction Queue",
  fullScreenRoute: "/workspace/hr/attendance/reports",
  id: "hr.attendance.correction-queue",
  inlineMutationEligible: true,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.attendance.correction-queue.v1",
  },
  providerEligibility: [],
  readModelId: "hr.attendance.correction-queue.read.v1",
  requiredCapabilityIds: [
    "hr.attendance.list_reports",
    "hr.attendance.view_detail",
    "hr.attendance.record_manual",
    "hr.attendance.correct",
  ],
  semanticIcon: "clock-3",
  sourceServiceGroup: "hr",
  sourceServiceKey: "attendance",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_ATTENDANCE_REPORTS_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "attendance",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Attendance Reports",
  fullScreenRoute: "/workspace/hr/attendance/reports",
  id: "hr.attendance.reports",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.attendance.reports.v1",
  },
  providerEligibility: [],
  readModelId: "hr.attendance.reports.read.v1",
  requiredCapabilityIds: ["hr.attendance.list_reports", "hr.attendance.view_detail"],
  semanticIcon: "clock-3",
  sourceServiceGroup: "hr",
  sourceServiceKey: "attendance",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_EMPLOYMENT_CURRENT_FACTS_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "employment_record",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Current Employment Facts",
  fullScreenRoute: "/workspace/hr/employment",
  id: "hr.employment.current-facts",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.employment.current-facts.v1",
  },
  providerEligibility: [],
  readModelId: "hr.employment.current-facts.read.v1",
  requiredCapabilityIds: ["hr.employment.list_authorized", "hr.employment.view_detail"],
  semanticIcon: "briefcase-business",
  sourceServiceGroup: "hr",
  sourceServiceKey: "employment_record",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_EMPLOYMENT_ADMIN_QUEUE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "employment_record",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Employment Administration Queue",
  fullScreenRoute: "/workspace/hr/employment/admin",
  id: "hr.employment.admin-queue",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.employment.admin-queue.v1",
  },
  providerEligibility: [],
  readModelId: "hr.employment.admin-queue.read.v1",
  requiredCapabilityIds: [
    "hr.employment.create_record",
    "hr.employment.list_authorized",
    "hr.employment.view_detail",
  ],
  semanticIcon: "briefcase-business",
  sourceServiceGroup: "hr",
  sourceServiceKey: "employment_record",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_EMPLOYMENT_HISTORY_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "employment_record",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Employment History",
  fullScreenRoute: "/workspace/hr/employment",
  id: "hr.employment.history",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.employment.history.v1",
  },
  providerEligibility: [],
  readModelId: "hr.employment.history.read.v1",
  requiredCapabilityIds: ["hr.employment.list_authorized", "hr.employment.view_detail"],
  semanticIcon: "briefcase-business",
  sourceServiceGroup: "hr",
  sourceServiceKey: "employment_record",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_EXPENSE_ASSIGNED_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "expense_claim_boundary",
  allowedCommandIds: ["hr.expense.approve", "hr.expense.reject"],
  definitionVersion: 1,
  displayName: "Assigned Expense Claims",
  fullScreenRoute: "/workspace/my-work",
  id: "hr.expense.assigned",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.expense.assigned.v1",
  },
  providerEligibility: [],
  readModelId: "hr.expense.assigned.read.v1",
  requiredCapabilityIds: ["hr.expense.list_assigned", "hr.expense.view_detail"],
  semanticIcon: "receipt-text",
  sourceServiceGroup: "hr",
  sourceServiceKey: "expense_claim_boundary",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_EXPENSE_CORRECTIONS_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "expense_claim_boundary",
  allowedCommandIds: ["hr.expense.create_correction"],
  definitionVersion: 1,
  displayName: "Expense Claim Corrections",
  fullScreenRoute: "/workspace/hr/expenses",
  id: "hr.expense.corrections",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.expense.corrections.v1",
  },
  providerEligibility: [],
  readModelId: "hr.expense.corrections.read.v1",
  requiredCapabilityIds: [
    "hr.expense.list_own",
    "hr.expense.view_detail",
    "hr.expense.create_correction",
  ],
  semanticIcon: "receipt-text",
  sourceServiceGroup: "hr",
  sourceServiceKey: "expense_claim_boundary",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_EXPENSE_DRAFT_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "expense_claim_boundary",
  allowedCommandIds: ["hr.expense.create", "hr.expense.edit_draft", "hr.expense.submit"],
  definitionVersion: 1,
  displayName: "Expense Claim Draft",
  fullScreenRoute: "/workspace/hr/expenses",
  id: "hr.expense.draft",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.expense.draft.v1",
  },
  providerEligibility: [],
  readModelId: "hr.expense.draft.read.v1",
  requiredCapabilityIds: [
    "hr.expense.list_own",
    "hr.expense.view_detail",
    "hr.expense.create",
    "hr.expense.edit_draft",
    "hr.expense.submit",
  ],
  semanticIcon: "receipt-text",
  showMoreEligible: false,
  sourceServiceGroup: "hr",
  sourceServiceKey: "expense_claim_boundary",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_EXPENSE_MINE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "expense_claim_boundary",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "My Expense Claims",
  fullScreenRoute: "/workspace/hr/expenses",
  id: "hr.expense.mine",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.expense.mine.v1",
  },
  providerEligibility: [],
  readModelId: "hr.expense.mine.read.v1",
  requiredCapabilityIds: ["hr.expense.list_own", "hr.expense.view_detail"],
  semanticIcon: "receipt-text",
  sourceServiceGroup: "hr",
  sourceServiceKey: "expense_claim",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_LEAVE_MY_REQUESTS_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "hr.leave_request",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "My Leave Requests",
  fullScreenRoute: "/workspace/hr/leave",
  id: "hr.leave.my-requests",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.leave.my-requests.v1",
  },
  providerEligibility: [],
  readModelId: "hr.leave.my-requests.read.v1",
  requiredCapabilityIds: ["hr.leave.list_own", "hr.leave.view"],
  semanticIcon: "calendar-check",
  sourceServiceGroup: "hr",
  sourceServiceKey: "leave_request",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_LEAVE_ASSIGNED_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "hr.leave_request",
  allowedCommandIds: ["hr.leave.approve", "hr.leave.reject"],
  definitionVersion: 1,
  displayName: "Assigned Leave Approvals",
  fullScreenRoute: "/workspace/my-work",
  id: "hr.leave.assigned",
  inlineMutationEligible: true,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.leave.assigned.v1",
  },
  providerEligibility: [],
  readModelId: "hr.leave.assigned.read.v1",
  requiredCapabilityIds: ["hr.leave.list_assigned", "hr.leave.view"],
  semanticIcon: "calendar-check",
  sourceServiceGroup: "hr",
  sourceServiceKey: "leave_request",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_LEAVE_HISTORY_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "hr.leave_request",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Leave Request History",
  fullScreenRoute: "/workspace/hr/leave",
  id: "hr.leave.history",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.leave.history.v1",
  },
  providerEligibility: [],
  readModelId: "hr.leave.history.read.v1",
  requiredCapabilityIds: ["hr.leave.list_own", "hr.leave.view"],
  semanticIcon: "calendar-check",
  sourceServiceGroup: "hr",
  sourceServiceKey: "leave_request",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_LEAVE_REQUEST_FORM_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "hr.leave_request",
  allowedCommandIds: ["hr.leave.submit"],
  definitionVersion: 1,
  displayName: "Submit Leave Request",
  fullScreenRoute: "/workspace/hr/leave/new",
  id: "hr.leave.request-form",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.leave.request-form.v1",
  },
  providerEligibility: [],
  readModelId: "hr.leave.request-form.read.v1",
  requiredCapabilityIds: ["hr.leave.submit"],
  semanticIcon: "calendar-check",
  showMoreEligible: false,
  sourceServiceGroup: "hr",
  sourceServiceKey: "leave_request",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_SHIFT_MY_PUBLISHED_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "shift_assignment",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "My Published Shifts",
  fullScreenRoute: "/workspace/hr/shifts",
  id: "hr.shift.my-published",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.shift.my-published.v1",
  },
  providerEligibility: [],
  readModelId: "hr.shift.my-published.read.v1",
  requiredCapabilityIds: ["hr.shift.list_roster", "hr.shift.view_detail"],
  semanticIcon: "calendar-range",
  sourceServiceGroup: "hr",
  sourceServiceKey: "shift_assignment",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_SHIFT_PUBLISH_QUEUE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "shift_assignment",
  allowedCommandIds: [
    "hr.shift.create_roster",
    "hr.shift.assign",
    "hr.shift.cancel",
    "hr.shift.publish",
  ],
  definitionVersion: 1,
  displayName: "Roster Publish Queue",
  fullScreenRoute: "/workspace/hr/shifts/reports",
  id: "hr.shift.publish-queue",
  inlineMutationEligible: true,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.shift.publish-queue.v1",
  },
  providerEligibility: [],
  readModelId: "hr.shift.publish-queue.read.v1",
  requiredCapabilityIds: [
    "hr.shift.list_roster",
    "hr.shift.view_detail",
    "hr.shift.create_roster",
    "hr.shift.assign",
    "hr.shift.cancel",
    "hr.shift.publish",
  ],
  semanticIcon: "calendar-range",
  sourceServiceGroup: "hr",
  sourceServiceKey: "shift_assignment",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_SHIFT_ROSTER_OVERVIEW_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "shift_assignment",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Roster Overview",
  fullScreenRoute: "/workspace/hr/shifts/reports",
  id: "hr.shift.roster-overview",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.shift.roster-overview.v1",
  },
  providerEligibility: [],
  readModelId: "hr.shift.roster-overview.read.v1",
  requiredCapabilityIds: ["hr.shift.list_roster", "hr.shift.view_detail"],
  semanticIcon: "calendar-range",
  sourceServiceGroup: "hr",
  sourceServiceKey: "shift_assignment",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_TIMESHEET_MINE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "timesheet",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "My Timesheets",
  fullScreenRoute: "/workspace/hr/timesheets",
  id: "hr.timesheet.mine",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.timesheet.mine.v1",
  },
  providerEligibility: [],
  readModelId: "hr.timesheet.mine.read.v1",
  requiredCapabilityIds: ["hr.timesheet.list_own", "hr.timesheet.view_detail"],
  semanticIcon: "list-checks",
  sourceServiceGroup: "hr",
  sourceServiceKey: "timesheet",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_TIMESHEET_ASSIGNED_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "timesheet",
  allowedCommandIds: ["hr.timesheet.approve", "hr.timesheet.reject"],
  definitionVersion: 1,
  displayName: "Assigned Timesheets",
  fullScreenRoute: "/workspace/my-work",
  id: "hr.timesheet.assigned",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.timesheet.assigned.v1",
  },
  providerEligibility: [],
  readModelId: "hr.timesheet.assigned.read.v1",
  requiredCapabilityIds: ["hr.timesheet.list_assigned", "hr.timesheet.view_detail"],
  semanticIcon: "list-checks",
  sourceServiceGroup: "hr",
  sourceServiceKey: "timesheet",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_TIMESHEET_CORRECTIONS_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "timesheet",
  allowedCommandIds: ["hr.timesheet.create_correction"],
  definitionVersion: 1,
  displayName: "Timesheet Corrections",
  fullScreenRoute: "/workspace/hr/timesheets/admin/corrections",
  id: "hr.timesheet.corrections",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.timesheet.corrections.v1",
  },
  providerEligibility: [],
  readModelId: "hr.timesheet.corrections.read.v1",
  requiredCapabilityIds: ["hr.timesheet.view_detail", "hr.timesheet.create_correction"],
  semanticIcon: "list-checks",
  sourceServiceGroup: "hr",
  sourceServiceKey: "timesheet",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_TIMESHEET_DRAFT_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "timesheet",
  allowedCommandIds: ["hr.timesheet.create", "hr.timesheet.edit_draft", "hr.timesheet.submit"],
  definitionVersion: 1,
  displayName: "Timesheet Draft",
  fullScreenRoute: "/workspace/hr/timesheets",
  id: "hr.timesheet.draft",
  inlineMutationEligible: true,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.timesheet.draft.v1",
  },
  providerEligibility: [],
  readModelId: "hr.timesheet.draft.read.v1",
  requiredCapabilityIds: [
    "hr.timesheet.list_own",
    "hr.timesheet.view_detail",
    "hr.timesheet.create",
    "hr.timesheet.edit_draft",
    "hr.timesheet.submit",
  ],
  semanticIcon: "list-checks",
  showMoreEligible: false,
  sourceServiceGroup: "hr",
  sourceServiceKey: "timesheet",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_WORKFORCE_MY_PROFILE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "workforce_profile",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "My Profile",
  fullScreenRoute: "/workspace/hr/profile",
  id: "hr.workforce.my-profile",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.workforce.my-profile.v1",
  },
  providerEligibility: [],
  readModelId: "hr.workforce.my-profile.read.v1",
  requiredCapabilityIds: ["hr.workforce.view_own", "hr.workforce.view_authorized_detail"],
  semanticIcon: "user-round",
  sourceServiceGroup: "hr",
  sourceServiceKey: "workforce_profile",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_WORKFORCE_DIRECT_REPORTS_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "workforce_profile",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Direct Reports",
  fullScreenRoute: "/workspace/hr/profile/direct-reports",
  id: "hr.workforce.direct-reports",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.workforce.direct-reports.v1",
  },
  providerEligibility: [],
  readModelId: "hr.workforce.direct-reports.read.v1",
  requiredCapabilityIds: ["hr.workforce.list_authorized", "hr.workforce.view_authorized_detail"],
  semanticIcon: "user-round",
  sourceServiceGroup: "hr",
  sourceServiceKey: "workforce_profile",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_WORKFORCE_ADMIN_QUEUE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "workforce_profile",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Workforce Administration Queue",
  fullScreenRoute: "/workspace/hr/profile/admin",
  id: "hr.workforce.admin-queue",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.workforce.admin-queue.v1",
  },
  providerEligibility: [],
  readModelId: "hr.workforce.admin-queue.read.v1",
  requiredCapabilityIds: ["hr.workforce.list_authorized", "hr.workforce.view_authorized_detail"],
  semanticIcon: "users-round",
  sourceServiceGroup: "hr",
  sourceServiceKey: "workforce_profile",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const HR_WORKFORCE_STATUS_REPORTING_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "workforce_profile",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "Workforce Status Reporting",
  fullScreenRoute: "/workspace/hr/profile/admin",
  id: "hr.workforce.status-reporting",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.hr.workforce.status-reporting.v1",
  },
  providerEligibility: [],
  readModelId: "hr.workforce.status-reporting.read.v1",
  requiredCapabilityIds: ["hr.workforce.list_authorized", "hr.workforce.view_authorized_detail"],
  semanticIcon: "users-round",
  sourceServiceGroup: "hr",
  sourceServiceKey: "workforce_profile",
  widgetKind: "detailed",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const WORKSPACE_TASKS_MINE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "exact_service",
  activationServiceKey: "workspace.task",
  allowedCommandIds: [],
  definitionVersion: 1,
  displayName: "My Tasks",
  fullScreenRoute: "/workspace/tasks",
  id: "workspace.tasks.mine",
  inlineMutationEligible: false,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.workspace.tasks.mine.v1",
  },
  providerEligibility: [],
  readModelId: "workspace.tasks.mine.read.v1",
  requiredCapabilityIds: ["workspace.task.list_assigned"],
  semanticIcon: "check-square",
  sourceServiceGroup: "workspace",
  sourceServiceKey: "task",
  widgetKind: "operational",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

const PLATFORM_MY_WORK_QUEUE_MANIFEST = {
  ...COMMON_WIDGET_MANIFEST,
  activationPolicy: "any_provider",
  activationServiceKey: "platform.my_work",
  allowedCommandIds: [
    "hr.leave.approve",
    "hr.leave.reject",
    "hr.timesheet.approve",
    "hr.timesheet.reject",
    "hr.expense.approve",
    "hr.expense.reject",
    "workspace.task.complete",
  ],
  definitionVersion: 1,
  displayName: "My Work",
  fullScreenRoute: "/workspace/my-work",
  id: "platform.my-work.queue",
  inlineMutationEligible: true,
  migration: {
    compatibleFrom: 1,
    compatibleThrough: 1,
    id: "zen.platform.my-work.queue.v1",
  },
  providerEligibility: [
    {
      activationServiceKey: "hr.leave_request",
      requiredCapabilityIds: ["hr.leave.list_assigned", "hr.leave.view"],
    },
    {
      activationServiceKey: "timesheet",
      requiredCapabilityIds: ["hr.timesheet.list_assigned", "hr.timesheet.view_detail"],
    },
    {
      activationServiceKey: "expense_claim_boundary",
      requiredCapabilityIds: ["hr.expense.list_assigned", "hr.expense.view_detail"],
    },
    {
      activationServiceKey: "workspace.task",
      requiredCapabilityIds: ["workspace.task.list_assigned", "workspace.task.view"],
    },
  ],
  readModelId: "platform.my-work.queue.read.v1",
  requiredCapabilityIds: [
    "hr.leave.list_assigned",
    "hr.leave.view",
    "hr.timesheet.list_assigned",
    "hr.timesheet.view_detail",
    "hr.expense.list_assigned",
    "hr.expense.view_detail",
    "workspace.task.list_assigned",
    "workspace.task.view",
  ],
  semanticIcon: "diamond",
  sourceServiceGroup: "platform",
  sourceServiceKey: "my_work",
  widgetKind: "composite",
} as const satisfies PresentationWidgetDefinitionWithoutHash;

export const HR_ATTENDANCE_MY_OBSERVATIONS_WIDGET_DEFINITION = deepFreeze({
  ...HR_ATTENDANCE_MY_OBSERVATIONS_MANIFEST,
  canonicalHash: "93d4acd1c5e9facceaa8b6dc929d513a6832624ad7aef871ed8ff71d3b17cb28",
}) satisfies PresentationWidgetDefinition;

export const HR_ATTENDANCE_CORRECTION_QUEUE_WIDGET_DEFINITION = deepFreeze({
  ...HR_ATTENDANCE_CORRECTION_QUEUE_MANIFEST,
  canonicalHash: "e56e5112ccf79673c0c3616501a6865660c08dddf53ea47609eb01d1a3ce8d89",
}) satisfies PresentationWidgetDefinition;

export const HR_ATTENDANCE_REPORTS_WIDGET_DEFINITION = deepFreeze({
  ...HR_ATTENDANCE_REPORTS_MANIFEST,
  canonicalHash: "71fff7de4cb846eb419f7315243de716faa69fd31f6ec6cf0fd5b8d8a26866f7",
}) satisfies PresentationWidgetDefinition;

export const HR_EMPLOYMENT_CURRENT_FACTS_WIDGET_DEFINITION = deepFreeze({
  ...HR_EMPLOYMENT_CURRENT_FACTS_MANIFEST,
  canonicalHash: "a08e69a049cb21c05cb0337eb0c7b4957ef9f0129ef0f771161c41c6551524a4",
}) satisfies PresentationWidgetDefinition;

export const HR_EMPLOYMENT_ADMIN_QUEUE_WIDGET_DEFINITION = deepFreeze({
  ...HR_EMPLOYMENT_ADMIN_QUEUE_MANIFEST,
  canonicalHash: "cb552a12b4e7f948598e90edd6d6809dc13e39261a693a21b89a29bcfb2eefa2",
}) satisfies PresentationWidgetDefinition;

export const HR_EMPLOYMENT_HISTORY_WIDGET_DEFINITION = deepFreeze({
  ...HR_EMPLOYMENT_HISTORY_MANIFEST,
  canonicalHash: "1f281aab407ca6b459fa2527504c88324cab7d342ea594e99e0d72c494b668e5",
}) satisfies PresentationWidgetDefinition;

export const HR_EXPENSE_MINE_WIDGET_DEFINITION = deepFreeze({
  ...HR_EXPENSE_MINE_MANIFEST,
  canonicalHash: "770fe892c414c43f34fa49c2d81bf45b52d3876e539b4c8fc9b56eea47c9c3b8",
}) satisfies PresentationWidgetDefinition;

export const HR_EXPENSE_ASSIGNED_WIDGET_DEFINITION = deepFreeze({
  ...HR_EXPENSE_ASSIGNED_MANIFEST,
  canonicalHash: "9e0cee5c4af13abdd6a4c3c18f73243bd2ab4a5963de201b48572cf9b85360b9",
}) satisfies PresentationWidgetDefinition;

export const HR_EXPENSE_CORRECTIONS_WIDGET_DEFINITION = deepFreeze({
  ...HR_EXPENSE_CORRECTIONS_MANIFEST,
  canonicalHash: "f3142612a0561a56ee086b81fb95ada0cd43d5cd44ff8ef6a0a704566a269a38",
}) satisfies PresentationWidgetDefinition;

export const HR_EXPENSE_DRAFT_WIDGET_DEFINITION = deepFreeze({
  ...HR_EXPENSE_DRAFT_MANIFEST,
  canonicalHash: "f490503c73952b6d307f68a2195372ac1985b103ef76f2a3df63ff053b64e62c",
}) satisfies PresentationWidgetDefinition;

export const HR_LEAVE_ASSIGNED_WIDGET_DEFINITION = deepFreeze({
  ...HR_LEAVE_ASSIGNED_MANIFEST,
  canonicalHash: "0d2b506961d59ad127561a455ec9ccf7a2f21b720069023a3a333f090eb7bcac",
}) satisfies PresentationWidgetDefinition;

export const HR_LEAVE_HISTORY_WIDGET_DEFINITION = deepFreeze({
  ...HR_LEAVE_HISTORY_MANIFEST,
  canonicalHash: "13d37b77673875ef2d3e29969a6352f9146faae45aa46cfb1c1bd0ea5bbeb8e0",
}) satisfies PresentationWidgetDefinition;

export const HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION = deepFreeze({
  ...HR_LEAVE_MY_REQUESTS_MANIFEST,
  canonicalHash: "d6b8b157fe091a9b9a5131b9a41b4de0fc1e1fe38fe90fb028001c4b657527b7",
}) satisfies PresentationWidgetDefinition;

export const HR_LEAVE_REQUEST_FORM_WIDGET_DEFINITION = deepFreeze({
  ...HR_LEAVE_REQUEST_FORM_MANIFEST,
  canonicalHash: "b8dfbfd473b6f7fa00e9d0d81adffb56ea2abd7d4f9a9704a373be5ddbd83409",
}) satisfies PresentationWidgetDefinition;

export const HR_SHIFT_MY_PUBLISHED_WIDGET_DEFINITION = deepFreeze({
  ...HR_SHIFT_MY_PUBLISHED_MANIFEST,
  canonicalHash: "4d698d44b10bfaa6e820baffdf973f58bb1724ffdee61ee7e2d4d0c166a26a1d",
}) satisfies PresentationWidgetDefinition;

export const HR_SHIFT_PUBLISH_QUEUE_WIDGET_DEFINITION = deepFreeze({
  ...HR_SHIFT_PUBLISH_QUEUE_MANIFEST,
  canonicalHash: "9b5bf3632fc95f84867a7b4dc2f0f8e84bb193663694b02718a74fc79021a060",
}) satisfies PresentationWidgetDefinition;

export const HR_SHIFT_ROSTER_OVERVIEW_WIDGET_DEFINITION = deepFreeze({
  ...HR_SHIFT_ROSTER_OVERVIEW_MANIFEST,
  canonicalHash: "bc72bacfb9f1b620cc1bc634fabcac01263ca5d270c7d09bacf287ec72ed9fd5",
}) satisfies PresentationWidgetDefinition;

export const HR_TIMESHEET_MINE_WIDGET_DEFINITION = deepFreeze({
  ...HR_TIMESHEET_MINE_MANIFEST,
  canonicalHash: "0694fe179f2b9d065ab03061ee65185ca683ea2e5d14a2e5d733365f639d1cae",
}) satisfies PresentationWidgetDefinition;

export const HR_TIMESHEET_ASSIGNED_WIDGET_DEFINITION = deepFreeze({
  ...HR_TIMESHEET_ASSIGNED_MANIFEST,
  canonicalHash: "f62ac530ae704af58963a19db23bc12b9b7253636a3a8d855c2675cd3380d3f3",
}) satisfies PresentationWidgetDefinition;

export const HR_TIMESHEET_CORRECTIONS_WIDGET_DEFINITION = deepFreeze({
  ...HR_TIMESHEET_CORRECTIONS_MANIFEST,
  canonicalHash: "29beb1cb644180a3398403deb3903132728a43bd58e76bf41f41520e2ba7e04b",
}) satisfies PresentationWidgetDefinition;

export const HR_TIMESHEET_DRAFT_WIDGET_DEFINITION = deepFreeze({
  ...HR_TIMESHEET_DRAFT_MANIFEST,
  canonicalHash: "5ee53eb955b250115b88ac2900e1f400b3ec63bb324e714ab9456eb7bb3dc5cb",
}) satisfies PresentationWidgetDefinition;

export const HR_WORKFORCE_MY_PROFILE_WIDGET_DEFINITION = deepFreeze({
  ...HR_WORKFORCE_MY_PROFILE_MANIFEST,
  canonicalHash: "42bd72ff3eae15f449cb38811e7e26370a309c4083b4e89cba74ceaaf6b05ca5",
}) satisfies PresentationWidgetDefinition;

export const HR_WORKFORCE_DIRECT_REPORTS_WIDGET_DEFINITION = deepFreeze({
  ...HR_WORKFORCE_DIRECT_REPORTS_MANIFEST,
  canonicalHash: "e3494440830fc829aee752b03c0838d80b12d050e2ce21ac8bed2669bbec7cce",
}) satisfies PresentationWidgetDefinition;

export const HR_WORKFORCE_ADMIN_QUEUE_WIDGET_DEFINITION = deepFreeze({
  ...HR_WORKFORCE_ADMIN_QUEUE_MANIFEST,
  canonicalHash: "6f3a275d52531d784f716d1ca145946f050e13f72eb77763e876dc62b6fc677a",
}) satisfies PresentationWidgetDefinition;

export const PLATFORM_MY_WORK_QUEUE_WIDGET_DEFINITION = deepFreeze({
  ...PLATFORM_MY_WORK_QUEUE_MANIFEST,
  canonicalHash: "58870440fb4758c55b78e4ec3dde4037055f3903c5e0bfa4df28bf3851617828",
}) satisfies PresentationWidgetDefinition;

export const HR_WORKFORCE_STATUS_REPORTING_WIDGET_DEFINITION = deepFreeze({
  ...HR_WORKFORCE_STATUS_REPORTING_MANIFEST,
  canonicalHash: "8461490e5757cd6c5abd6b8404b27169ea158590f68aa39d31b36b1ce8b835d9",
}) satisfies PresentationWidgetDefinition;

export const WORKSPACE_TASKS_MINE_WIDGET_DEFINITION = deepFreeze({
  ...WORKSPACE_TASKS_MINE_MANIFEST,
  canonicalHash: "bd611175bd805f80eb2edd161a530e1835576f71f42364efbe863c1f3f1db2cc",
}) satisfies PresentationWidgetDefinition;

export const PRESENTATION_WIDGET_DEFINITIONS = deepFreeze([
  HR_ATTENDANCE_CORRECTION_QUEUE_WIDGET_DEFINITION,
  HR_ATTENDANCE_MY_OBSERVATIONS_WIDGET_DEFINITION,
  HR_ATTENDANCE_REPORTS_WIDGET_DEFINITION,
  HR_EMPLOYMENT_ADMIN_QUEUE_WIDGET_DEFINITION,
  HR_EMPLOYMENT_CURRENT_FACTS_WIDGET_DEFINITION,
  HR_EMPLOYMENT_HISTORY_WIDGET_DEFINITION,
  HR_EXPENSE_ASSIGNED_WIDGET_DEFINITION,
  HR_EXPENSE_CORRECTIONS_WIDGET_DEFINITION,
  HR_EXPENSE_DRAFT_WIDGET_DEFINITION,
  HR_EXPENSE_MINE_WIDGET_DEFINITION,
  HR_LEAVE_ASSIGNED_WIDGET_DEFINITION,
  HR_LEAVE_HISTORY_WIDGET_DEFINITION,
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
  HR_LEAVE_REQUEST_FORM_WIDGET_DEFINITION,
  HR_SHIFT_MY_PUBLISHED_WIDGET_DEFINITION,
  HR_SHIFT_PUBLISH_QUEUE_WIDGET_DEFINITION,
  HR_SHIFT_ROSTER_OVERVIEW_WIDGET_DEFINITION,
  HR_TIMESHEET_ASSIGNED_WIDGET_DEFINITION,
  HR_TIMESHEET_CORRECTIONS_WIDGET_DEFINITION,
  HR_TIMESHEET_DRAFT_WIDGET_DEFINITION,
  HR_TIMESHEET_MINE_WIDGET_DEFINITION,
  HR_WORKFORCE_ADMIN_QUEUE_WIDGET_DEFINITION,
  HR_WORKFORCE_DIRECT_REPORTS_WIDGET_DEFINITION,
  HR_WORKFORCE_MY_PROFILE_WIDGET_DEFINITION,
  HR_WORKFORCE_STATUS_REPORTING_WIDGET_DEFINITION,
  PLATFORM_MY_WORK_QUEUE_WIDGET_DEFINITION,
  WORKSPACE_TASKS_MINE_WIDGET_DEFINITION,
] as const) satisfies readonly PresentationWidgetDefinition[];

export function parsePresentationWidgetDefinition(value: unknown): PresentationWidgetDefinition {
  if (!isRecord(value)) throw new Error("Invalid presentation widget definition");
  const providerEligibility = value.providerEligibility;
  if (
    !exactKeys(value, [
      "activationPolicy",
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
      "providerEligibility",
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
    (value.activationPolicy !== "exact_service" && value.activationPolicy !== "any_provider") ||
    !identifier(value.activationServiceKey) ||
    !identifier(value.readModelId) ||
    !identifier(value.eligibilityPolicyId) ||
    !presentationWidgetKinds.includes(value.widgetKind as PresentationWidgetKind) ||
    !uniqueStringArray(value.allowedCommandIds, { allowEmpty: true, identifierOnly: true }) ||
    !uniqueStringArray(value.requiredCapabilityIds, {
      allowEmpty: false,
      identifierOnly: true,
    }) ||
    !validProviderEligibility(providerEligibility) ||
    (value.activationPolicy === "exact_service" && providerEligibility.length !== 0) ||
    (value.activationPolicy === "any_provider" &&
      (value.widgetKind !== "composite" ||
        providerEligibility.length === 0 ||
        new Set(providerEligibility.flatMap((provider) => provider.requiredCapabilityIds)).size !==
          value.requiredCapabilityIds.length ||
        value.requiredCapabilityIds.some(
          (capabilityId) =>
            !providerEligibility.some((provider) =>
              provider.requiredCapabilityIds.includes(capabilityId),
            ),
        ))) ||
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
