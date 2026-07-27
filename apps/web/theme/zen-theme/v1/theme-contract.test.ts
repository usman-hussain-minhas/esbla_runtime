import { createHash } from "node:crypto";
import { getZenV1SurfaceContract, presentationSemanticIconKeys } from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_SETTING_DEFINITIONS,
  canonicalizeWidgetDefinition,
  DEFAULT_SURFACE_INSTANCES,
  SURFACE_DEFINITIONS,
  WIDGET_DEFINITIONS,
  ZEN_THEME_ALIASES,
  ZEN_THEME_DEFINITION,
} from "./index";

describe("Zen Theme v1 composition contract", () => {
  it("defines exactly the two code-owned Mission Control surfaces", () => {
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

  it("reuses one real Leave widget definition on both surfaces", () => {
    expect(WIDGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        activationServiceKey: "hr.leave_request",
        billingTreatment: "non_billable",
        definitionVersion: 1,
        eligibilityPolicyId: "hr.leave.my-requests.eligible.v1",
        fullScreenRoute: "/workspace/hr/leave/[leaveRequestId]",
        id: "hr.leave.my-requests",
        requiredCapabilityIds: ["hr.leave.list_own", "hr.leave.view"],
        semanticIcon: "calendar-check",
        sourceServiceGroup: "hr",
      }),
    );
    const widget = WIDGET_DEFINITIONS[0];
    if (!widget) throw new Error("Leave widget definition is missing");
    const { canonicalHash: _canonicalHash, ...manifest } = widget;
    expect(createHash("sha256").update(canonicalizeWidgetDefinition(manifest)).digest("hex")).toBe(
      widget?.canonicalHash,
    );
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
    expect(presentationSemanticIconKeys).toContain(WIDGET_DEFINITIONS[0]?.semanticIcon);
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
