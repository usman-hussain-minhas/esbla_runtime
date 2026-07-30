import { createHash } from "node:crypto";
import {
  getZenV1SurfaceContract,
  PRESENTATION_SURFACE_DEFINITIONS,
  PRESENTATION_WIDGET_DEFINITIONS,
  presentationSemanticIconKeys,
} from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_SETTING_DEFINITIONS,
  canonicalizeWidgetDefinition,
  DEFAULT_SURFACE_INSTANCES,
  getRegisteredSurfaceInstance,
  getWidgetDefinition,
  SURFACE_DEFINITIONS,
  WIDGET_DEFINITIONS,
  ZEN_THEME_ALIASES,
  ZEN_THEME_DEFINITION,
} from "./index";

describe("Zen Theme v1 composition contract", () => {
  it("binds each T5 representative definition to every ratified eligible surface instance", () => {
    expect(
      DEFAULT_SURFACE_INSTANCES.map(({ id, surfaceId, widgetDefinitionId }) => ({
        id,
        surfaceId,
        widgetDefinitionId,
      })),
    ).toEqual([
      {
        id: "mission-control.my-work",
        surfaceId: "surface.mission-control",
        widgetDefinitionId: "platform.my-work.queue",
      },
      {
        id: "mission-control.my-published-shifts",
        surfaceId: "surface.mission-control",
        widgetDefinitionId: "hr.shift.my-published",
      },
      {
        id: "mission-control.my-leave",
        surfaceId: "surface.mission-control",
        widgetDefinitionId: "hr.leave.my-requests",
      },
      {
        id: "mission-control.my-timesheets",
        surfaceId: "surface.mission-control",
        widgetDefinitionId: "hr.timesheet.mine",
      },
      {
        id: "mission-control.my-profile",
        surfaceId: "surface.mission-control",
        widgetDefinitionId: "hr.workforce.my-profile",
      },
      {
        id: "hr-mission-control.my-profile",
        surfaceId: "surface.hr.mission-control",
        widgetDefinitionId: "hr.workforce.my-profile",
      },
      {
        id: "hr-mission-control.current-employment",
        surfaceId: "surface.hr.mission-control",
        widgetDefinitionId: "hr.employment.current-facts",
      },
      {
        id: "hr-mission-control.my-work",
        surfaceId: "surface.hr.mission-control",
        widgetDefinitionId: "platform.my-work.queue",
      },
      {
        id: "hr-mission-control.my-published-shifts",
        surfaceId: "surface.hr.mission-control",
        widgetDefinitionId: "hr.shift.my-published",
      },
      {
        id: "hr-mission-control.my-leave",
        surfaceId: "surface.hr.mission-control",
        widgetDefinitionId: "hr.leave.my-requests",
      },
      {
        id: "hr-mission-control.my-timesheets",
        surfaceId: "surface.hr.mission-control",
        widgetDefinitionId: "hr.timesheet.mine",
      },
    ]);
  });

  it("defines exactly the two code-owned Mission Control surfaces", () => {
    expect(SURFACE_DEFINITIONS).toBe(PRESENTATION_SURFACE_DEFINITIONS);
    expect(SURFACE_DEFINITIONS).toEqual([
      expect.objectContaining({
        columnCount: 12,
        id: "surface.mission-control",
        route: "/",
      }),
      expect.objectContaining({
        columnCount: 12,
        id: "surface.hr.mission-control",
        route: "/workspace/hr",
      }),
    ]);
    expect(SURFACE_DEFINITIONS.map(({ definitionHash }) => definitionHash)).toEqual([
      "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
      "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
    ]);
    expect(SURFACE_DEFINITIONS.every(({ baseVersion }) => baseVersion === 1)).toBe(true);
    for (const surface of SURFACE_DEFINITIONS) {
      const canonical = JSON.stringify({
        baseVersion: surface.baseVersion,
        columnCount: surface.columnCount,
        compactColumnCount: surface.compactColumnCount,
        id: surface.id,
        mediumColumnCount: surface.mediumColumnCount,
        route: surface.route,
        serviceGroup: surface.serviceGroup,
      });
      expect(createHash("sha256").update(canonical).digest("hex")).toBe(surface.definitionHash);
    }
  });

  it("reuses each canonical widget definition across its registered surfaces", () => {
    expect(WIDGET_DEFINITIONS).toBe(PRESENTATION_WIDGET_DEFINITIONS);
    expect(WIDGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        activationServiceKey: "hr.leave_request",
        billingTreatment: "non_billable",
        definitionVersion: 1,
        eligibilityPolicyId: "current_tenant_activation_and_capability_v1",
        fullScreenRoute: "/workspace/hr/leave",
        id: "hr.leave.my-requests",
        requiredCapabilityIds: ["hr.leave.list_own", "hr.leave.view"],
        semanticIcon: "calendar-check",
        sourceServiceGroup: "hr",
      }),
    );
    expect(WIDGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        allowedCommandIds: [
          "hr.timesheet.create",
          "hr.timesheet.edit_draft",
          "hr.timesheet.submit",
        ],
        fullScreenRoute: "/workspace/hr/timesheets",
        id: "hr.timesheet.draft",
        inlineMutationEligible: true,
      }),
    );
    for (const widget of WIDGET_DEFINITIONS) {
      const { canonicalHash: _canonicalHash, ...manifest } = widget;
      expect(
        createHash("sha256").update(canonicalizeWidgetDefinition(manifest)).digest("hex"),
      ).toBe(widget.canonicalHash);
    }
    expect(
      DEFAULT_SURFACE_INSTANCES.filter(
        (instance) => instance.widgetDefinitionId === "hr.leave.my-requests",
      ),
    ).toEqual([
      expect.objectContaining({
        id: "mission-control.my-leave",
        surfaceId: "surface.mission-control",
      }),
      expect.objectContaining({
        id: "hr-mission-control.my-leave",
        surfaceId: "surface.hr.mission-control",
      }),
    ]);
    for (const instance of DEFAULT_SURFACE_INSTANCES) {
      const registered = getRegisteredSurfaceInstance(instance.surfaceId, instance.id);
      expect(registered.instanceId).toBe(instance.id);
      expect(registered.widgetDefinitionVersion).toBe(instance.widgetDefinitionVersion);
      expect(
        getWidgetDefinition(registered.widgetDefinitionId, registered.widgetDefinitionVersion),
      ).toBe(
        WIDGET_DEFINITIONS.find(
          ({ definitionVersion, id }) =>
            id === instance.widgetDefinitionId &&
            definitionVersion === instance.widgetDefinitionVersion,
        ),
      );
      const canonical = getZenV1SurfaceContract(instance.surfaceId).basePlacements.find(
        ({ instanceId }) => instanceId === instance.id,
      );
      expect(canonical).toMatchObject({
        column: instance.column,
        columnSpan: instance.columnSpan,
        row: instance.row,
        rowSpan: instance.rowSpan,
        widgetDefinitionId: instance.widgetDefinitionId,
      });
    }
    expect(() =>
      getRegisteredSurfaceInstance("surface.mission-control", "hr.leave.my-requests"),
    ).toThrow("Widget is not registered for this Zen surface");
    for (const widget of WIDGET_DEFINITIONS) {
      expect(presentationSemanticIconKeys).toContain(widget.semanticIcon);
    }
  });

  it("keeps high contrast independent from the light or dark palette", () => {
    expect(APPEARANCE_SETTING_DEFINITIONS).toEqual([
      expect.objectContaining({
        allowedValues: ["light", "dark"],
        id: "appearance.palette.v1",
      }),
      expect.objectContaining({
        allowedValues: [false, true],
        id: "appearance.high_contrast.v1",
      }),
    ]);
    expect(ZEN_THEME_DEFINITION).toMatchObject({
      canonicalName: "esbla_theme_v1",
      compatibilityVersion: 1,
      id: "THEME-ESBLA-V1",
    });
    expect(ZEN_THEME_ALIASES).toEqual(["zen", "zen_theme", "esbla_v1", "zen_v1", "zen-theme"]);
  });
});
