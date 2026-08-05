import {
  PRESENTATION_DEEP_ROUTE_DEFINITIONS,
  type PresentationDestinationExposure,
  presentationServiceGroupIds,
} from "./platform-presentation-service-group.js";
import {
  PRESENTATION_SURFACE_DEFINITIONS,
  ZEN_V1_SURFACE_CONTRACTS,
  type ZenV1SurfaceId,
} from "./platform-presentation-surface-api.js";
import {
  PRESENTATION_WIDGET_DEFINITIONS,
  type PresentationSemanticIconKey,
  type PresentationWidgetDefinition,
} from "./platform-presentation-widget.js";

export type PresentationSurfaceZeroEligibleBehavior = "hide_surface" | "render_empty";
export const presentationWidgetExpansionModes = ["quick_view", "workspace"] as const;
export type PresentationWidgetExpansionMode = (typeof presentationWidgetExpansionModes)[number];
export const presentationWidgetWorkspaceContentLayouts = [
  "administration",
  "form",
  "list",
  "master-detail",
  "report",
  "single-detail",
] as const;
export type PresentationWidgetWorkspaceContentLayout =
  (typeof presentationWidgetWorkspaceContentLayouts)[number];

export interface PresentationSurfaceAnyProviderActivationProjection {
  readonly providerActivationServiceKeys: readonly string[];
  readonly widgetDefinitionId: string;
  readonly widgetDefinitionVersion: number;
}

export interface PresentationSemanticSurfaceDefinition {
  readonly allowedWidgetSourceServiceGroups: readonly string[];
  readonly anyProviderActivationProjections: readonly PresentationSurfaceAnyProviderActivationProjection[];
  readonly contextualOrder: number | null;
  readonly deniedBehavior: "fail_closed";
  readonly description: string;
  readonly eligibilityPolicy: "any_eligible_registered_widget_v1";
  readonly exposure: "surface";
  readonly fallbackSurfaceId: string | null;
  readonly label: string;
  readonly route: string;
  readonly schemaVersion: 1;
  readonly semanticIcon: PresentationSemanticIconKey;
  readonly serviceGroupId: string;
  readonly surfaceId: string;
  readonly taskOutcome: string;
  readonly unavailableBehavior: "truthful_unavailable";
  readonly zeroEligibleBehavior: PresentationSurfaceZeroEligibleBehavior;
}

export interface PresentationWidgetSettingEligibilityRule {
  readonly absentIsEligible: boolean;
  readonly eligibleValues: readonly string[];
  readonly recognizedValues: readonly string[];
  readonly settingKey: string;
  readonly valueType: "enum";
}

export type PresentationWidgetCurrentRoleEligibility =
  | Readonly<{ kind: "any_current_role" }>
  | Readonly<{ kind: "one_of"; roleKeys: readonly string[] }>;

export interface PresentationWidgetAdmissionDefinition {
  readonly currentRoleEligibility: PresentationWidgetCurrentRoleEligibility;
  readonly expansionMode: PresentationWidgetExpansionMode | null;
  readonly providerCurrentRoleEligibility: readonly Readonly<{
    activationServiceKey: string;
    currentRoleEligibility: PresentationWidgetCurrentRoleEligibility;
  }>[];
  readonly settingEligibility: PresentationWidgetSettingEligibilityRule | null;
  readonly widgetDefinitionId: string;
  readonly widgetDefinitionVersion: number;
  readonly workspaceContentLayout: PresentationWidgetWorkspaceContentLayout | null;
}

export interface PresentationSemanticRegistryInput {
  readonly schemaVersion: 1;
  readonly deepRoutes: readonly Readonly<{
    destinationId: string;
    exposure: PresentationDestinationExposure;
    href: string;
  }>[];
  readonly serviceGroupIds: readonly string[];
  readonly surfaceContracts: readonly Readonly<{
    catalogueInstances: readonly Readonly<{
      widgetDefinitionId: string;
      widgetDefinitionVersion: number;
    }>[];
    defaultInstances: readonly Readonly<{
      widgetDefinitionId: string;
      widgetDefinitionVersion: number;
    }>[];
    definitionHash: string;
    surfaceId: string;
  }>[];
  readonly surfaceDefinitions: readonly Readonly<{
    definitionHash: string;
    id: string;
    route: string;
    serviceGroup: string;
  }>[];
  readonly surfaces: readonly PresentationSemanticSurfaceDefinition[];
  readonly widgetAdmissions: readonly PresentationWidgetAdmissionDefinition[];
  readonly widgetDefinitions: readonly PresentationWidgetDefinition[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS = deepFreeze([
  {
    allowedWidgetSourceServiceGroups: ["hr", "platform", "workspace"],
    anyProviderActivationProjections: [
      {
        providerActivationServiceKeys: [
          "hr.leave_request",
          "timesheet",
          "expense_claim_boundary",
          "workspace.task",
        ],
        widgetDefinitionId: "platform.my-work.queue",
        widgetDefinitionVersion: 1,
      },
    ],
    contextualOrder: null,
    deniedBehavior: "fail_closed",
    description: "The universal cross-service operating surface.",
    eligibilityPolicy: "any_eligible_registered_widget_v1",
    exposure: "surface",
    fallbackSurfaceId: null,
    label: "Mission Control",
    route: "/",
    schemaVersion: 1,
    semanticIcon: "home",
    serviceGroupId: "universal",
    surfaceId: "surface.mission-control",
    taskOutcome: "Operate eligible work across active service groups through shared widgets.",
    unavailableBehavior: "truthful_unavailable",
    zeroEligibleBehavior: "render_empty",
  },
  {
    allowedWidgetSourceServiceGroups: ["hr", "platform"],
    anyProviderActivationProjections: [
      {
        providerActivationServiceKeys: ["hr.leave_request", "timesheet", "expense_claim_boundary"],
        widgetDefinitionId: "platform.my-work.queue",
        widgetDefinitionVersion: 1,
      },
    ],
    contextualOrder: 1,
    deniedBehavior: "fail_closed",
    description: "The curated HR service-group overview surface.",
    eligibilityPolicy: "any_eligible_registered_widget_v1",
    exposure: "surface",
    fallbackSurfaceId: "surface.mission-control",
    label: "HR Mission Control",
    route: "/workspace/hr",
    schemaVersion: 1,
    semanticIcon: "users-round",
    serviceGroupId: "hr",
    surfaceId: "surface.hr.mission-control",
    taskOutcome: "Operate eligible HR work through a curated cross-service overview.",
    unavailableBehavior: "truthful_unavailable",
    zeroEligibleBehavior: "hide_surface",
  },
] as const) satisfies readonly PresentationSemanticSurfaceDefinition[];

const anyCurrentRole = deepFreeze({ kind: "any_current_role" } as const);
const employee = deepFreeze({ kind: "one_of", roleKeys: ["employee"] } as const);
const manager = deepFreeze({ kind: "one_of", roleKeys: ["manager"] } as const);
const hrOperator = deepFreeze({ kind: "one_of", roleKeys: ["hr_operator"] } as const);
const employeeOrHrOperator = deepFreeze({
  kind: "one_of",
  roleKeys: ["employee", "hr_operator"],
} as const);
const managerOrHrOperator = deepFreeze({
  kind: "one_of",
  roleKeys: ["hr_operator", "manager"],
} as const);

function admission(
  widgetDefinitionId: string,
  currentRoleEligibility: PresentationWidgetCurrentRoleEligibility,
  expansionMode: PresentationWidgetExpansionMode | null,
  workspaceContentLayout: PresentationWidgetWorkspaceContentLayout | null = null,
  settingEligibility: PresentationWidgetSettingEligibilityRule | null = null,
  providerCurrentRoleEligibility: PresentationWidgetAdmissionDefinition["providerCurrentRoleEligibility"] = [],
): PresentationWidgetAdmissionDefinition {
  return {
    currentRoleEligibility,
    expansionMode,
    providerCurrentRoleEligibility,
    settingEligibility,
    widgetDefinitionId,
    widgetDefinitionVersion: 1,
    workspaceContentLayout,
  };
}

export const PRESENTATION_WIDGET_ADMISSION_DEFINITIONS = deepFreeze([
  admission("hr.attendance.my-observations", employee, "workspace", "list"),
  admission("hr.attendance.correction-queue", hrOperator, "workspace", "report"),
  admission("hr.attendance.reports", managerOrHrOperator, "workspace", "report"),
  admission("hr.employment.current-facts", employeeOrHrOperator, "workspace", "list"),
  admission("hr.employment.admin-queue", hrOperator, "workspace", "administration"),
  admission("hr.employment.history", employeeOrHrOperator, "workspace", "list"),
  admission("hr.expense.assigned", manager, "workspace", "administration"),
  admission("hr.expense.corrections", employee, "workspace", "list"),
  admission("hr.expense.draft", employee, "workspace", "list"),
  admission("hr.expense.mine", employee, "workspace", "list"),
  admission("hr.leave.my-requests", employee, "workspace", "list"),
  admission("hr.leave.assigned", manager, "workspace", "administration"),
  admission("hr.leave.history", employee, "workspace", "list"),
  admission("hr.leave.request-form", employee, "quick_view"),
  admission("hr.shift.my-published", employee, "workspace", "list"),
  admission("hr.shift.publish-queue", hrOperator, "workspace", "administration"),
  admission("hr.shift.roster-overview", managerOrHrOperator, "workspace", "report"),
  admission("hr.timesheet.mine", employee, "workspace", "list"),
  admission("hr.timesheet.assigned", manager, "workspace", "administration"),
  admission("hr.timesheet.corrections", hrOperator, "quick_view"),
  admission("hr.timesheet.draft", employee, "workspace", "list"),
  admission("hr.workforce.my-profile", employee, "quick_view"),
  admission(
    "hr.workforce.direct-reports",
    manager,
    "workspace",
    "list",
    deepFreeze({
      absentIsEligible: true,
      eligibleValues: ["minimized"],
      recognizedValues: ["minimized", "none"],
      settingKey: "hr.workforce_profile.manager_visibility",
      valueType: "enum",
    }),
  ),
  admission("hr.workforce.admin-queue", hrOperator, "workspace", "administration"),
  admission("hr.workforce.status-reporting", hrOperator, null),
  admission("workspace.tasks.mine", anyCurrentRole, "workspace", "list"),
  admission("platform.my-work.queue", anyCurrentRole, "workspace", "administration", null, [
    { activationServiceKey: "hr.leave_request", currentRoleEligibility: manager },
    { activationServiceKey: "timesheet", currentRoleEligibility: manager },
    { activationServiceKey: "expense_claim_boundary", currentRoleEligibility: manager },
    { activationServiceKey: "workspace.task", currentRoleEligibility: anyCurrentRole },
  ]),
] as const) satisfies readonly PresentationWidgetAdmissionDefinition[];

export const PRESENTATION_SEMANTIC_REGISTRY = deepFreeze({
  deepRoutes: PRESENTATION_DEEP_ROUTE_DEFINITIONS,
  schemaVersion: 1,
  serviceGroupIds: presentationServiceGroupIds,
  surfaceContracts: ZEN_V1_SURFACE_CONTRACTS,
  surfaceDefinitions: PRESENTATION_SURFACE_DEFINITIONS,
  surfaces: PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS,
  widgetAdmissions: PRESENTATION_WIDGET_ADMISSION_DEFINITIONS,
  widgetDefinitions: PRESENTATION_WIDGET_DEFINITIONS,
} as const);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function assertNoFallbackCycles(surfaces: readonly PresentationSemanticSurfaceDefinition[]): void {
  const byId = new Map(surfaces.map((surface) => [surface.surfaceId, surface]));
  for (const surface of surfaces) {
    const visited = new Set<string>([surface.surfaceId]);
    let next = surface.fallbackSurfaceId;
    while (next !== null) {
      if (visited.has(next)) throw new Error("Presentation surface fallback cycle");
      visited.add(next);
      const fallback = byId.get(next);
      if (!fallback) throw new Error("Unknown presentation surface fallback");
      next = fallback.fallbackSurfaceId;
    }
  }
}

export function validatePresentationSemanticRegistry(
  input: PresentationSemanticRegistryInput = PRESENTATION_SEMANTIC_REGISTRY,
): void {
  const { deepRoutes, serviceGroupIds, surfaceContracts, surfaceDefinitions, surfaces } = input;
  const { widgetAdmissions, widgetDefinitions } = input;
  if (
    input.schemaVersion !== 1 ||
    input.surfaceDefinitions.length !== surfaces.length ||
    surfaceContracts.length !== surfaces.length ||
    hasDuplicates(serviceGroupIds) ||
    hasDuplicates(surfaces.map(({ surfaceId }) => surfaceId)) ||
    hasDuplicates(surfaces.map(({ route }) => route)) ||
    hasDuplicates(deepRoutes.map(({ destinationId }) => destinationId)) ||
    hasDuplicates(deepRoutes.map(({ href }) => href)) ||
    hasDuplicates(widgetAdmissions.map(({ widgetDefinitionId }) => widgetDefinitionId))
  ) {
    throw new Error("Invalid presentation semantic registry topology");
  }

  const definitionsById = new Map(
    surfaceDefinitions.map((definition) => [definition.id, definition]),
  );
  const contractsById = new Map(surfaceContracts.map((contract) => [contract.surfaceId, contract]));
  const widgetsByKey = new Map(
    widgetDefinitions.map((definition) => [
      `${definition.id}@${definition.definitionVersion}`,
      definition,
    ]),
  );
  const admissionsByKey = new Map(
    widgetAdmissions.map((admissionDefinition) => [
      `${admissionDefinition.widgetDefinitionId}@${admissionDefinition.widgetDefinitionVersion}`,
      admissionDefinition,
    ]),
  );
  const deepRoutesByHref = new Map(deepRoutes.map((route) => [route.href, route]));
  const surfaceRouteSet = new Set(surfaces.map(({ route }) => route));

  if (
    surfaceDefinitions.some((definition, index) => definition.id !== surfaces[index]?.surfaceId) ||
    surfaceContracts.some((contract, index) => contract.surfaceId !== surfaces[index]?.surfaceId) ||
    deepRoutes.some(
      ({ exposure, href }) =>
        (exposure !== "action_only" && exposure !== "widget_route") ||
        !nonEmpty(href) ||
        surfaceRouteSet.has(href),
    )
  ) {
    throw new Error("Invalid presentation semantic registry binding");
  }

  for (const surface of surfaces) {
    const definition = definitionsById.get(surface.surfaceId);
    const contract = contractsById.get(surface.surfaceId);
    if (
      surface.schemaVersion !== 1 ||
      surface.exposure !== "surface" ||
      !definition ||
      !contract ||
      definition.route !== surface.route ||
      definition.serviceGroup !== surface.serviceGroupId ||
      contract.definitionHash !== definition.definitionHash ||
      !nonEmpty(surface.label) ||
      !nonEmpty(surface.description) ||
      !nonEmpty(surface.taskOutcome) ||
      surface.eligibilityPolicy !== "any_eligible_registered_widget_v1" ||
      surface.deniedBehavior !== "fail_closed" ||
      surface.unavailableBehavior !== "truthful_unavailable" ||
      (surface.zeroEligibleBehavior !== "hide_surface" &&
        surface.zeroEligibleBehavior !== "render_empty") ||
      !Array.isArray(surface.anyProviderActivationProjections) ||
      surface.allowedWidgetSourceServiceGroups.length === 0 ||
      hasDuplicates(surface.allowedWidgetSourceServiceGroups) ||
      (surface.serviceGroupId !== "universal" &&
        !serviceGroupIds.includes(surface.serviceGroupId)) ||
      (surface.serviceGroupId === "universal" && surface.contextualOrder !== null) ||
      (surface.serviceGroupId !== "universal" &&
        (!Number.isSafeInteger(surface.contextualOrder) || Number(surface.contextualOrder) < 1))
    ) {
      throw new Error("Invalid presentation semantic surface");
    }
    for (const instance of [...contract.defaultInstances, ...contract.catalogueInstances]) {
      const widget = widgetsByKey.get(
        `${instance.widgetDefinitionId}@${instance.widgetDefinitionVersion}`,
      );
      if (
        !widget ||
        !surface.allowedWidgetSourceServiceGroups.includes(widget.sourceServiceGroup)
      ) {
        throw new Error("Incompatible presentation surface widget");
      }
    }

    const registeredWidgetKeys = new Set(
      [...contract.defaultInstances, ...contract.catalogueInstances].map(
        ({ widgetDefinitionId, widgetDefinitionVersion }) =>
          `${widgetDefinitionId}@${widgetDefinitionVersion}`,
      ),
    );
    const registeredAnyProviderWidgetKeys = [...registeredWidgetKeys].filter(
      (widgetKey) => widgetsByKey.get(widgetKey)?.activationPolicy === "any_provider",
    );
    const projectionKeys = surface.anyProviderActivationProjections.map(
      ({ widgetDefinitionId, widgetDefinitionVersion }) =>
        `${widgetDefinitionId}@${widgetDefinitionVersion}`,
    );
    if (
      hasDuplicates(projectionKeys) ||
      projectionKeys.length !== registeredAnyProviderWidgetKeys.length ||
      registeredAnyProviderWidgetKeys.some((widgetKey) => !projectionKeys.includes(widgetKey))
    ) {
      throw new Error("Invalid presentation surface any-provider activation projection");
    }
    for (const projection of surface.anyProviderActivationProjections) {
      const widgetKey = `${projection.widgetDefinitionId}@${projection.widgetDefinitionVersion}`;
      const widget = widgetsByKey.get(widgetKey);
      const admissionDefinition = admissionsByKey.get(widgetKey);
      const providerActivationServiceKeys = projection.providerActivationServiceKeys;
      const widgetProviderKeys = widget?.providerEligibility.map(
        ({ activationServiceKey }) => activationServiceKey,
      );
      const admissionProviderKeys = admissionDefinition?.providerCurrentRoleEligibility.map(
        ({ activationServiceKey }) => activationServiceKey,
      );
      if (
        !nonEmpty(projection.widgetDefinitionId) ||
        !Number.isSafeInteger(projection.widgetDefinitionVersion) ||
        projection.widgetDefinitionVersion < 1 ||
        !registeredWidgetKeys.has(widgetKey) ||
        widget?.activationPolicy !== "any_provider" ||
        !admissionDefinition ||
        !Array.isArray(providerActivationServiceKeys) ||
        providerActivationServiceKeys.length === 0 ||
        providerActivationServiceKeys.some((providerKey) => !nonEmpty(providerKey)) ||
        hasDuplicates(providerActivationServiceKeys) ||
        !widgetProviderKeys ||
        !admissionProviderKeys ||
        providerActivationServiceKeys.some(
          (providerKey) =>
            !widgetProviderKeys.includes(providerKey) ||
            !admissionProviderKeys.includes(providerKey),
        ) ||
        JSON.stringify(providerActivationServiceKeys) !==
          JSON.stringify(
            widgetProviderKeys.filter((providerKey) =>
              providerActivationServiceKeys.includes(providerKey),
            ),
          )
      ) {
        throw new Error("Invalid presentation surface any-provider activation projection");
      }
    }
  }

  for (const serviceGroupId of serviceGroupIds) {
    const orders = surfaces
      .filter((surface) => surface.serviceGroupId === serviceGroupId)
      .map(({ contextualOrder }) => contextualOrder);
    if (orders.length === 0) {
      throw new Error("Invalid presentation service-group surface coverage");
    }
    if (orders.some((order, index) => order !== index + 1)) {
      throw new Error("Invalid presentation surface contextual order");
    }
  }
  assertNoFallbackCycles(surfaces);

  if (
    widgetDefinitions.length !== widgetAdmissions.length ||
    widgetDefinitions.some(
      (widget) => !admissionsByKey.has(`${widget.id}@${widget.definitionVersion}`),
    ) ||
    widgetAdmissions.some(
      (admissionDefinition) =>
        !widgetsByKey.has(
          `${admissionDefinition.widgetDefinitionId}@${admissionDefinition.widgetDefinitionVersion}`,
        ),
    )
  ) {
    throw new Error("Invalid presentation widget admission registry");
  }

  const consumedWidgetRoutes = new Set<string>();
  for (const widget of widgetDefinitions) {
    const admissionDefinition = admissionsByKey.get(`${widget.id}@${widget.definitionVersion}`);
    if (
      !admissionDefinition ||
      !nonEmpty(widget.activationServiceKey) ||
      widget.eligibilityPolicyId !== "current_tenant_activation_and_capability_v1" ||
      (widget.activationPolicy === "exact_service" && widget.requiredCapabilityIds.length === 0) ||
      (widget.activationPolicy === "any_provider" &&
        (widget.providerEligibility.length === 0 ||
          widget.providerEligibility.some(
            (provider) =>
              !nonEmpty(provider.activationServiceKey) ||
              provider.requiredCapabilityIds.length === 0,
          ))) ||
      (widget.fullScreenRoute !== null &&
        deepRoutesByHref.get(widget.fullScreenRoute)?.exposure !== "widget_route")
    ) {
      throw new Error("Invalid presentation widget semantic admission");
    }
    const role = admissionDefinition.currentRoleEligibility;
    const expansionMode = admissionDefinition.expansionMode;
    const providerRoleKeys = admissionDefinition.providerCurrentRoleEligibility.map(
      ({ activationServiceKey }) => activationServiceKey,
    );
    const widgetProviderKeys = widget.providerEligibility.map(
      ({ activationServiceKey }) => activationServiceKey,
    );
    if (
      (role.kind !== "any_current_role" && role.kind !== "one_of") ||
      (role.kind === "one_of" &&
        (role.roleKeys.length === 0 ||
          hasDuplicates(role.roleKeys) ||
          role.roleKeys.some((key) => !nonEmpty(key)))) ||
      (expansionMode !== null && !presentationWidgetExpansionModes.includes(expansionMode)) ||
      (expansionMode === null && admissionDefinition.workspaceContentLayout !== null) ||
      (expansionMode === "quick_view" && admissionDefinition.workspaceContentLayout !== null) ||
      (expansionMode === "workspace" &&
        !presentationWidgetWorkspaceContentLayouts.includes(
          admissionDefinition.workspaceContentLayout as PresentationWidgetWorkspaceContentLayout,
        )) ||
      (expansionMode !== null && widget.fullScreenRoute === null) ||
      (widget.activationPolicy === "exact_service" && providerRoleKeys.length !== 0) ||
      (widget.activationPolicy === "any_provider" &&
        (hasDuplicates(providerRoleKeys) ||
          JSON.stringify([...providerRoleKeys].sort()) !==
            JSON.stringify([...widgetProviderKeys].sort()) ||
          admissionDefinition.providerCurrentRoleEligibility.some(
            (provider) =>
              (provider.currentRoleEligibility.kind !== "any_current_role" &&
                provider.currentRoleEligibility.kind !== "one_of") ||
              (provider.currentRoleEligibility.kind === "one_of" &&
                (provider.currentRoleEligibility.roleKeys.length === 0 ||
                  hasDuplicates(provider.currentRoleEligibility.roleKeys) ||
                  provider.currentRoleEligibility.roleKeys.some((key) => !nonEmpty(key)))),
          ))) ||
      (admissionDefinition.settingEligibility !== null &&
        (admissionDefinition.settingEligibility.valueType !== "enum" ||
          typeof admissionDefinition.settingEligibility.absentIsEligible !== "boolean" ||
          !nonEmpty(admissionDefinition.settingEligibility.settingKey) ||
          admissionDefinition.settingEligibility.recognizedValues.length === 0 ||
          admissionDefinition.settingEligibility.eligibleValues.length === 0 ||
          hasDuplicates(admissionDefinition.settingEligibility.recognizedValues) ||
          hasDuplicates(admissionDefinition.settingEligibility.eligibleValues) ||
          admissionDefinition.settingEligibility.recognizedValues.some(
            (value) => !nonEmpty(value),
          ) ||
          admissionDefinition.settingEligibility.eligibleValues.some((value) => !nonEmpty(value)) ||
          admissionDefinition.settingEligibility.eligibleValues.some(
            (value) => !admissionDefinition.settingEligibility?.recognizedValues.includes(value),
          )))
    ) {
      throw new Error("Invalid presentation widget role admission");
    }
    if (expansionMode !== null && widget.fullScreenRoute !== null) {
      consumedWidgetRoutes.add(widget.fullScreenRoute);
    }
  }
  if (
    deepRoutes.some(
      ({ exposure, href }) => exposure === "widget_route" && !consumedWidgetRoutes.has(href),
    )
  ) {
    throw new Error("Unconsumed presentation widget route");
  }
}

export function getPresentationSemanticSurfaceDefinition(
  surfaceId: ZenV1SurfaceId,
): PresentationSemanticSurfaceDefinition {
  const definition = PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.find(
    (candidate) => candidate.surfaceId === surfaceId,
  );
  if (!definition) throw new Error("Unknown presentation semantic surface");
  return definition;
}

export function getPresentationSurfaceAnyProviderActivationServiceKeys(
  surfaceId: ZenV1SurfaceId,
  widgetDefinitionId: string,
  widgetDefinitionVersion: number,
): readonly string[] {
  const projection = getPresentationSemanticSurfaceDefinition(
    surfaceId,
  ).anyProviderActivationProjections.find(
    (candidate) =>
      candidate.widgetDefinitionId === widgetDefinitionId &&
      candidate.widgetDefinitionVersion === widgetDefinitionVersion,
  );
  if (!projection) {
    throw new Error("Unknown presentation surface any-provider activation projection");
  }
  return projection.providerActivationServiceKeys;
}

export function getPresentationWidgetAdmissionDefinition(
  widgetDefinitionId: string,
  widgetDefinitionVersion: number,
): PresentationWidgetAdmissionDefinition {
  const definition = PRESENTATION_WIDGET_ADMISSION_DEFINITIONS.find(
    (candidate) =>
      candidate.widgetDefinitionId === widgetDefinitionId &&
      candidate.widgetDefinitionVersion === widgetDefinitionVersion,
  );
  if (!definition) throw new Error("Unknown presentation widget admission");
  return definition;
}
