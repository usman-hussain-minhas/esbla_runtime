import { describe, expect, it } from "vitest";
import {
  decodePresentationPreferencesResponse,
  isSameOriginPresentationRequest,
  PresentationPreferencesError,
  parsePresentationPreferencesReset,
  parsePresentationPreferencesUpdate,
  parseTenantPresentationDefaultsUpdate,
} from "./presentation-preferences-core";

describe("presentation preference web boundary", () => {
  it("accepts exact successful preferences and rejects non-200 success-like bodies", async () => {
    const preferences = {
      appearance: {
        density: {
          effectiveValue: "compact",
          key: "appearance.density.v1",
          locked: false,
          lockReason: null,
          source: "user_global",
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
      },
      canManageTenantDefaults: false,
      tenantVersion: 3,
      userVersion: 2,
    } as const;
    await expect(
      decodePresentationPreferencesResponse(Promise.resolve(Response.json(preferences))),
    ).resolves.toEqual(preferences);
    await expect(
      decodePresentationPreferencesResponse(Promise.resolve(new Response("{}", { status: 201 }))),
    ).rejects.toBeInstanceOf(PresentationPreferencesError);
  });

  it("requires an exact bounded update and UUID idempotency key", () => {
    expect(
      parsePresentationPreferencesUpdate({
        density: "comfortable",
        expectedVersion: 0,
        highContrast: false,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
        palette: "light",
        reducedMotion: "auto",
      }),
    ).toEqual({
      density: "comfortable",
      expectedVersion: 0,
      highContrast: false,
      idempotencyKey: "93000000-0000-4000-8000-000000000001",
      palette: "light",
      reducedMotion: "auto",
    });
    expect(() =>
      parsePresentationPreferencesUpdate({
        density: "comfortable",
        expectedVersion: 0,
        highContrast: "high-contrast",
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
        palette: "light",
        reducedMotion: "auto",
      }),
    ).toThrow();
    expect(() =>
      parsePresentationPreferencesUpdate({
        density: "comfortable",
        expectedVersion: 0,
        extra: true,
        highContrast: false,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
        palette: "light",
        reducedMotion: "auto",
      }),
    ).toThrow();
  });

  it("parses only exact tenant-floor and reset mutations", () => {
    expect(
      parseTenantPresentationDefaultsUpdate({
        density: "comfortable",
        expectedVersion: 0,
        highContrast: true,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
        lockDensity: true,
        palette: "light",
        reducedMotion: "reduce",
        requireHighContrast: true,
        requireReducedMotion: true,
      }),
    ).toMatchObject({
      density: "comfortable",
      expectedVersion: 0,
      lockDensity: true,
      requireHighContrast: true,
      requireReducedMotion: true,
    });
    expect(
      parsePresentationPreferencesReset({
        expectedVersion: 2,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      expectedVersion: 2,
      idempotencyKey: "93000000-0000-4000-8000-000000000001",
    });
    expect(() =>
      parsePresentationPreferencesReset({
        expectedVersion: 0,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("accepts the verified forwarded Host origin used by the built Next server", () => {
    expect(
      isSameOriginPresentationRequest(
        new Request("http://localhost:3000/presentation/preferences", {
          headers: {
            host: "127.0.0.1:41901",
            origin: "http://127.0.0.1:41901",
            "sec-fetch-site": "same-origin",
          },
          method: "POST",
        }),
      ),
    ).toBe(true);
  });
});
