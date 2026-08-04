import {
  getZenV1RegisteredSurfacePlacements,
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
  ZEN_V1_SURFACE_CONTRACTS,
} from "@esbla/contracts";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  assertPresentationCompositionRegistriesCurrent,
  assertPresentationSurfaceRegistryCurrent,
  parsePresentationPreferenceInput,
  reconcileRequiredPresentationSurfacePlacements,
  resolvePresentationPreferences,
  validatePersonalSurfacePlacements,
} from "./presentation.js";

describe("presentation preference core", () => {
  it("requires every active code surface in the database admission mirror and permits tombstones", async () => {
    const registryRows: Array<{ surface_id: unknown }> = [
      { surface_id: "surface.hr.mission-control" },
      { surface_id: "surface.hr.requests-and-claims" },
      { surface_id: "surface.hr.time-and-scheduling" },
      { surface_id: "surface.hr.workforce" },
      { surface_id: "surface.mission-control" },
      { surface_id: "surface.retired-tombstone" },
    ];
    const query = vi.fn(async (text: string) =>
      text.includes("FROM public.presentation_surface_registry")
        ? { rows: registryRows }
        : { rows: [] },
    );
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    await expect(
      assertPresentationSurfaceRegistryCurrent(pool, [
        "surface.mission-control",
        "surface.hr.mission-control",
      ]),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith("BEGIN");
    expect(query).toHaveBeenCalledWith(
      "SELECT pg_catalog.pg_advisory_xact_lock_shared($1::integer, $2::integer)",
      [1163084364, 1296648018],
    );
    expect(query).toHaveBeenCalledWith("SET LOCAL search_path = pg_catalog, public");
    expect(query).toHaveBeenCalledWith(
      `SELECT surface_id
       FROM public.presentation_surface_registry
       ORDER BY surface_id`,
    );
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(query.mock.calls.slice(0, 5).map(([text]) => text)).toEqual([
      "BEGIN",
      "SELECT pg_catalog.pg_advisory_xact_lock_shared($1::integer, $2::integer)",
      "SET LOCAL search_path = pg_catalog, public",
      `SELECT surface_id
       FROM public.presentation_surface_registry
       ORDER BY surface_id`,
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledWith(undefined);

    await expect(
      assertPresentationSurfaceRegistryCurrent(pool, [
        "surface.mission-control",
        "surface.hr.mission-control",
        "surface.missing-from-database",
      ]),
    ).rejects.toThrow("Presentation surface persistence registry is invalid");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenLastCalledWith(true);

    registryRows.push({ surface_id: "surface.mission-control" });
    await expect(
      assertPresentationSurfaceRegistryCurrent(pool, ["surface.mission-control"]),
    ).rejects.toThrow("Presentation surface persistence registry is invalid");
    registryRows.pop();
    registryRows.push({ surface_id: 17 });
    await expect(
      assertPresentationSurfaceRegistryCurrent(pool, ["surface.mission-control"]),
    ).rejects.toThrow("Presentation surface persistence registry is invalid");
    registryRows.pop();

    const failedQuery = vi.fn(async (text: string) => {
      if (text.includes("FROM public.presentation_surface_registry")) {
        throw new Error("private database diagnostic");
      }
      return { rows: [] };
    });
    const failedRelease = vi.fn();
    await expect(
      assertPresentationSurfaceRegistryCurrent({
        connect: vi.fn(async () => ({ query: failedQuery, release: failedRelease })),
      } as unknown as Pool),
    ).rejects.toThrow("Presentation surface persistence registry is invalid");
    expect(failedQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(failedRelease).toHaveBeenCalledWith(true);

    await expect(
      assertPresentationSurfaceRegistryCurrent({
        connect: vi.fn(async () => {
          throw new Error("private connection diagnostic");
        }),
      } as unknown as Pool),
    ).rejects.toThrow("Presentation surface persistence registry is invalid");
  });

  it("does not inspect the persistence registry until the shared migration barrier is acquired", async () => {
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_advisory_xact_lock_shared")) await barrier;
      if (text.includes("FROM public.presentation_surface_registry")) {
        return { rows: [{ surface_id: "surface.mission-control" }] };
      }
      return { rows: [] };
    });
    const verification = assertPresentationSurfaceRegistryCurrent(
      {
        connect: vi.fn(async () => ({ query, release: vi.fn() })),
      } as unknown as Pool,
      ["surface.mission-control"],
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      query.mock.calls.some(([text]) => text.includes("FROM public.presentation_surface_registry")),
    ).toBe(false);
    releaseBarrier?.();
    await expect(verification).resolves.toBeUndefined();
  });

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
