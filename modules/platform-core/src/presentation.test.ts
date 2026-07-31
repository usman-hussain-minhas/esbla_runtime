import {
  getZenV1RegisteredSurfacePlacements,
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
  ZEN_V1_SURFACE_CONTRACTS,
} from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  assertPresentationCompositionRegistriesCurrent,
  parsePresentationPreferenceInput,
  reconcileRequiredPresentationSurfacePlacements,
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
        density: "comfortable",
        expectedVersion: 1,
        highContrast: "high-contrast",
        palette: "light",
        reducedMotion: "auto",
      }),
    ).toThrow();
    expect(() =>
      parsePresentationPreferenceInput({
        density: "comfortable",
        expectedVersion: 1,
        highContrast: false,
        palette: "system",
        reducedMotion: "auto",
      }),
    ).toThrow();
  });

  it("resolves each appearance value independently and applies only ratified tenant floors", () => {
    expect(
      resolvePresentationPreferences({
        codeDefault: {
          density: "comfortable",
          highContrast: false,
          palette: "light",
          reducedMotion: "auto",
        },
        tenantDefault: {
          density: "comfortable",
          highContrast: true,
          lockDensity: true,
          palette: "light",
          reducedMotion: "reduce",
          requireHighContrast: true,
          requireReducedMotion: true,
        },
        userOverride: {
          density: "compact",
          highContrast: false,
          palette: "dark",
          reducedMotion: "auto",
        },
      }),
    ).toEqual({
      density: {
        effectiveValue: "comfortable",
        key: "appearance.density.v1",
        locked: true,
        lockReason: "tenant_density_lock",
        source: "tenant_global",
        tenantValue: "comfortable",
        userValue: "compact",
      },
      highContrast: {
        effectiveValue: true,
        key: "appearance.high_contrast.v1",
        locked: true,
        lockReason: "accessibility_high_contrast_floor",
        source: "tenant_global",
        tenantValue: true,
        userValue: false,
      },
      palette: {
        effectiveValue: "dark",
        key: "appearance.palette.v1",
        locked: false,
        lockReason: null,
        source: "user_global",
        tenantValue: "light",
        userValue: "dark",
      },
      reducedMotion: {
        effectiveValue: "reduce",
        key: "appearance.reduced_motion.v1",
        locked: true,
        lockReason: "motion_reduction_floor",
        source: "tenant_global",
        tenantValue: "reduce",
        userValue: "auto",
      },
    });
  });

  it("accepts an exact optional registered subset, including empty, and rejects registry drift", () => {
    const basePlacements = ZEN_V1_SURFACE_CONTRACTS[0].basePlacements;
    const moved = basePlacements.map((placement) =>
      placement.instanceId === "mission-control.my-leave" ? { ...placement, row: 10 } : placement,
    );
    expect(validatePersonalSurfacePlacements("surface.mission-control", moved)).toHaveLength(
      basePlacements.length,
    );
    expect(
      validatePersonalSurfacePlacements("surface.mission-control", [
        moved.find(({ instanceId }) => instanceId === "mission-control.my-leave"),
      ]),
    ).toEqual([
      expect.objectContaining({
        instanceId: "mission-control.my-leave",
        widgetDefinitionId: "hr.leave.my-requests",
      }),
    ]);
    expect(validatePersonalSurfacePlacements("surface.mission-control", [])).toEqual([]);
    const cataloguePlacement = getZenV1RegisteredSurfacePlacements("surface.mission-control").find(
      ({ instanceId }) => instanceId === "mission-control.my-tasks",
    );
    if (!cataloguePlacement) throw new Error("Catalogue placement fixture is missing");
    expect(
      validatePersonalSurfacePlacements("surface.mission-control", [
        { ...cataloguePlacement, column: 1, row: 100 },
      ]),
    ).toEqual([
      expect.objectContaining({
        instanceId: "mission-control.my-tasks",
        widgetDefinitionId: "workspace.tasks.mine",
      }),
    ]);
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
    expect(() =>
      validatePersonalSurfacePlacements(
        "surface.mission-control",
        moved.map((placement) =>
          placement.instanceId === "mission-control.my-leave"
            ? { ...placement, widgetDefinitionVersion: 2 }
            : placement,
        ),
      ),
    ).toThrow();
  });

  it("reconciles a newly required instance ahead of a conflicting optional personal placement", () => {
    const [required, optional] = ZEN_V1_SURFACE_CONTRACTS[0].basePlacements;
    if (!required || !optional) throw new Error("Surface fixture is incomplete");
    expect(
      reconcileRequiredPresentationSurfacePlacements({
        basePlacements: [required, optional],
        personalPlacements: [{ ...optional, column: required.column, row: required.row }],
        requiredInstanceIds: new Set([required.instanceId]),
      }),
    ).toEqual({
      conflictedInstanceIds: [optional.instanceId],
      placements: [required],
    });
  });
});
