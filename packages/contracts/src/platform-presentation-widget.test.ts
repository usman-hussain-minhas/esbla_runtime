import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizePresentationWidgetDefinition,
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
  PRESENTATION_WIDGET_DEFINITIONS,
  parsePresentationSemanticIconKey,
  parsePresentationWidgetDefinition,
  presentationSemanticIconKeys,
  validatePresentationWidgetRegistry,
} from "./platform-presentation-widget.js";

describe("presentation widget manifest", () => {
  it("binds the complete immutable Leave definition to its startup hash", () => {
    const { canonicalHash, ...manifest } = HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION;
    expect(
      createHash("sha256").update(canonicalizePresentationWidgetDefinition(manifest)).digest("hex"),
    ).toBe(canonicalHash);
    expect(parsePresentationWidgetDefinition(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION)).toBe(
      HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
    );
  });

  it("aligns the proven Leave face with the ratified V1 manifest semantics", () => {
    expect(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION).toMatchObject({
      activationServiceKey: "hr.leave_request",
      displayName: "My Leave Requests",
      eligibilityPolicyId: "current_tenant_activation_and_capability_v1",
      fullScreenRoute: "/workspace/hr/leave",
      id: "hr.leave.my-requests",
      readModelId: "hr.leave.my-requests.read.v1",
      sourceServiceGroup: "hr",
      sourceServiceKey: "leave_request",
      supportedSurfaceTypes: ["mission_control", "service_group_mission_control", "standalone"],
    });
    expect(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION.layoutConstraints.desktop).toMatchObject({
      maximumColumnSpan: 12,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
      preferredColumnSpan: 4,
      preferredRowSpan: 3,
    });
    expect(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION.fullWidthEligible).toBe(true);
    expect(Object.isFrozen(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION)).toBe(true);
    expect(Object.isFrozen(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION.layoutConstraints.desktop)).toBe(
      true,
    );
  });

  it("validates the complete registry generically and rejects identity or hash collisions", () => {
    expect(validatePresentationWidgetRegistry(PRESENTATION_WIDGET_DEFINITIONS)).toBe(
      PRESENTATION_WIDGET_DEFINITIONS,
    );
    expect(() =>
      validatePresentationWidgetRegistry([
        ...PRESENTATION_WIDGET_DEFINITIONS,
        HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
      ]),
    ).toThrow("Duplicate presentation widget definition");
    expect(() =>
      validatePresentationWidgetRegistry([
        ...PRESENTATION_WIDGET_DEFINITIONS,
        { ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION, id: "hr.leave.second-face" },
      ]),
    ).toThrow("Duplicate presentation widget definition");
    expect(() =>
      validatePresentationWidgetRegistry([
        {
          ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
          canonicalHash: "f".repeat(64),
          id: "hr.leave.z-face",
        },
        HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
      ]),
    ).toThrow("Invalid presentation widget registry order");
  });

  it("canonicalizes arbitrary configuration keys by locale-independent code-unit order", () => {
    const { canonicalHash: _canonicalHash, ...manifest } = HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION;
    const canonical = canonicalizePresentationWidgetDefinition({
      ...manifest,
      configurationSchema: { z: true, ä: true },
    });
    expect(canonical.indexOf('"z"')).toBeLessThan(canonical.indexOf('"ä"'));
  });

  it("rejects definition drift and executable manifest extensions", () => {
    const cyclicConfiguration: Record<string, unknown> = {};
    cyclicConfiguration.self = cyclicConfiguration;
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        executableImport: "private/widget.js",
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        requiredCapabilityIds: ["unsafe capability"],
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        semanticIcon: "arbitrary-svg",
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        configurationSchema: cyclicConfiguration,
      }),
    ).toThrow("Invalid presentation widget definition");
  });

  it("accepts only the code-owned semantic icon registry and declares one fallback", () => {
    expect(presentationSemanticIconKeys).toContain("modules");
    expect(presentationSemanticIconKeys).toContain("menu");
    expect(presentationSemanticIconKeys).toContain("calendar-check");
    expect(presentationSemanticIconKeys).toContain("generic-service");
    expect(presentationSemanticIconKeys).not.toContain("service-groups");
    expect(presentationSemanticIconKeys).not.toContain("page-menu");
    expect(parsePresentationSemanticIconKey("calendar-check")).toBe("calendar-check");
    expect(() => parsePresentationSemanticIconKey("package/private-icon")).toThrow(
      "Invalid presentation semantic icon",
    );
  });
});
