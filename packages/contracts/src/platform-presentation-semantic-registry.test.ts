import { describe, expect, it } from "vitest";
import {
  getPresentationSemanticSurfaceDefinition,
  getPresentationSurfaceAnyProviderActivationServiceKeys,
  getPresentationWidgetAdmissionDefinition,
  PRESENTATION_SEMANTIC_REGISTRY,
  PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS,
  PRESENTATION_WIDGET_ADMISSION_DEFINITIONS,
  type PresentationSemanticRegistryInput,
  type PresentationSurfaceAnyProviderActivationProjection,
  validatePresentationSemanticRegistry,
} from "./platform-presentation-semantic-registry.js";
import { PRESENTATION_DEEP_ROUTE_DEFINITIONS } from "./platform-presentation-service-group.js";
import { ZEN_V1_SURFACE_CONTRACTS } from "./platform-presentation-surface-api.js";
import {
  PRESENTATION_WIDGET_DEFINITIONS,
  type PresentationWidgetDefinition,
} from "./platform-presentation-widget.js";

function replaceInput(
  changes: Partial<PresentationSemanticRegistryInput>,
): PresentationSemanticRegistryInput {
  return { ...PRESENTATION_SEMANTIC_REGISTRY, ...changes };
}

describe("presentation semantic registry", () => {
  it("binds the exact five active surfaces, deep-route exposure and current roles", () => {
    expect(validatePresentationSemanticRegistry()).toBeUndefined();
    expect(
      PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.map(
        ({ contextualOrder, label, route, surfaceId }) => ({
          contextualOrder,
          label,
          route,
          surfaceId,
        }),
      ),
    ).toEqual([
      {
        contextualOrder: null,
        label: "Mission Control",
        route: "/",
        surfaceId: "surface.mission-control",
      },
      {
        contextualOrder: 1,
        label: "HR Mission Control",
        route: "/workspace/hr",
        surfaceId: "surface.hr.mission-control",
      },
      {
        contextualOrder: 2,
        label: "Workforce",
        route: "/workspace/hr/workforce",
        surfaceId: "surface.hr.workforce",
      },
      {
        contextualOrder: 3,
        label: "Time & Scheduling",
        route: "/workspace/hr/time-and-scheduling",
        surfaceId: "surface.hr.time-and-scheduling",
      },
      {
        contextualOrder: 4,
        label: "Requests & Claims",
        route: "/workspace/hr/requests-and-claims",
        surfaceId: "surface.hr.requests-and-claims",
      },
    ]);
    expect(
      ZEN_V1_SURFACE_CONTRACTS.slice(2).map(({ defaultInstances }) => defaultInstances.length),
    ).toEqual([7, 10, 8]);
    expect(PRESENTATION_WIDGET_ADMISSION_DEFINITIONS).toHaveLength(27);
    expect(PRESENTATION_DEEP_ROUTE_DEFINITIONS).toHaveLength(22);
    expect(
      PRESENTATION_DEEP_ROUTE_DEFINITIONS.filter(({ exposure }) => exposure === "action_only"),
    ).toHaveLength(6);
    expect(PRESENTATION_DEEP_ROUTE_DEFINITIONS.map(({ exposure }) => exposure)).not.toContain(
      "surface",
    );
    expect(
      PRESENTATION_DEEP_ROUTE_DEFINITIONS.filter(({ exposure }) => exposure === "widget_route"),
    ).toHaveLength(16);
    expect(
      PRESENTATION_WIDGET_DEFINITIONS.every(
        ({ fullScreenRoute }) =>
          fullScreenRoute === null ||
          PRESENTATION_DEEP_ROUTE_DEFINITIONS.some(({ href }) => href === fullScreenRoute),
      ),
    ).toBe(true);
    const consumedExpansionRoutes = new Set<string>(
      PRESENTATION_WIDGET_ADMISSION_DEFINITIONS.flatMap((admission) => {
        if (admission.expansionMode === null) return [];
        const route = PRESENTATION_WIDGET_DEFINITIONS.find(
          ({ definitionVersion, id }) =>
            id === admission.widgetDefinitionId &&
            definitionVersion === admission.widgetDefinitionVersion,
        )?.fullScreenRoute;
        return route ? [route] : [];
      }),
    );
    expect(
      PRESENTATION_DEEP_ROUTE_DEFINITIONS.filter(
        ({ exposure }) => exposure === "widget_route",
      ).every(({ href }) => consumedExpansionRoutes.has(href)),
    ).toBe(true);
    expect(getPresentationSemanticSurfaceDefinition("surface.hr.mission-control")).toMatchObject({
      fallbackSurfaceId: "surface.mission-control",
      zeroEligibleBehavior: "hide_surface",
    });
    expect(getPresentationSemanticSurfaceDefinition("surface.hr.workforce")).toMatchObject({
      allowedWidgetSourceServiceGroups: ["hr"],
      anyProviderActivationProjections: [],
      fallbackSurfaceId: "surface.hr.mission-control",
      zeroEligibleBehavior: "hide_surface",
    });
    expect(
      PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.slice(2).every(
        ({ anyProviderActivationProjections }) => anyProviderActivationProjections.length === 0,
      ),
    ).toBe(true);
    expect(
      getPresentationSurfaceAnyProviderActivationServiceKeys(
        "surface.mission-control",
        "platform.my-work.queue",
        1,
      ),
    ).toEqual(["hr.leave_request", "timesheet", "expense_claim_boundary", "workspace.task"]);
    expect(
      getPresentationSurfaceAnyProviderActivationServiceKeys(
        "surface.hr.mission-control",
        "platform.my-work.queue",
        1,
      ),
    ).toEqual(["hr.leave_request", "timesheet", "expense_claim_boundary"]);
    expect(
      getPresentationWidgetAdmissionDefinition("hr.workforce.direct-reports", 1),
    ).toMatchObject({
      currentRoleEligibility: { kind: "one_of", roleKeys: ["manager"] },
      settingEligibility: {
        absentIsEligible: true,
        eligibleValues: ["minimized"],
        recognizedValues: ["minimized", "none"],
      },
    });
    expect(getPresentationWidgetAdmissionDefinition("platform.my-work.queue", 1)).toMatchObject({
      providerCurrentRoleEligibility: [
        {
          activationServiceKey: "hr.leave_request",
          currentRoleEligibility: { roleKeys: ["manager"] },
        },
        { activationServiceKey: "timesheet", currentRoleEligibility: { roleKeys: ["manager"] } },
        {
          activationServiceKey: "expense_claim_boundary",
          currentRoleEligibility: { roleKeys: ["manager"] },
        },
        {
          activationServiceKey: "workspace.task",
          currentRoleEligibility: { kind: "any_current_role" },
        },
      ],
    });
  });

  it("rejects topology, membership, fallback, route and admission drift", () => {
    const firstDeepRoute = PRESENTATION_DEEP_ROUTE_DEFINITIONS[0];
    if (!firstDeepRoute) throw new Error("Deep-route fixture is unavailable");
    expect(() =>
      validatePresentationSemanticRegistry(replaceInput({ schemaVersion: 2 as never })),
    ).toThrow("Invalid presentation semantic registry topology");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          serviceGroupIds: [...PRESENTATION_SEMANTIC_REGISTRY.serviceGroupIds, "orphan"],
        }),
      ),
    ).toThrow("Invalid presentation service-group surface coverage");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: [
            PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS[0],
            {
              ...PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS[1],
              route: "/",
            },
            ...PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.slice(2),
          ],
        }),
      ),
    ).toThrow("Invalid presentation semantic registry topology");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          deepRoutes: [
            { ...firstDeepRoute, exposure: "surface" },
            ...PRESENTATION_DEEP_ROUTE_DEFINITIONS.slice(1),
          ],
        }),
      ),
    ).toThrow("Invalid presentation semantic registry binding");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          deepRoutes: [
            { ...firstDeepRoute, exposure: "unknown" as never },
            ...PRESENTATION_DEEP_ROUTE_DEFINITIONS.slice(1),
          ],
        }),
      ),
    ).toThrow("Invalid presentation semantic registry binding");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.map((surface) =>
            surface.surfaceId === "surface.hr.mission-control"
              ? { ...surface, allowedWidgetSourceServiceGroups: ["workspace"] }
              : surface,
          ),
        }),
      ),
    ).toThrow("Incompatible presentation surface widget");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.map((surface) =>
            surface.surfaceId === "surface.mission-control"
              ? { ...surface, fallbackSurfaceId: "surface.hr.mission-control" }
              : surface,
          ),
        }),
      ),
    ).toThrow("Presentation surface fallback cycle");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetAdmissions: PRESENTATION_WIDGET_ADMISSION_DEFINITIONS.slice(1),
        }),
      ),
    ).toThrow("Invalid presentation widget admission registry");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetDefinitions: PRESENTATION_WIDGET_DEFINITIONS.map((widget, index) =>
            index === 0 ? { ...widget, eligibilityPolicyId: "unknown_policy_v1" } : widget,
          ),
        }),
      ),
    ).toThrow("Invalid presentation widget semantic admission");
    const firstWidget = PRESENTATION_WIDGET_DEFINITIONS[0];
    const firstAdmission = PRESENTATION_WIDGET_ADMISSION_DEFINITIONS[0];
    if (!firstWidget || !firstAdmission)
      throw new Error("Widget admission fixtures are unavailable");
    const futureWidgetWithoutAdmission = {
      ...firstWidget,
      canonicalHash: "f".repeat(64),
      id: "future.widget.without-admission",
      migration: {
        ...firstWidget.migration,
        id: "future.widget.without-admission.v1",
      },
      readModelId: "future.widget.without-admission.read.v1",
    } satisfies PresentationWidgetDefinition;
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetDefinitions: [...PRESENTATION_WIDGET_DEFINITIONS, futureWidgetWithoutAdmission],
        }),
      ),
    ).toThrow("Invalid presentation widget admission registry");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetAdmissions: [
            { ...firstAdmission, expansionMode: "drawer" as never },
            ...PRESENTATION_WIDGET_ADMISSION_DEFINITIONS.slice(1),
          ],
        }),
      ),
    ).toThrow("Invalid presentation widget role admission");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetAdmissions: [
            { ...firstAdmission, widgetDefinitionVersion: 2 },
            ...PRESENTATION_WIDGET_ADMISSION_DEFINITIONS.slice(1),
          ],
        }),
      ),
    ).toThrow("Invalid presentation widget admission registry");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetAdmissions: [
            { ...firstAdmission, currentRoleEligibility: { kind: "unknown" } as never },
            ...PRESENTATION_WIDGET_ADMISSION_DEFINITIONS.slice(1),
          ],
        }),
      ),
    ).toThrow("Invalid presentation widget role admission");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetDefinitions: [
            { ...firstWidget, fullScreenRoute: "/workspace/unregistered" },
            ...PRESENTATION_WIDGET_DEFINITIONS.slice(1),
          ],
        }),
      ),
    ).toThrow("Invalid presentation widget semantic admission");
    const myWork = getPresentationWidgetAdmissionDefinition("platform.my-work.queue", 1);
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          widgetAdmissions: PRESENTATION_WIDGET_ADMISSION_DEFINITIONS.map((candidate) =>
            candidate === myWork
              ? {
                  ...candidate,
                  providerCurrentRoleEligibility: candidate.providerCurrentRoleEligibility.map(
                    (provider, index) =>
                      index === 0
                        ? {
                            ...provider,
                            currentRoleEligibility: { kind: "unknown" } as never,
                          }
                        : provider,
                  ),
                }
              : candidate,
          ),
        }),
      ),
    ).toThrow("Invalid presentation widget role admission");
  });

  it("rejects missing, duplicate, exact-service, unknown and unordered provider projections", () => {
    const root = PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS[0];
    const hr = PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS[1];
    const rootProjection = root?.anyProviderActivationProjections[0];
    if (!root || !hr || !rootProjection) {
      throw new Error("Surface projection fixtures are unavailable");
    }
    const replaceRootProjection = (
      projection: PresentationSurfaceAnyProviderActivationProjection,
    ): PresentationSemanticRegistryInput["surfaces"] => [
      { ...root, anyProviderActivationProjections: [projection] },
      hr,
      ...PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.slice(2),
    ];

    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: [
            { ...root, anyProviderActivationProjections: [] },
            hr,
            ...PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.slice(2),
          ],
        }),
      ),
    ).toThrow("Invalid presentation surface any-provider activation projection");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: [
            {
              ...root,
              anyProviderActivationProjections: [rootProjection, rootProjection],
            },
            hr,
            ...PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.slice(2),
          ],
        }),
      ),
    ).toThrow("Invalid presentation surface any-provider activation projection");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: replaceRootProjection({
            ...rootProjection,
            widgetDefinitionId: "hr.leave.my-requests",
          }),
        }),
      ),
    ).toThrow("Invalid presentation surface any-provider activation projection");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: replaceRootProjection({
            ...rootProjection,
            providerActivationServiceKeys: [
              ...rootProjection.providerActivationServiceKeys,
              "unknown.provider",
            ],
          }),
        }),
      ),
    ).toThrow("Invalid presentation surface any-provider activation projection");
    expect(() =>
      validatePresentationSemanticRegistry(
        replaceInput({
          surfaces: replaceRootProjection({
            ...rootProjection,
            providerActivationServiceKeys: [
              ...rootProjection.providerActivationServiceKeys,
            ].reverse(),
          }),
        }),
      ),
    ).toThrow("Invalid presentation surface any-provider activation projection");
    expect(() =>
      getPresentationSurfaceAnyProviderActivationServiceKeys(
        "surface.hr.mission-control",
        "hr.leave.my-requests",
        1,
      ),
    ).toThrow("Unknown presentation surface any-provider activation projection");
  });

  it("admits a synthetic future service group through the same branch-free validator", () => {
    const sourceWidget = PRESENTATION_WIDGET_DEFINITIONS[0];
    if (!sourceWidget) throw new Error("Synthetic widget source is unavailable");
    const syntheticWidget = {
      ...sourceWidget,
      activationPolicy: "any_provider",
      activationServiceKey: "synthetic.aggregate",
      canonicalHash: "a".repeat(64),
      fullScreenRoute: "/workspace/synthetic/queue",
      id: "synthetic.queue",
      migration: { compatibleFrom: 1, compatibleThrough: 1, id: "synthetic.queue.v1" },
      providerEligibility: [
        {
          activationServiceKey: "synthetic.queue.primary",
          requiredCapabilityIds: ["synthetic.queue.list"],
        },
        {
          activationServiceKey: "synthetic.queue.secondary",
          requiredCapabilityIds: ["synthetic.queue.view"],
        },
      ],
      readModelId: "synthetic.queue.read.v1",
      requiredCapabilityIds: ["synthetic.queue.list", "synthetic.queue.view"],
      sourceServiceGroup: "synthetic",
      sourceServiceKey: "queue",
    } satisfies PresentationWidgetDefinition;
    const placement = {
      column: 1,
      columnSpan: 4,
      instanceId: "synthetic.queue",
      placementPolicy: "default_optional" as const,
      row: 1,
      rowSpan: 3,
      sectionId: "overview" as const,
      sourceOrder: 1,
      widgetDefinitionId: syntheticWidget.id,
      widgetDefinitionVersion: 1,
    };
    const surfaceDefinitions = [
      {
        definitionHash: "b".repeat(64),
        id: "surface.synthetic.mission-control",
        route: "/workspace/synthetic",
        serviceGroup: "synthetic",
      },
    ] satisfies PresentationSemanticRegistryInput["surfaceDefinitions"];
    const surfaceContracts = [
      {
        catalogueInstances: [],
        defaultInstances: [placement],
        definitionHash: "b".repeat(64),
        surfaceId: "surface.synthetic.mission-control",
      },
    ] satisfies PresentationSemanticRegistryInput["surfaceContracts"];
    expect(
      validatePresentationSemanticRegistry({
        schemaVersion: 1,
        deepRoutes: [
          {
            destinationId: "synthetic.queue",
            exposure: "widget_route",
            href: "/workspace/synthetic/queue",
          },
        ],
        serviceGroupIds: ["synthetic"],
        surfaceContracts,
        surfaceDefinitions,
        surfaces: [
          {
            allowedWidgetSourceServiceGroups: ["synthetic"],
            anyProviderActivationProjections: [
              {
                providerActivationServiceKeys: ["synthetic.queue.primary"],
                widgetDefinitionId: syntheticWidget.id,
                widgetDefinitionVersion: 1,
              },
            ],
            contextualOrder: 1,
            deniedBehavior: "fail_closed",
            description: "Synthetic fixture only.",
            eligibilityPolicy: "any_eligible_registered_widget_v1",
            exposure: "surface",
            fallbackSurfaceId: null,
            label: "Synthetic",
            route: "/workspace/synthetic",
            schemaVersion: 1,
            semanticIcon: "generic-service",
            serviceGroupId: "synthetic",
            surfaceId: "surface.synthetic.mission-control",
            taskOutcome: "Prove generic admission without shipping a service group.",
            unavailableBehavior: "truthful_unavailable",
            zeroEligibleBehavior: "hide_surface",
          },
        ],
        widgetAdmissions: [
          {
            currentRoleEligibility: { kind: "one_of", roleKeys: ["synthetic_operator"] },
            expansionMode: "workspace",
            providerCurrentRoleEligibility: [
              {
                activationServiceKey: "synthetic.queue.primary",
                currentRoleEligibility: { kind: "one_of", roleKeys: ["synthetic_operator"] },
              },
              {
                activationServiceKey: "synthetic.queue.secondary",
                currentRoleEligibility: { kind: "one_of", roleKeys: ["synthetic_operator"] },
              },
            ],
            settingEligibility: null,
            widgetDefinitionId: syntheticWidget.id,
            widgetDefinitionVersion: 1,
            workspaceContentLayout: "list",
          },
        ],
        widgetDefinitions: [syntheticWidget],
      }),
    ).toBeUndefined();
    expect(JSON.stringify(PRESENTATION_SEMANTIC_REGISTRY)).not.toContain("synthetic");
  });
});
