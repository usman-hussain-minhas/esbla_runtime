import { zenV1SurfaceIds } from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  getZenSurfaceEditDescriptor,
  selectZenSurfaceEditDescriptor,
} from "./zen-surface-edit-core";

describe("Zen surface editor discovery", () => {
  it("derives every current and future-facing surface editor descriptor from the registry", () => {
    expect(zenV1SurfaceIds.map(getZenSurfaceEditDescriptor)).toEqual([
      expect.objectContaining({
        ariaLabel: "Edit Mission Control personal layout",
        route: "/",
        surfaceId: "surface.mission-control",
      }),
      expect.objectContaining({
        ariaLabel: "Edit HR Mission Control personal layout",
        route: "/workspace/hr",
        surfaceId: "surface.hr.mission-control",
      }),
      expect.objectContaining({
        ariaLabel: "Edit Workforce personal layout",
        route: "/workspace/hr/workforce",
        surfaceId: "surface.hr.workforce",
      }),
      expect.objectContaining({
        ariaLabel: "Edit Time & Scheduling personal layout",
        route: "/workspace/hr/time-and-scheduling",
        surfaceId: "surface.hr.time-and-scheduling",
      }),
      expect.objectContaining({
        ariaLabel: "Edit Requests & Claims personal layout",
        route: "/workspace/hr/requests-and-claims",
        surfaceId: "surface.hr.requests-and-claims",
      }),
    ]);
  });

  it("shows only the exact current registered surface launcher", () => {
    const descriptors = zenV1SurfaceIds.map(getZenSurfaceEditDescriptor);
    expect(selectZenSurfaceEditDescriptor(descriptors, "/workspace/hr/workforce")?.surfaceId).toBe(
      "surface.hr.workforce",
    );
    expect(selectZenSurfaceEditDescriptor(descriptors, "/workspace/hr/profile/admin")).toBe(
      undefined,
    );
  });
});
