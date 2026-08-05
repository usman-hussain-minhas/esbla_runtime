import { describe, expect, it } from "vitest";
import {
  deriveTenantPresentationDraft,
  parseUniversalSettingsUpdate,
  shouldNotifyUniversalSettingsUpdate,
} from "./universal-settings-core";

const scope = "ypeBEsobvcr6wjGzmiPcTaeG7_gUfE5yuYB3ha_uSLs";
const sourceTabId = "10000000-0000-4000-8000-000000000001";

describe("Universal Settings cross-tab updates", () => {
  it("accepts only the exact non-sensitive update envelope", () => {
    const update = {
      mutationId: "20000000-0000-4000-8000-000000000001",
      schemaVersion: 1,
      scope,
      sourceTabId,
      subject: "appearance",
    } as const;

    expect(parseUniversalSettingsUpdate(update)).toEqual(update);
    expect(() => parseUniversalSettingsUpdate({ ...update, tenantId: "private" })).toThrow();
    expect(() => parseUniversalSettingsUpdate({ ...update, scope: "tenant-a" })).toThrow();
    expect(() => parseUniversalSettingsUpdate({ ...update, subject: "unknown" })).toThrow();
    expect(() => parseUniversalSettingsUpdate({ ...update, sourceTabId: "not-a-uuid" })).toThrow();
    for (const subject of [
      "surface.mission-control",
      "surface.hr.mission-control",
      "surface.hr.workforce",
      "surface.hr.time-and-scheduling",
      "surface.hr.requests-and-claims",
    ]) {
      expect(parseUniversalSettingsUpdate({ ...update, subject }).subject).toBe(subject);
    }
  });

  it("notifies only another tab in the exact server-derived subject scope", () => {
    const update = parseUniversalSettingsUpdate({
      mutationId: "20000000-0000-4000-8000-000000000001",
      schemaVersion: 1,
      scope,
      sourceTabId,
      subject: "surface.hr.mission-control",
    });

    expect(
      shouldNotifyUniversalSettingsUpdate(update, {
        cacheScope: scope,
        sourceTabId: "10000000-0000-4000-8000-000000000002",
      }),
    ).toBe(true);
    expect(
      shouldNotifyUniversalSettingsUpdate(update, {
        cacheScope: scope,
        sourceTabId,
      }),
    ).toBe(false);
    expect(
      shouldNotifyUniversalSettingsUpdate(update, {
        cacheScope: "PiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0",
        sourceTabId: "10000000-0000-4000-8000-000000000002",
      }),
    ).toBe(false);
    expect(
      shouldNotifyUniversalSettingsUpdate(update, {
        cacheScope: null,
        sourceTabId: "10000000-0000-4000-8000-000000000002",
      }),
    ).toBe(false);
  });
});

describe("Universal Settings tenant draft", () => {
  it("uses code-owned Product defaults instead of promoting an admin's personal values", () => {
    expect(
      deriveTenantPresentationDraft({
        appearance: {
          density: {
            effectiveValue: "compact",
            key: "appearance.density.v1",
            locked: false,
            lockReason: null,
            source: "user_global",
            tenantValue: null,
            userValue: "compact",
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
            effectiveValue: "reduce",
            key: "appearance.reduced_motion.v1",
            locked: false,
            lockReason: null,
            source: "user_global",
            tenantValue: null,
            userValue: "reduce",
          },
        },
        canManageTenantDefaults: true,
        tenantVersion: 0,
        userVersion: 1,
      }),
    ).toEqual({
      density: "comfortable",
      highContrast: false,
      lockDensity: false,
      palette: "light",
      reducedMotion: "auto",
      requireHighContrast: false,
      requireReducedMotion: false,
    });
  });

  it("preserves explicit tenant values and their independent floors", () => {
    expect(
      deriveTenantPresentationDraft({
        appearance: {
          density: {
            effectiveValue: "compact",
            key: "appearance.density.v1",
            locked: true,
            lockReason: "tenant_density_lock",
            source: "tenant_global",
            tenantValue: "compact",
            userValue: null,
          },
          highContrast: {
            effectiveValue: true,
            key: "appearance.high_contrast.v1",
            locked: true,
            lockReason: "accessibility_high_contrast_floor",
            source: "tenant_global",
            tenantValue: false,
            userValue: null,
          },
          palette: {
            effectiveValue: "dark",
            key: "appearance.palette.v1",
            locked: false,
            lockReason: null,
            source: "tenant_global",
            tenantValue: "dark",
            userValue: null,
          },
          reducedMotion: {
            effectiveValue: "reduce",
            key: "appearance.reduced_motion.v1",
            locked: true,
            lockReason: "motion_reduction_floor",
            source: "tenant_global",
            tenantValue: "auto",
            userValue: null,
          },
        },
        canManageTenantDefaults: true,
        tenantVersion: 3,
        userVersion: 0,
      }),
    ).toEqual({
      density: "compact",
      highContrast: false,
      lockDensity: true,
      palette: "dark",
      reducedMotion: "auto",
      requireHighContrast: true,
      requireReducedMotion: true,
    });
  });
});
