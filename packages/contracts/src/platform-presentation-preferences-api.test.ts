import { describe, expect, it } from "vitest";
import {
  parsePresentationPreferences,
  parseResetPresentationPreferencesBody,
  parseUpdatePresentationPreferencesBody,
  parseUpdateTenantPresentationDefaultsBody,
} from "./platform-presentation-api.js";

const effective = {
  density: {
    effectiveValue: "compact",
    key: "appearance.density.v1",
    locked: true,
    lockReason: "tenant_density_lock",
    source: "user_global",
    tenantValue: "compact",
    userValue: "comfortable",
  },
  highContrast: {
    effectiveValue: true,
    key: "appearance.high_contrast.v1",
    locked: true,
    lockReason: "tenant_accessibility_floor",
    source: "user_global",
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
    lockReason: "tenant_motion_floor",
    source: "user_global",
    tenantValue: "reduce",
    userValue: "auto",
  },
} as const;

describe("presentation preferences API", () => {
  it("parses the exact four-setting effective snapshot", () => {
    expect(
      parsePresentationPreferences({
        appearance: effective,
        canManageTenantDefaults: true,
        tenantVersion: 3,
        userVersion: 7,
      }),
    ).toEqual({
      appearance: effective,
      canManageTenantDefaults: true,
      tenantVersion: 3,
      userVersion: 7,
    });
  });

  it("requires every own appearance value and exact CAS", () => {
    expect(
      parseUpdatePresentationPreferencesBody({
        density: "comfortable",
        expectedVersion: 7,
        highContrast: true,
        palette: "dark",
        reducedMotion: "reduce",
      }),
    ).toEqual({
      density: "comfortable",
      expectedVersion: 7,
      highContrast: true,
      palette: "dark",
      reducedMotion: "reduce",
    });
    expect(() =>
      parseUpdatePresentationPreferencesBody({
        expectedVersion: 7,
        highContrast: true,
        palette: "dark",
      }),
    ).toThrow();
  });

  it("bounds tenant defaults and accepts only valid accessibility floors", () => {
    expect(
      parseUpdateTenantPresentationDefaultsBody({
        density: "compact",
        expectedVersion: 3,
        highContrast: true,
        lockDensity: true,
        palette: "light",
        reducedMotion: "reduce",
        requireHighContrast: true,
        requireReducedMotion: true,
      }),
    ).toEqual({
      density: "compact",
      expectedVersion: 3,
      highContrast: true,
      lockDensity: true,
      palette: "light",
      reducedMotion: "reduce",
      requireHighContrast: true,
      requireReducedMotion: true,
    });
    expect(() =>
      parseUpdateTenantPresentationDefaultsBody({
        density: "compact",
        expectedVersion: 3,
        highContrast: false,
        lockDensity: false,
        palette: "light",
        reducedMotion: "auto",
        requireHighContrast: true,
        requireReducedMotion: false,
      }),
    ).toThrow();
    expect(() =>
      parseUpdateTenantPresentationDefaultsBody({
        density: "compact",
        expectedVersion: 3,
        highContrast: false,
        lockDensity: false,
        palette: "light",
        reducedMotion: "auto",
        requireHighContrast: false,
        requireReducedMotion: true,
      }),
    ).toThrow();
  });

  it("parses only the exact reset CAS body", () => {
    expect(parseResetPresentationPreferencesBody({ expectedVersion: 8 })).toEqual({
      expectedVersion: 8,
    });
    expect(() =>
      parseResetPresentationPreferencesBody({ expectedVersion: 8, tenant: true }),
    ).toThrow();
  });
});
