import { describe, expect, it } from "vitest";
import {
  assertPresentationWidgetRegistryCurrent,
  parsePresentationPreferenceInput,
  resolvePresentationPreferences,
  validatePersonalSurfacePlacements,
} from "./presentation.js";

describe("presentation preference core", () => {
  it("validates the exact code-owned widget manifest hashes at startup", () => {
    expect(assertPresentationWidgetRegistryCurrent()).toBeUndefined();
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
    expect(
      validatePersonalSurfacePlacements("surface.mission-control", [
        {
          column: 2,
          columnSpan: 4,
          instanceId: "mission-control.my-leave",
          row: 5,
          rowSpan: 3,
          widgetDefinitionId: "hr.leave.my-requests",
        },
      ]),
    ).toHaveLength(1);
    expect(() =>
      validatePersonalSurfacePlacements("surface.mission-control", [
        {
          column: 1,
          columnSpan: 4,
          instanceId: "hr-mission-control.my-leave",
          row: 1,
          rowSpan: 3,
          widgetDefinitionId: "hr.leave.my-requests",
        },
      ]),
    ).toThrow();
  });
});
