import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUpdatePresentationPreferencesResponse } from "./platform-presentation-api.js";
import {
  canonicalizePresentationSurfaceContract,
  canonicalizePresentationSurfaceDefinition,
  PRESENTATION_SURFACE_DEFINITIONS,
  parsePresentationPersonalSurfaceEditorWorkspace,
  parsePresentationSurfaceDefinition,
  parsePresentationSurfaceLayout,
  parsePresentationWidgetPlacements,
  parseUpdatePresentationSurfaceOverlayBody,
  parseUpdatePresentationSurfaceOverlayResponse,
  validatePresentationCompositionRegistries,
  ZEN_V1_SURFACE_CONTRACTS,
} from "./platform-presentation-surface-api.js";
import { PRESENTATION_WIDGET_DEFINITIONS } from "./platform-presentation-widget.js";

describe("platform presentation surface API contract", () => {
  it("binds the exact five distinct version-one Zen surface bases", () => {
    expect(ZEN_V1_SURFACE_CONTRACTS.map(({ surfaceId }) => surfaceId)).toEqual([
      "surface.mission-control",
      "surface.hr.mission-control",
      "surface.hr.workforce",
      "surface.hr.time-and-scheduling",
      "surface.hr.requests-and-claims",
    ]);
    expect(new Set(ZEN_V1_SURFACE_CONTRACTS.map(({ definitionHash }) => definitionHash)).size).toBe(
      5,
    );
    expect(ZEN_V1_SURFACE_CONTRACTS.every(({ baseVersion }) => baseVersion === 1)).toBe(true);
    for (const contract of ZEN_V1_SURFACE_CONTRACTS) {
      const responsiveBases = (
        contract as unknown as {
          readonly basePlacementsByBreakpoint?: Readonly<
            Record<"desktop" | "phone" | "tablet", readonly unknown[]>
          >;
        }
      ).basePlacementsByBreakpoint;
      expect(responsiveBases).toBeDefined();
      expect(responsiveBases?.desktop).toEqual(contract.basePlacements);
      expect(responsiveBases?.tablet).toHaveLength(contract.basePlacements.length);
      expect(responsiveBases?.phone).toHaveLength(contract.basePlacements.length);
      expect(
        [responsiveBases?.desktop, responsiveBases?.tablet, responsiveBases?.phone].every(
          (placements) =>
            placements?.every(
              (placement) =>
                (placement as { readonly widgetDefinitionVersion?: unknown })
                  .widgetDefinitionVersion === 1,
            ) === true,
        ),
      ).toBe(true);
      expect(Object.isFrozen(responsiveBases)).toBe(true);
    }
  });

  it("requires an exact widget-definition version on every persisted placement", () => {
    expect(() =>
      parsePresentationWidgetPlacements([
        {
          column: 1,
          columnSpan: 4,
          instanceId: "mission-control.my-leave",
          row: 1,
          rowSpan: 3,
          widgetDefinitionId: "hr.leave.my-requests",
        },
      ]),
    ).toThrow();
    expect(
      parsePresentationWidgetPlacements([
        {
          column: 1,
          columnSpan: 4,
          instanceId: "mission-control.my-leave",
          row: 1,
          rowSpan: 3,
          widgetDefinitionId: "hr.leave.my-requests",
          widgetDefinitionVersion: 1,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        widgetDefinitionId: "hr.leave.my-requests",
        widgetDefinitionVersion: 1,
      }),
    ]);
  });

  it("owns all five surface definitions in one canonical shared registry", () => {
    expect(PRESENTATION_SURFACE_DEFINITIONS).toEqual([
      expect.objectContaining({
        baseVersion: 1,
        columnCount: 12,
        compactColumnCount: 4,
        id: "surface.mission-control",
        mediumColumnCount: 8,
        route: "/",
        serviceGroup: "universal",
      }),
      expect.objectContaining({
        baseVersion: 1,
        columnCount: 12,
        compactColumnCount: 4,
        id: "surface.hr.mission-control",
        mediumColumnCount: 8,
        route: "/workspace/hr",
        serviceGroup: "hr",
      }),
      expect.objectContaining({
        id: "surface.hr.workforce",
        route: "/workspace/hr/workforce",
        serviceGroup: "hr",
      }),
      expect.objectContaining({
        id: "surface.hr.time-and-scheduling",
        route: "/workspace/hr/time-and-scheduling",
        serviceGroup: "hr",
      }),
      expect.objectContaining({
        id: "surface.hr.requests-and-claims",
        route: "/workspace/hr/requests-and-claims",
        serviceGroup: "hr",
      }),
    ]);
    for (const definition of PRESENTATION_SURFACE_DEFINITIONS) {
      const { definitionHash, ...manifest } = definition;
      expect(
        createHash("sha256")
          .update(canonicalizePresentationSurfaceDefinition(manifest))
          .digest("hex"),
      ).toBe(definitionHash);
      expect(parsePresentationSurfaceDefinition(definition)).toBe(definition);
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it("validates surface/widget bindings and preserves ordered placement metadata", () => {
    expect(
      validatePresentationCompositionRegistries(
        PRESENTATION_SURFACE_DEFINITIONS,
        ZEN_V1_SURFACE_CONTRACTS,
        PRESENTATION_WIDGET_DEFINITIONS,
      ),
    ).toBeUndefined();
    for (const contract of ZEN_V1_SURFACE_CONTRACTS) {
      const { canonicalHash, ...manifest } = contract;
      expect(
        createHash("sha256")
          .update(canonicalizePresentationSurfaceContract(manifest))
          .digest("hex"),
      ).toBe(canonicalHash);
      expect(Object.isFrozen(contract.defaultInstances[0])).toBe(true);
      if (contract.catalogueInstances[0]) {
        expect(Object.isFrozen(contract.catalogueInstances[0])).toBe(true);
      }
    }
    expect(
      ZEN_V1_SURFACE_CONTRACTS.map(({ catalogueInstances }) =>
        catalogueInstances.map(({ widgetDefinitionId }) => widgetDefinitionId),
      ),
    ).toEqual([
      [
        "hr.employment.admin-queue",
        "hr.employment.history",
        "hr.workforce.admin-queue",
        "hr.workforce.status-reporting",
        "workspace.tasks.mine",
        "hr.shift.roster-overview",
        "hr.shift.publish-queue",
        "hr.attendance.reports",
        "hr.attendance.correction-queue",
        "hr.leave.assigned",
        "hr.leave.history",
        "hr.leave.request-form",
        "hr.timesheet.assigned",
        "hr.timesheet.draft",
        "hr.timesheet.corrections",
        "hr.expense.assigned",
        "hr.expense.draft",
        "hr.expense.corrections",
      ],
      [
        "hr.employment.admin-queue",
        "hr.employment.history",
        "hr.workforce.admin-queue",
        "hr.workforce.status-reporting",
        "hr.shift.roster-overview",
        "hr.shift.publish-queue",
        "hr.attendance.reports",
        "hr.attendance.correction-queue",
        "hr.leave.assigned",
        "hr.leave.history",
        "hr.leave.request-form",
        "hr.timesheet.assigned",
        "hr.timesheet.draft",
        "hr.timesheet.corrections",
        "hr.expense.assigned",
        "hr.expense.draft",
        "hr.expense.corrections",
      ],
      [],
      [],
      [],
    ]);
    expect(ZEN_V1_SURFACE_CONTRACTS.map(({ defaultInstances }) => defaultInstances[0])).toEqual([
      expect.objectContaining({
        instanceId: "mission-control.my-work",
        placementPolicy: "default_optional",
        sectionId: "overview",
        sourceOrder: 1,
        widgetDefinitionVersion: 1,
      }),
      expect.objectContaining({
        instanceId: "hr-mission-control.my-profile",
        sourceOrder: 1,
      }),
      expect.objectContaining({
        instanceId: "hr-workforce.my-profile",
        sourceOrder: 1,
      }),
      expect.objectContaining({
        instanceId: "hr-time-and-scheduling.my-published-shifts",
        sourceOrder: 1,
      }),
      expect.objectContaining({
        instanceId: "hr-requests-and-claims.my-leave",
        placementPolicy: "default_optional",
        sectionId: "overview",
        sourceOrder: 1,
        widgetDefinitionVersion: 1,
      }),
    ]);
    expect(
      ZEN_V1_SURFACE_CONTRACTS.map(({ defaultInstances }) =>
        defaultInstances.map(({ instanceId }) => instanceId),
      ),
    ).toEqual([
      [
        "mission-control.my-work",
        "mission-control.my-published-shifts",
        "mission-control.my-leave",
        "mission-control.my-attendance",
        "mission-control.my-timesheets",
        "mission-control.my-expenses",
        "mission-control.my-profile",
        "mission-control.direct-reports",
      ],
      [
        "hr-mission-control.my-profile",
        "hr-mission-control.current-employment",
        "hr-mission-control.my-work",
        "hr-mission-control.my-published-shifts",
        "hr-mission-control.my-attendance",
        "hr-mission-control.my-leave",
        "hr-mission-control.my-timesheets",
        "hr-mission-control.my-expenses",
      ],
      [
        "hr-workforce.my-profile",
        "hr-workforce.direct-reports",
        "hr-workforce.admin-queue",
        "hr-workforce.status-reporting",
        "hr-workforce.current-employment",
        "hr-workforce.employment-history",
        "hr-workforce.employment-admin-queue",
      ],
      [
        "hr-time-and-scheduling.my-published-shifts",
        "hr-time-and-scheduling.roster-overview",
        "hr-time-and-scheduling.publish-queue",
        "hr-time-and-scheduling.my-attendance",
        "hr-time-and-scheduling.attendance-reports",
        "hr-time-and-scheduling.attendance-correction-queue",
        "hr-time-and-scheduling.my-timesheets",
        "hr-time-and-scheduling.timesheet-draft",
        "hr-time-and-scheduling.timesheet-assigned",
        "hr-time-and-scheduling.timesheet-corrections",
      ],
      [
        "hr-requests-and-claims.my-leave",
        "hr-requests-and-claims.leave-request-form",
        "hr-requests-and-claims.leave-assigned",
        "hr-requests-and-claims.leave-history",
        "hr-requests-and-claims.my-expenses",
        "hr-requests-and-claims.expense-draft",
        "hr-requests-and-claims.expense-assigned",
        "hr-requests-and-claims.expense-corrections",
      ],
    ]);
    const universalFirstPlacement = ZEN_V1_SURFACE_CONTRACTS[0].basePlacements[0];
    const universalFirstInstance = ZEN_V1_SURFACE_CONTRACTS[0].defaultInstances[0];
    if (!universalFirstPlacement || !universalFirstInstance) {
      throw new Error("Universal Mission Control base is missing");
    }
    expect(() =>
      validatePresentationCompositionRegistries(
        PRESENTATION_SURFACE_DEFINITIONS,
        [
          {
            ...ZEN_V1_SURFACE_CONTRACTS[0],
            basePlacements: [
              {
                ...universalFirstPlacement,
                widgetDefinitionId: "hr.unknown.widget",
              },
            ],
            defaultInstances: [
              {
                ...universalFirstInstance,
                widgetDefinitionId: "hr.unknown.widget",
              },
            ],
          },
          ZEN_V1_SURFACE_CONTRACTS[1],
          ZEN_V1_SURFACE_CONTRACTS[2],
          ZEN_V1_SURFACE_CONTRACTS[3],
          ZEN_V1_SURFACE_CONTRACTS[4],
        ],
        PRESENTATION_WIDGET_DEFINITIONS,
      ),
    ).toThrow("Unknown presentation widget definition");
  });

  it("strictly parses one bounded personal overlay", () => {
    expect(
      parseUpdatePresentationSurfaceOverlayBody({
        expectedVersion: 0,
        placements: [
          {
            column: 2,
            columnSpan: 4,
            instanceId: "mission-control.my-leave",
            row: 5,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
            widgetDefinitionVersion: 1,
          },
        ],
      }),
    ).toMatchObject({ expectedVersion: 0 });
    expect(() =>
      parseUpdatePresentationSurfaceOverlayBody({
        expectedVersion: 0,
        placements: [],
        unsafe: true,
      }),
    ).toThrow();
  });

  it("rejects a response whose surface binding or placement is not exact", () => {
    expect(() =>
      parsePresentationSurfaceLayout({
        baseDefinitionHash: "0".repeat(64),
        basePlacements: [],
        baseVersion: 1,
        diagnostics: [],
        effectivePlacements: [],
        overlayVersion: 0,
        source: "code_default",
        surfaceId: "surface.mission-control",
      }),
    ).toThrow();
    expect(() =>
      parsePresentationSurfaceLayout({
        baseDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
        basePlacements: [
          {
            column: 2,
            columnSpan: 4,
            instanceId: "mission-control.my-leave",
            row: 4,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
          },
        ],
        baseVersion: 1,
        diagnostics: [],
        effectivePlacements: [],
        overlayVersion: 0,
        source: "code_default",
        surfaceId: "surface.mission-control",
      }),
    ).toThrow();
  });

  it("accepts an exact capability-filtered empty universal surface without widget topology", () => {
    const base = ZEN_V1_SURFACE_CONTRACTS[0];
    expect(
      parsePresentationSurfaceLayout({
        baseDefinitionHash: base.definitionHash,
        basePlacements: [],
        baseVersion: base.baseVersion,
        diagnostics: [],
        effectivePlacements: [],
        overlayVersion: 0,
        source: "code_default",
        surfaceId: base.surfaceId,
      }),
    ).toEqual({
      baseDefinitionHash: base.definitionHash,
      basePlacements: [],
      baseVersion: 1,
      diagnostics: [],
      effectivePlacements: [],
      overlayVersion: 0,
      source: "code_default",
      surfaceId: "surface.mission-control",
    });
  });

  it("strictly binds personal editor availability to one parsed surface layout", () => {
    const base = ZEN_V1_SURFACE_CONTRACTS[0];
    expect(
      parsePresentationPersonalSurfaceEditorWorkspace({
        availablePlacements: [],
        editable: false,
        layout: {
          baseDefinitionHash: base.definitionHash,
          basePlacements: [],
          baseVersion: base.baseVersion,
          diagnostics: [],
          effectivePlacements: [],
          overlayVersion: 0,
          source: "code_default",
          surfaceId: base.surfaceId,
        },
        lockReason: "layout_write_capability_absent",
        resettable: true,
      }),
    ).toMatchObject({
      editable: false,
      layout: { surfaceId: "surface.mission-control" },
      lockReason: "layout_write_capability_absent",
      resettable: true,
    });
    expect(() =>
      parsePresentationPersonalSurfaceEditorWorkspace({
        editable: true,
        layout: {},
        lockReason: "layout_write_capability_absent",
      }),
    ).toThrow();
  });

  it("preserves explicit non-sensitive overlay conflict diagnostics", () => {
    const base = ZEN_V1_SURFACE_CONTRACTS[0];
    expect(
      parsePresentationSurfaceLayout({
        baseDefinitionHash: base.definitionHash,
        basePlacements: base.basePlacements,
        baseVersion: base.baseVersion,
        diagnostics: [
          {
            code: "overlay_placement_conflict",
            instanceId: "mission-control.my-leave",
          },
        ],
        effectivePlacements: base.basePlacements,
        overlayVersion: 1,
        source: "user_overlay",
        surfaceId: base.surfaceId,
      }).diagnostics,
    ).toEqual([
      {
        code: "overlay_placement_conflict",
        instanceId: "mission-control.my-leave",
      },
    ]);
  });

  it("requires explicit non-billing treatment on an overlay mutation response", () => {
    const base = ZEN_V1_SURFACE_CONTRACTS[0];
    expect(
      parseUpdatePresentationSurfaceOverlayResponse({
        baseDefinitionHash: base.definitionHash,
        basePlacements: base.basePlacements,
        baseVersion: base.baseVersion,
        billingState: "non_billable",
        diagnostics: [],
        effectivePlacements: base.basePlacements,
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        overlayVersion: 1,
        replayed: false,
        source: "user_overlay",
        surfaceId: base.surfaceId,
      }),
    ).toMatchObject({ billingState: "non_billable" });
    expect(() =>
      parseUpdatePresentationSurfaceOverlayResponse({
        baseDefinitionHash: base.definitionHash,
        basePlacements: base.basePlacements,
        baseVersion: base.baseVersion,
        diagnostics: [],
        effectivePlacements: base.basePlacements,
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        overlayVersion: 1,
        replayed: false,
        source: "user_overlay",
        surfaceId: base.surfaceId,
      }),
    ).toThrow();
  });

  it("requires explicit non-billing treatment on a preference mutation response", () => {
    expect(
      parseUpdatePresentationPreferencesResponse({
        appearance: {
          density: {
            effectiveValue: "comfortable",
            key: "appearance.density.v1",
            locked: false,
            lockReason: null,
            source: "product_default",
            tenantValue: null,
            userValue: null,
          },
          highContrast: {
            effectiveValue: true,
            key: "appearance.high_contrast.v1",
            locked: false,
            lockReason: null,
            source: "user_global",
            tenantValue: null,
            userValue: true,
          },
          palette: {
            effectiveValue: "dark",
            key: "appearance.palette.v1",
            locked: false,
            lockReason: null,
            source: "user_global",
            tenantValue: null,
            userValue: "dark",
          },
          reducedMotion: {
            effectiveValue: "auto",
            key: "appearance.reduced_motion.v1",
            locked: false,
            lockReason: null,
            source: "product_default",
            tenantValue: null,
            userValue: null,
          },
        },
        billingState: "non_billable",
        canManageTenantDefaults: false,
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        replayed: false,
        tenantVersion: 0,
        userVersion: 1,
      }),
    ).toMatchObject({ billingState: "non_billable" });
    expect(() =>
      parseUpdatePresentationPreferencesResponse({
        appearance: {},
        canManageTenantDefaults: false,
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        replayed: false,
        tenantVersion: 0,
        userVersion: 1,
      }),
    ).toThrow();
  });
});
