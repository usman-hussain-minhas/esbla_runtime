import { HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION, ZEN_V1_SURFACE_CONTRACTS } from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  assertPresentationCompositionRegistriesCurrent,
  parsePresentationPreferenceInput,
  resolvePresentationPreferences,
  validatePersonalSurfacePlacements,
} from "./presentation.js";

describe("presentation preference core", () => {
  it("validates the exact code-owned surface and widget registries at startup", () => {
    expect(assertPresentationCompositionRegistriesCurrent()).toBeUndefined();
    expect(() =>
      assertPresentationCompositionRegistriesCurrent({
        widgetDefinitions: [
          {
            ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
            canonicalHash: "0".repeat(64),
          },
        ],
      }),
    ).toThrow("Presentation composition registry is invalid");
    expect(() =>
      assertPresentationCompositionRegistriesCurrent({
        surfaceContracts: [
          { ...ZEN_V1_SURFACE_CONTRACTS[0], canonicalHash: "0".repeat(64) },
          ZEN_V1_SURFACE_CONTRACTS[1],
        ],
      }),
    ).toThrow("Presentation composition registry is invalid");
  });

  it("rejects coupled or unrecognized appearance values", () => {
    expect(() =>
      parsePresentationPreferenceInput({
        expectedVersion: 1,
        highContrast: "high-contrast",
        palette: "light",
      }),
    ).toThrow();
    expect(() =>
      parsePresentationPreferenceInput({
        expectedVersion: 1,
        highContrast: false,
        palette: "system",
      }),
    ).toThrow();
  });

  it("resolves a user override over tenant and code defaults without coupling contrast", () => {
    expect(
      resolvePresentationPreferences({
        codeDefault: { highContrast: false, palette: "light" },
        tenantDefault: { highContrast: true, palette: "light" },
        userOverride: { highContrast: true, palette: "dark" },
      }),
    ).toEqual({
      highContrast: true,
      palette: "dark",
      source: "user_override",
    });
  });

  it("accepts only the exact surface instance and rejects overlap or registry drift", () => {
    const basePlacements = ZEN_V1_SURFACE_CONTRACTS[0].basePlacements;
    const moved = basePlacements.map((placement) =>
      placement.instanceId === "mission-control.my-leave" ? { ...placement, row: 10 } : placement,
    );
    expect(validatePersonalSurfacePlacements("surface.mission-control", moved)).toHaveLength(
      basePlacements.length,
    );
    expect(() =>
      validatePersonalSurfacePlacements(
        "surface.mission-control",
        moved.map((placement) =>
          placement.instanceId === "mission-control.my-leave"
            ? { ...placement, instanceId: "hr-mission-control.my-leave" }
            : placement,
        ),
      ),
    ).toThrow();
  });
});
