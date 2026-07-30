import { describe, expect, it } from "vitest";
import { PRESENTATION_BILLING_STATE } from "./platform-presentation-api.js";
import { ZEN_V1_SURFACE_CONTRACTS } from "./platform-presentation-surface-api.js";
import {
  parsePresentationSurfaceBaseMutationResponse,
  parsePresentationSurfaceBaseVersion,
  parsePresentationSurfaceBaseWorkspace,
  parsePresentationSurfaceDraft,
  parseResetPresentationSurfaceOverlayBody,
  parseResetPresentationSurfaceOverlayResponse,
  parseRollbackPresentationSurfaceBaseBody,
  parseUpsertPresentationSurfaceDraftBody,
  parseUpsertPresentationSurfaceDraftResponse,
  parseValidatePresentationSurfaceDraftBody,
  parseValidatePresentationSurfaceDraftResponse,
} from "./platform-studio-surface-base-api.js";

const surface = ZEN_V1_SURFACE_CONTRACTS[0];
const moved = surface.basePlacements.map((placement) => ({
  ...placement,
  row: placement.row + 3,
}));
const evidenceEventId = "93000000-0000-4000-8000-000000000001";

describe("platform Studio surface-base API contract", () => {
  it("strictly binds immutable version lineage and one exact draft", () => {
    const version = parsePresentationSurfaceBaseVersion({
      basedOnVersion: 1,
      baseVersion: 2,
      definitionHash: surface.definitionHash,
      placements: moved,
      surfaceId: surface.surfaceId,
    });
    const draft = parsePresentationSurfaceDraft({
      basedOnVersion: 1,
      candidateBaseVersion: 2,
      definitionHash: surface.definitionHash,
      draftVersion: 1,
      placements: moved,
      surfaceId: surface.surfaceId,
    });
    expect(version).toMatchObject({ basedOnVersion: 1, baseVersion: 2 });
    expect(draft).toMatchObject({ candidateBaseVersion: 2, draftVersion: 1 });
    expect(() =>
      parsePresentationSurfaceBaseVersion({
        ...version,
        basedOnVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      parsePresentationSurfaceDraft({
        ...draft,
        candidateBaseVersion: 3,
      }),
    ).toThrow();
  });

  it("requires descending same-surface history and an exact-head draft", () => {
    expect(
      parsePresentationSurfaceBaseWorkspace({
        currentBase: {
          basedOnVersion: 1,
          baseVersion: 2,
          definitionHash: surface.definitionHash,
          placements: moved,
          surfaceId: surface.surfaceId,
        },
        draft: null,
        headRowVersion: 2,
        history: [
          {
            basedOnVersion: 1,
            baseVersion: 2,
            definitionHash: surface.definitionHash,
            placements: moved,
            surfaceId: surface.surfaceId,
          },
          {
            basedOnVersion: null,
            baseVersion: 1,
            definitionHash: surface.definitionHash,
            placements: surface.basePlacements,
            surfaceId: surface.surfaceId,
          },
        ],
      }),
    ).toMatchObject({ headRowVersion: 2 });
    expect(() =>
      parsePresentationSurfaceBaseWorkspace({
        currentBase: {
          basedOnVersion: 1,
          baseVersion: 2,
          definitionHash: surface.definitionHash,
          placements: moved,
          surfaceId: surface.surfaceId,
        },
        draft: null,
        headRowVersion: 2,
        history: [],
      }),
    ).toThrow();
  });

  it("strictly parses every compare-and-swap input", () => {
    expect(
      parseUpsertPresentationSurfaceDraftBody({
        expectedDraftVersion: 0,
        expectedHeadRowVersion: 1,
        placements: moved,
      }),
    ).toMatchObject({ expectedDraftVersion: 0, expectedHeadRowVersion: 1 });
    expect(
      parseValidatePresentationSurfaceDraftBody({
        expectedDraftVersion: 1,
        expectedHeadRowVersion: 1,
      }),
    ).toEqual({ expectedDraftVersion: 1, expectedHeadRowVersion: 1 });
    expect(
      parseRollbackPresentationSurfaceBaseBody({
        expectedHeadRowVersion: 2,
        sourceBaseVersion: 1,
      }),
    ).toEqual({ expectedHeadRowVersion: 2, sourceBaseVersion: 1 });
    expect(parseResetPresentationSurfaceOverlayBody({ expectedVersion: 2 })).toEqual({
      expectedVersion: 2,
    });
    expect(() =>
      parseUpsertPresentationSurfaceDraftBody({
        expectedDraftVersion: 0,
        expectedHeadRowVersion: 1,
        placements: moved,
        unsafe: true,
      }),
    ).toThrow();
  });

  it("requires explicit non-billing evidence on every mutation response", () => {
    const draft = {
      basedOnVersion: 1,
      candidateBaseVersion: 2,
      definitionHash: surface.definitionHash,
      draftVersion: 1,
      placements: moved,
      surfaceId: surface.surfaceId,
    };
    expect(
      parseUpsertPresentationSurfaceDraftResponse({
        billingState: PRESENTATION_BILLING_STATE,
        draft,
        evidenceEventId,
        replayed: false,
      }),
    ).toMatchObject({ billingState: "non_billable", replayed: false });
    expect(
      parsePresentationSurfaceBaseMutationResponse({
        basedOnVersion: 1,
        baseVersion: 2,
        billingState: PRESENTATION_BILLING_STATE,
        definitionHash: surface.definitionHash,
        evidenceEventId,
        headRowVersion: 2,
        placements: moved,
        replayed: false,
        surfaceId: surface.surfaceId,
      }),
    ).toMatchObject({ baseVersion: 2, headRowVersion: 2 });
    expect(() =>
      parseUpsertPresentationSurfaceDraftResponse({
        draft,
        evidenceEventId,
        replayed: false,
      }),
    ).toThrow();
  });

  it("keeps validation read-only and parses a tenant-base reset result", () => {
    expect(
      parseValidatePresentationSurfaceDraftResponse({
        billingState: PRESENTATION_BILLING_STATE,
        diagnostics: [],
        draftVersion: 1,
        headRowVersion: 1,
        preview: moved,
        valid: true,
      }),
    ).toMatchObject({ diagnostics: [], valid: true });
    expect(
      parseResetPresentationSurfaceOverlayResponse({
        baseDefinitionHash: surface.definitionHash,
        basePlacements: moved,
        baseVersion: 2,
        billingState: PRESENTATION_BILLING_STATE,
        diagnostics: [],
        effectivePlacements: moved,
        evidenceEventId,
        overlayVersion: 0,
        replayed: false,
        source: "tenant_base",
        surfaceId: surface.surfaceId,
      }),
    ).toMatchObject({ baseVersion: 2, source: "tenant_base" });
  });
});
