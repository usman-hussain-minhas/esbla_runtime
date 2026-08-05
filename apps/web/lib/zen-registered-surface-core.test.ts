import {
  getZenV1SurfaceContract,
  type PresentationSurfaceLayout,
  type ZenV1SurfaceId,
} from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import { resolveResponsivePresentationSurfaceLayout } from "./presentation-layout-core";
import { PresentationSurfaceError } from "./presentation-surfaces-core";
import {
  getZenRegisteredSurfaceDescriptor,
  loadZenRegisteredSurfaceState,
} from "./zen-registered-surface-core";

function layoutFor(
  surfaceId: ZenV1SurfaceId,
  placementCount = 1,
): ReturnType<typeof resolveResponsivePresentationSurfaceLayout> {
  const contract = getZenV1SurfaceContract(surfaceId);
  const placements = contract.basePlacements.slice(0, placementCount);
  return resolveResponsivePresentationSurfaceLayout({
    baseDefinitionHash: contract.definitionHash,
    basePlacements: placements,
    baseVersion: contract.baseVersion,
    diagnostics: [],
    effectivePlacements: placements,
    overlayVersion: 0,
    source: "code_default",
    surfaceId,
  } satisfies PresentationSurfaceLayout);
}

describe("registered Zen surface state", () => {
  it("derives the three HR operating surfaces from canonical registries", () => {
    expect(
      [
        "surface.hr.workforce",
        "surface.hr.time-and-scheduling",
        "surface.hr.requests-and-claims",
      ].map((surfaceId) => getZenRegisteredSurfaceDescriptor(surfaceId as ZenV1SurfaceId)),
    ).toEqual([
      expect.objectContaining({
        headingId: "hr-workforce-heading",
        label: "Workforce",
        route: "/workspace/hr/workforce",
        serviceGroupLabel: "HR surface",
      }),
      expect.objectContaining({
        headingId: "hr-time-and-scheduling-heading",
        label: "Time & Scheduling",
        route: "/workspace/hr/time-and-scheduling",
        serviceGroupLabel: "HR surface",
      }),
      expect.objectContaining({
        headingId: "hr-requests-and-claims-heading",
        label: "Requests & Claims",
        route: "/workspace/hr/requests-and-claims",
        serviceGroupLabel: "HR surface",
      }),
    ]);
  });

  it("preserves an eligible layout without rewriting its source, version or placements", async () => {
    const layout = layoutFor("surface.hr.workforce");
    const state = await loadZenRegisteredSurfaceState("surface.hr.workforce", async () => layout);
    expect(state).toEqual({ kind: "ready", layout });
    if (state.kind !== "ready") throw new Error("Expected a ready surface");
    expect(state.layout).toBe(layout);
    expect(state.layout.source).toBe("code_default");
    expect(state.layout.overlayVersion).toBe(0);
  });

  it("renders an allowed empty surface but hides a zero-eligible service surface", async () => {
    await expect(
      loadZenRegisteredSurfaceState("surface.mission-control", async () =>
        layoutFor("surface.mission-control", 0),
      ),
    ).resolves.toEqual({
      kind: "empty",
      layout: layoutFor("surface.mission-control", 0),
    });
    await expect(
      loadZenRegisteredSurfaceState("surface.hr.requests-and-claims", async () =>
        layoutFor("surface.hr.requests-and-claims", 0),
      ),
    ).resolves.toEqual({ kind: "denied" });
  });

  it("fails forbidden evidence closed and sanitizes every other failure", async () => {
    await expect(
      loadZenRegisteredSurfaceState("surface.hr.workforce", async () => {
        throw new PresentationSurfaceError("forbidden");
      }),
    ).resolves.toEqual({ kind: "denied" });
    for (const error of [new PresentationSurfaceError("unavailable"), new Error("private")]) {
      await expect(
        loadZenRegisteredSurfaceState("surface.hr.workforce", async () => {
          throw error;
        }),
      ).resolves.toEqual({ kind: "unavailable" });
    }
  });

  it("sanitizes a layout returned for a different registered surface", async () => {
    await expect(
      loadZenRegisteredSurfaceState("surface.hr.workforce", async () =>
        layoutFor("surface.hr.requests-and-claims"),
      ),
    ).resolves.toEqual({ kind: "unavailable" });
  });
});
