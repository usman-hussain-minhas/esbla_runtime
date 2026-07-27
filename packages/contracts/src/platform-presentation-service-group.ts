import type { PresentationSemanticIconKey } from "./platform-presentation-widget.js";

export const presentationServiceGroupIds = ["hr"] as const;
export type PresentationServiceGroupId = (typeof presentationServiceGroupIds)[number];

export interface PresentationServiceEligibilityRule {
  readonly activationServiceKey: string;
  readonly anyReadCapabilityIds: readonly string[];
}

export interface PresentationServiceGroupDefinition {
  readonly href: string;
  readonly semanticIcon: PresentationSemanticIconKey;
  readonly serviceGroupId: PresentationServiceGroupId;
  readonly services: readonly PresentationServiceEligibilityRule[];
}

const HR_SERVICE_ELIGIBILITY = Object.freeze([
  Object.freeze({
    activationServiceKey: "workforce_profile",
    anyReadCapabilityIds: Object.freeze([
      "hr.workforce.list_authorized",
      "hr.workforce.view_authorized_detail",
      "hr.workforce.view_own",
      "hr.workforce.view_service_control",
    ]),
  }),
  Object.freeze({
    activationServiceKey: "employment_record",
    anyReadCapabilityIds: Object.freeze([
      "hr.employment.list_authorized",
      "hr.employment.view_detail",
      "hr.employment.view_service_control",
    ]),
  }),
  Object.freeze({
    activationServiceKey: "shift_assignment",
    anyReadCapabilityIds: Object.freeze([
      "hr.shift.list_roster",
      "hr.shift.view_detail",
      "hr.shift.view_service_control",
    ]),
  }),
  Object.freeze({
    activationServiceKey: "attendance",
    anyReadCapabilityIds: Object.freeze([
      "hr.attendance.list_own",
      "hr.attendance.list_reports",
      "hr.attendance.view_detail",
      "hr.attendance.view_service_control",
    ]),
  }),
  Object.freeze({
    activationServiceKey: "hr.leave_request",
    anyReadCapabilityIds: Object.freeze([
      "hr.leave.list_assigned",
      "hr.leave.list_own",
      "hr.leave.view",
    ]),
  }),
  Object.freeze({
    activationServiceKey: "timesheet",
    anyReadCapabilityIds: Object.freeze([
      "hr.timesheet.list_assigned",
      "hr.timesheet.list_own",
      "hr.timesheet.view_detail",
      "hr.timesheet.view_service_control",
    ]),
  }),
  Object.freeze({
    activationServiceKey: "expense_claim_boundary",
    anyReadCapabilityIds: Object.freeze([
      "hr.expense.list_assigned",
      "hr.expense.list_own",
      "hr.expense.view_detail",
      "hr.expense.view_service_control",
    ]),
  }),
]) satisfies readonly PresentationServiceEligibilityRule[];

export const PRESENTATION_SERVICE_GROUP_DEFINITIONS = Object.freeze([
  Object.freeze({
    href: "/workspace/hr",
    semanticIcon: "users-round",
    serviceGroupId: "hr",
    services: HR_SERVICE_ELIGIBILITY,
  }),
]) satisfies readonly PresentationServiceGroupDefinition[];

export interface PresentationServiceGroupDiscovery {
  readonly serviceGroupIds: readonly PresentationServiceGroupId[];
}

export const presentationServiceGroupDiscoverySchema = {
  $id: "PresentationServiceGroupDiscoveryV1",
  additionalProperties: false,
  properties: {
    serviceGroupIds: {
      items: { enum: presentationServiceGroupIds },
      maxItems: presentationServiceGroupIds.length,
      type: "array",
      uniqueItems: true,
    },
  },
  required: ["serviceGroupIds"],
  type: "object",
} as const;

export function getPresentationServiceGroupDefinition(
  serviceGroupId: PresentationServiceGroupId,
): PresentationServiceGroupDefinition {
  const definition = PRESENTATION_SERVICE_GROUP_DEFINITIONS.find(
    (candidate) => candidate.serviceGroupId === serviceGroupId,
  );
  if (!definition) throw new Error("Unknown presentation service group");
  return definition;
}

export function parsePresentationServiceGroupDiscovery(
  value: unknown,
): PresentationServiceGroupDiscovery {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["serviceGroupIds"])
  ) {
    throw new Error("Invalid presentation service-group discovery");
  }
  const record = value as Record<string, unknown>;
  const serviceGroupIds = record.serviceGroupIds;
  if (
    !Array.isArray(serviceGroupIds) ||
    serviceGroupIds.some(
      (candidate) =>
        typeof candidate !== "string" ||
        !presentationServiceGroupIds.includes(candidate as PresentationServiceGroupId),
    )
  ) {
    throw new Error("Invalid presentation service-group discovery");
  }
  const canonical = presentationServiceGroupIds.filter((serviceGroupId) =>
    serviceGroupIds.includes(serviceGroupId),
  );
  if (JSON.stringify(serviceGroupIds) !== JSON.stringify(canonical)) {
    throw new Error("Invalid presentation service-group discovery");
  }
  return { serviceGroupIds: canonical };
}
