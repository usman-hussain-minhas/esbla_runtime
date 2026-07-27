import { describe, expect, it } from "vitest";
import { parseUpdatePresentationPreferencesResponse } from "./platform-presentation-api.js";
import {
  parsePresentationSurfaceLayout,
  parseUpdatePresentationSurfaceOverlayBody,
  parseUpdatePresentationSurfaceOverlayResponse,
  ZEN_V1_SURFACE_CONTRACTS,
} from "./platform-presentation-surface-api.js";

describe("platform presentation surface API contract", () => {
  it("binds two distinct version-one Zen surface bases", () => {
    expect(ZEN_V1_SURFACE_CONTRACTS.map(({ surfaceId }) => surfaceId)).toEqual([
      "surface.mission-control",
      "surface.hr.mission-control",
    ]);
    expect(new Set(ZEN_V1_SURFACE_CONTRACTS.map(({ definitionHash }) => definitionHash)).size).toBe(
      2,
    );
    expect(ZEN_V1_SURFACE_CONTRACTS.every(({ baseVersion }) => baseVersion === 1)).toBe(true);
  });

  it("strictly parses one bounded personal overlay", () => {
    expect(
      parseUpdatePresentationSurfaceOverlayBody({
        expectedVersion: 0,
        placements: [
          {
            column: 2,
            columnSpan: 4,
            instanceId: "mission-control.my-leave",
            row: 5,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
          },
        ],
      }),
    ).toMatchObject({ expectedVersion: 0 });
    expect(() =>
      parseUpdatePresentationSurfaceOverlayBody({
        expectedVersion: 0,
        placements: [],
        unsafe: true,
      }),
    ).toThrow();
  });

  it("rejects a response whose surface binding or placement is not exact", () => {
    expect(() =>
      parsePresentationSurfaceLayout({
        baseDefinitionHash: "0".repeat(64),
        basePlacements: [],
        baseVersion: 1,
        effectivePlacements: [],
        overlayVersion: 0,
        source: "code_default",
        surfaceId: "surface.mission-control",
      }),
    ).toThrow();
    expect(() =>
      parsePresentationSurfaceLayout({
        baseDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
        basePlacements: [
          {
            column: 2,
            columnSpan: 4,
            instanceId: "mission-control.my-leave",
            row: 4,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
          },
        ],
        baseVersion: 1,
        effectivePlacements: [],
        overlayVersion: 0,
        source: "code_default",
        surfaceId: "surface.mission-control",
      }),
    ).toThrow();
  });

  it("accepts an exact capability-filtered empty universal surface without widget topology", () => {
    const base = ZEN_V1_SURFACE_CONTRACTS[0];
    expect(
      parsePresentationSurfaceLayout({
        baseDefinitionHash: base.definitionHash,
        basePlacements: [],
        baseVersion: base.baseVersion,
        effectivePlacements: [],
        overlayVersion: 0,
        source: "code_default",
        surfaceId: base.surfaceId,
      }),
    ).toEqual({
      baseDefinitionHash: base.definitionHash,
      basePlacements: [],
      baseVersion: 1,
      effectivePlacements: [],
      overlayVersion: 0,
      source: "code_default",
      surfaceId: "surface.mission-control",
    });
  });

  it("requires explicit non-billing treatment on an overlay mutation response", () => {
    const base = ZEN_V1_SURFACE_CONTRACTS[0];
    expect(
      parseUpdatePresentationSurfaceOverlayResponse({
        baseDefinitionHash: base.definitionHash,
        basePlacements: base.basePlacements,
        baseVersion: base.baseVersion,
        billingState: "non_billable",
        effectivePlacements: base.basePlacements,
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        overlayVersion: 1,
        replayed: false,
        source: "user_overlay",
        surfaceId: base.surfaceId,
      }),
    ).toMatchObject({ billingState: "non_billable" });
    expect(() =>
      parseUpdatePresentationSurfaceOverlayResponse({
        baseDefinitionHash: base.definitionHash,
        basePlacements: base.basePlacements,
        baseVersion: base.baseVersion,
        effectivePlacements: base.basePlacements,
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        overlayVersion: 1,
        replayed: false,
        source: "user_overlay",
        surfaceId: base.surfaceId,
      }),
    ).toThrow();
  });

  it("requires explicit non-billing treatment on a preference mutation response", () => {
    expect(
      parseUpdatePresentationPreferencesResponse({
        billingState: "non_billable",
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        highContrast: true,
        palette: "dark",
        replayed: false,
        source: "user_override",
        version: 1,
      }),
    ).toMatchObject({ billingState: "non_billable" });
    expect(() =>
      parseUpdatePresentationPreferencesResponse({
        evidenceEventId: "93000000-0000-4000-8000-000000000001",
        highContrast: true,
        palette: "dark",
        replayed: false,
        source: "user_override",
        version: 1,
      }),
    ).toThrow();
  });
});
