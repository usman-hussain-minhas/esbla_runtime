import type { PresentationSemanticIconKey } from "./platform-presentation-widget.js";

export const presentationServiceGroupIds = ["hr"] as const;
export type PresentationServiceGroupId = (typeof presentationServiceGroupIds)[number];

export const presentationServiceIds = [
  "workforce_profile",
  "employment_record",
  "shift_assignment",
  "attendance",
  "leave_request",
  "timesheet",
  "expense_claim",
] as const;
export type PresentationServiceId = (typeof presentationServiceIds)[number];

export const presentationNavigationDestinationIds = [
  "hr.workforce.own",
  "hr.workforce.direct_reports",
  "hr.workforce.admin",
  "hr.workforce.settings",
  "hr.employment.records",
  "hr.employment.admin",
  "hr.employment.settings",
  "hr.shift.own",
  "hr.shift.reports",
  "hr.shift.settings",
  "hr.attendance.own",
  "hr.attendance.reports",
  "hr.attendance.settings",
  "hr.leave.own",
  "hr.timesheet.own",
  "hr.timesheet.corrections",
  "hr.timesheet.settings",
  "hr.expense.own",
  "hr.expense.settings",
] as const;
export type PresentationNavigationDestinationId =
  (typeof presentationNavigationDestinationIds)[number];

export type PresentationDestinationExposure = "action_only" | "surface" | "widget_route";

export interface PresentationNavigationDestinationDefinition {
  readonly allowedRoleKeys: readonly string[];
  readonly anyCapabilityIds: readonly string[];
  readonly destinationId: PresentationNavigationDestinationId;
  readonly exposure: Exclude<PresentationDestinationExposure, "surface">;
  readonly href: string;
  readonly label: string;
  readonly semanticIcon: PresentationSemanticIconKey;
}

export interface PresentationServiceEligibilityRule {
  readonly activationServiceKey: string;
  readonly additionalVisibilityRules?: readonly PresentationNavigationEligibilityRule[];
  readonly destinations: readonly PresentationNavigationDestinationDefinition[];
  readonly serviceId: PresentationServiceId;
}

export interface PresentationNavigationEligibilityRule {
  readonly allowedRoleKeys: readonly string[];
  readonly anyCapabilityIds: readonly string[];
}

export interface PresentationServiceGroupDefinition {
  readonly href: string;
  readonly label: string;
  readonly semanticIcon: PresentationSemanticIconKey;
  readonly serviceGroupId: PresentationServiceGroupId;
  readonly services: readonly PresentationServiceEligibilityRule[];
}

const HR_SERVICE_ELIGIBILITY = Object.freeze([
  Object.freeze({
    activationServiceKey: "workforce_profile",
    destinations: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["employee"]),
        anyCapabilityIds: Object.freeze(["hr.workforce.view_own"]),
        destinationId: "hr.workforce.own",
        exposure: "widget_route",
        href: "/workspace/hr/profile",
        label: "My Workforce Profile",
        semanticIcon: "user-round",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["manager"]),
        anyCapabilityIds: Object.freeze(["hr.workforce.list_authorized"]),
        destinationId: "hr.workforce.direct_reports",
        exposure: "widget_route",
        href: "/workspace/hr/profile/direct-reports",
        label: "Direct Reports",
        semanticIcon: "users-round",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["hr_operator"]),
        anyCapabilityIds: Object.freeze([
          "hr.workforce.change_reporting_relationship",
          "hr.workforce.change_status",
          "hr.workforce.create_profile",
          "hr.workforce.link_principal",
          "hr.workforce.list_authorized",
        ]),
        destinationId: "hr.workforce.admin",
        exposure: "widget_route",
        href: "/workspace/hr/profile/admin",
        label: "Workforce Administration",
        semanticIcon: "users-round",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["tenant_admin"]),
        anyCapabilityIds: Object.freeze(["hr.workforce.view_service_control"]),
        destinationId: "hr.workforce.settings",
        exposure: "action_only",
        href: "/workspace/hr/profile/settings",
        label: "Workforce Settings",
        semanticIcon: "settings",
      }),
    ]),
    serviceId: "workforce_profile",
  }),
  Object.freeze({
    activationServiceKey: "employment_record",
    destinations: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["employee", "hr_operator"]),
        anyCapabilityIds: Object.freeze(["hr.employment.list_authorized"]),
        destinationId: "hr.employment.records",
        exposure: "widget_route",
        href: "/workspace/hr/employment",
        label: "Employment Records",
        semanticIcon: "briefcase-business",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["hr_operator"]),
        anyCapabilityIds: Object.freeze([
          "hr.employment.create_record",
          "hr.employment.create_version",
          "hr.employment.end_record",
        ]),
        destinationId: "hr.employment.admin",
        exposure: "widget_route",
        href: "/workspace/hr/employment/admin",
        label: "Employment Administration",
        semanticIcon: "briefcase-business",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["tenant_admin"]),
        anyCapabilityIds: Object.freeze(["hr.employment.view_service_control"]),
        destinationId: "hr.employment.settings",
        exposure: "action_only",
        href: "/workspace/hr/employment/settings",
        label: "Employment Settings",
        semanticIcon: "settings",
      }),
    ]),
    serviceId: "employment_record",
  }),
  Object.freeze({
    activationServiceKey: "shift_assignment",
    destinations: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["employee"]),
        anyCapabilityIds: Object.freeze(["hr.shift.list_roster"]),
        destinationId: "hr.shift.own",
        exposure: "widget_route",
        href: "/workspace/hr/shifts",
        label: "My Shifts",
        semanticIcon: "calendar-range",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["hr_operator", "manager"]),
        anyCapabilityIds: Object.freeze(["hr.shift.list_roster"]),
        destinationId: "hr.shift.reports",
        exposure: "widget_route",
        href: "/workspace/hr/shifts/reports",
        label: "Shift Rosters",
        semanticIcon: "calendar-range",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["tenant_admin"]),
        anyCapabilityIds: Object.freeze(["hr.shift.view_service_control"]),
        destinationId: "hr.shift.settings",
        exposure: "action_only",
        href: "/workspace/hr/shifts/settings",
        label: "Shift Settings",
        semanticIcon: "settings",
      }),
    ]),
    serviceId: "shift_assignment",
  }),
  Object.freeze({
    activationServiceKey: "attendance",
    destinations: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["employee"]),
        anyCapabilityIds: Object.freeze(["hr.attendance.list_own"]),
        destinationId: "hr.attendance.own",
        exposure: "widget_route",
        href: "/workspace/hr/attendance",
        label: "My Attendance",
        semanticIcon: "clock-3",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["hr_operator", "manager"]),
        anyCapabilityIds: Object.freeze(["hr.attendance.list_reports"]),
        destinationId: "hr.attendance.reports",
        exposure: "widget_route",
        href: "/workspace/hr/attendance/reports",
        label: "Attendance Reports",
        semanticIcon: "clock-3",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["tenant_admin"]),
        anyCapabilityIds: Object.freeze(["hr.attendance.view_service_control"]),
        destinationId: "hr.attendance.settings",
        exposure: "action_only",
        href: "/workspace/hr/attendance/settings",
        label: "Attendance Settings",
        semanticIcon: "settings",
      }),
    ]),
    serviceId: "attendance",
  }),
  Object.freeze({
    additionalVisibilityRules: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["manager"]),
        anyCapabilityIds: Object.freeze(["hr.leave.list_assigned"]),
      }),
    ]),
    activationServiceKey: "hr.leave_request",
    destinations: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["employee"]),
        anyCapabilityIds: Object.freeze(["hr.leave.list_own"]),
        destinationId: "hr.leave.own",
        exposure: "widget_route",
        href: "/workspace/hr/leave",
        label: "Leave Requests",
        semanticIcon: "calendar-check",
      }),
    ]),
    serviceId: "leave_request",
  }),
  Object.freeze({
    additionalVisibilityRules: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["manager"]),
        anyCapabilityIds: Object.freeze(["hr.timesheet.list_assigned"]),
      }),
    ]),
    activationServiceKey: "timesheet",
    destinations: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["employee"]),
        anyCapabilityIds: Object.freeze(["hr.timesheet.list_own"]),
        destinationId: "hr.timesheet.own",
        exposure: "widget_route",
        href: "/workspace/hr/timesheets",
        label: "My Timesheets",
        semanticIcon: "list-checks",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["hr_operator"]),
        anyCapabilityIds: Object.freeze(["hr.timesheet.create_correction"]),
        destinationId: "hr.timesheet.corrections",
        exposure: "widget_route",
        href: "/workspace/hr/timesheets/admin/corrections",
        label: "Timesheet Corrections",
        semanticIcon: "list-checks",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["tenant_admin"]),
        anyCapabilityIds: Object.freeze(["hr.timesheet.view_service_control"]),
        destinationId: "hr.timesheet.settings",
        exposure: "action_only",
        href: "/workspace/hr/timesheets/settings",
        label: "Timesheet Settings",
        semanticIcon: "settings",
      }),
    ]),
    serviceId: "timesheet",
  }),
  Object.freeze({
    additionalVisibilityRules: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["manager"]),
        anyCapabilityIds: Object.freeze(["hr.expense.list_assigned"]),
      }),
    ]),
    activationServiceKey: "expense_claim_boundary",
    destinations: Object.freeze([
      Object.freeze({
        allowedRoleKeys: Object.freeze(["employee"]),
        anyCapabilityIds: Object.freeze(["hr.expense.list_own"]),
        destinationId: "hr.expense.own",
        exposure: "widget_route",
        href: "/workspace/hr/expenses",
        label: "My Expense Claims",
        semanticIcon: "receipt-text",
      }),
      Object.freeze({
        allowedRoleKeys: Object.freeze(["tenant_admin"]),
        anyCapabilityIds: Object.freeze(["hr.expense.view_service_control"]),
        destinationId: "hr.expense.settings",
        exposure: "action_only",
        href: "/workspace/hr/expenses/settings",
        label: "Expense Settings",
        semanticIcon: "settings",
      }),
    ]),
    serviceId: "expense_claim",
  }),
]) satisfies readonly PresentationServiceEligibilityRule[];

export const PRESENTATION_SERVICE_GROUP_DEFINITIONS = Object.freeze([
  Object.freeze({
    href: "/workspace/hr",
    label: "HR",
    semanticIcon: "users-round",
    serviceGroupId: "hr",
    services: HR_SERVICE_ELIGIBILITY,
  }),
]) satisfies readonly PresentationServiceGroupDefinition[];

export const presentationRouteOnlyDestinationIds = [
  "hr.leave.create",
  "platform.my-work",
  "workspace.tasks",
] as const;
export type PresentationRouteOnlyDestinationId =
  (typeof presentationRouteOnlyDestinationIds)[number];

export interface PresentationRouteOnlyDestinationDefinition {
  readonly destinationId: PresentationRouteOnlyDestinationId;
  readonly exposure: "widget_route";
  readonly href: string;
}

export const PRESENTATION_ROUTE_ONLY_DESTINATION_DEFINITIONS = Object.freeze([
  Object.freeze({
    destinationId: "hr.leave.create",
    exposure: "widget_route",
    href: "/workspace/hr/leave/new",
  }),
  Object.freeze({
    destinationId: "platform.my-work",
    exposure: "widget_route",
    href: "/workspace/my-work",
  }),
  Object.freeze({
    destinationId: "workspace.tasks",
    exposure: "widget_route",
    href: "/workspace/tasks",
  }),
] as const) satisfies readonly PresentationRouteOnlyDestinationDefinition[];

export type PresentationDeepRouteDefinition =
  | PresentationNavigationDestinationDefinition
  | PresentationRouteOnlyDestinationDefinition;

function serviceNavigationDestinations(): PresentationNavigationDestinationDefinition[] {
  const destinations: PresentationNavigationDestinationDefinition[] = [];
  for (const group of PRESENTATION_SERVICE_GROUP_DEFINITIONS) {
    for (const service of group.services) destinations.push(...service.destinations);
  }
  return destinations;
}

export const PRESENTATION_DEEP_ROUTE_DEFINITIONS = Object.freeze([
  ...serviceNavigationDestinations(),
  ...PRESENTATION_ROUTE_ONLY_DESTINATION_DEFINITIONS,
]) satisfies readonly PresentationDeepRouteDefinition[];

export interface PresentationServiceGroupDiscovery {
  readonly serviceGroupIds: readonly PresentationServiceGroupId[];
}

export interface PresentationNavigationServiceGroup {
  readonly destinationIds: readonly PresentationNavigationDestinationId[];
  readonly serviceGroupId: PresentationServiceGroupId;
}

export interface PresentationNavigationDiscovery {
  readonly serviceGroups: readonly PresentationNavigationServiceGroup[];
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

export const presentationNavigationDiscoverySchema = {
  $id: "PresentationNavigationDiscoveryV1",
  additionalProperties: false,
  properties: {
    serviceGroups: {
      items: {
        additionalProperties: false,
        properties: {
          serviceGroupId: { enum: presentationServiceGroupIds },
          destinationIds: {
            items: { enum: presentationNavigationDestinationIds },
            maxItems: presentationNavigationDestinationIds.length,
            type: "array",
            uniqueItems: true,
          },
        },
        required: ["destinationIds", "serviceGroupId"],
        type: "object",
      },
      maxItems: presentationServiceGroupIds.length,
      type: "array",
      uniqueItems: true,
    },
  },
  required: ["serviceGroups"],
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

export function parsePresentationNavigationDiscovery(
  value: unknown,
): PresentationNavigationDiscovery {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["serviceGroups"])
  ) {
    throw new Error("Invalid presentation navigation discovery");
  }
  const groups = (value as Record<string, unknown>).serviceGroups;
  if (!Array.isArray(groups)) throw new Error("Invalid presentation navigation discovery");
  const parsed: PresentationNavigationServiceGroup[] = [];
  for (const candidate of groups) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      JSON.stringify(Object.keys(candidate).sort()) !==
        JSON.stringify(["destinationIds", "serviceGroupId"])
    ) {
      throw new Error("Invalid presentation navigation discovery");
    }
    const record = candidate as Record<string, unknown>;
    const definition: PresentationServiceGroupDefinition | undefined =
      PRESENTATION_SERVICE_GROUP_DEFINITIONS.find(
        ({ serviceGroupId }) => serviceGroupId === record.serviceGroupId,
      );
    const destinationIds = record.destinationIds;
    if (!definition || !Array.isArray(destinationIds)) {
      throw new Error("Invalid presentation navigation discovery");
    }
    const registeredDestinations = definition.services.flatMap(({ destinations }) => destinations);
    if (
      destinationIds.some(
        (destinationId) =>
          typeof destinationId !== "string" ||
          !registeredDestinations.some(
            (destination) => destination.destinationId === destinationId,
          ),
      )
    ) {
      throw new Error("Invalid presentation navigation discovery");
    }
    const canonicalDestinationIds = registeredDestinations
      .map(({ destinationId }) => destinationId)
      .filter((destinationId) => destinationIds.includes(destinationId));
    if (JSON.stringify(destinationIds) !== JSON.stringify(canonicalDestinationIds)) {
      throw new Error("Invalid presentation navigation discovery");
    }
    parsed.push({
      destinationIds: canonicalDestinationIds,
      serviceGroupId: definition.serviceGroupId,
    });
  }
  const canonicalGroups = PRESENTATION_SERVICE_GROUP_DEFINITIONS.map(
    ({ serviceGroupId }) => serviceGroupId,
  ).filter((serviceGroupId) =>
    parsed.some((candidate) => candidate.serviceGroupId === serviceGroupId),
  );
  if (
    JSON.stringify(parsed.map(({ serviceGroupId }) => serviceGroupId)) !==
    JSON.stringify(canonicalGroups)
  ) {
    throw new Error("Invalid presentation navigation discovery");
  }
  return { serviceGroups: parsed };
}
