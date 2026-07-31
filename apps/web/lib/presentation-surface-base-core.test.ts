import { PRESENTATION_BILLING_STATE, ZEN_V1_SURFACE_CONTRACTS } from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  decodePresentationSurfaceBaseMutationResponse,
  decodePresentationSurfaceBaseWorkspaceResponse,
  decodePresentationSurfaceDraftResponse,
  decodePresentationSurfaceDraftValidationResponse,
  PresentationSurfaceBaseRequestError,
  parsePresentationSurfaceBaseRollbackRequest,
  parsePresentationSurfaceDraftRequest,
  parsePresentationSurfaceDraftValidationRequest,
} from "./presentation-surface-base-core";

const surface = ZEN_V1_SURFACE_CONTRACTS[0];
const evidenceEventId = "93000000-0000-4000-8000-000000000001";
const idempotencyKey = "93000000-0000-4000-8000-000000000002";
const moved = surface.basePlacements.map((placement) => ({
  ...placement,
  row: placement.row + 3,
}));
const versionOne = {
  basedOnVersion: null,
  baseVersion: 1,
  definitionHash: surface.definitionHash,
  placements: surface.basePlacements,
  surfaceId: surface.surfaceId,
};

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(Response.json(body, { status }));
}

describe("presentation tenant-base web boundary", () => {
  it("strictly decodes action-current workspaces and every successful lifecycle result", async () => {
    await expect(
      decodePresentationSurfaceBaseWorkspaceResponse(
        response({
          actions: {
            canDraft: true,
            canPublish: false,
            canRollback: true,
            canValidate: true,
          },
          currentBase: versionOne,
          draft: null,
          headRowVersion: 1,
          history: [versionOne],
        }),
      ),
    ).resolves.toMatchObject({
      actions: { canDraft: true, canPublish: false },
      currentBase: { baseVersion: 1 },
    });
    await expect(
      decodePresentationSurfaceDraftResponse(
        response({
          billingState: PRESENTATION_BILLING_STATE,
          draft: {
            basedOnVersion: 1,
            candidateBaseVersion: 2,
            definitionHash: surface.definitionHash,
            draftVersion: 1,
            placements: moved,
            surfaceId: surface.surfaceId,
          },
          evidenceEventId,
          headRowVersion: 1,
          replayed: false,
        }),
      ),
    ).resolves.toMatchObject({
      draft: { draftVersion: 1 },
      headRowVersion: 1,
      replayed: false,
    });
    await expect(
      decodePresentationSurfaceDraftValidationResponse(
        response({
          billingState: PRESENTATION_BILLING_STATE,
          diagnostics: [],
          draftVersion: 1,
          headRowVersion: 1,
          preview: moved,
          valid: true,
        }),
      ),
    ).resolves.toMatchObject({ draftVersion: 1, valid: true });
    await expect(
      decodePresentationSurfaceBaseMutationResponse(
        response({
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
      ),
    ).resolves.toMatchObject({ baseVersion: 2, headRowVersion: 2 });
  });

  it("classifies only strict Problem Details and treats malformed success as unavailable", async () => {
    await expect(
      decodePresentationSurfaceBaseWorkspaceResponse(
        response(
          {
            code: "POLICY_DENIED",
            detail: "Denied",
            instance: "/v1/platform/studio/surfaces/surface.mission-control/base",
            requestId: "request-1",
            status: 403,
            title: "Forbidden",
            type: "urn:esbla:problem:policy_denied",
          },
          403,
        ),
      ),
    ).rejects.toMatchObject({
      kind: "forbidden",
    } satisfies Partial<PresentationSurfaceBaseRequestError>);
    await expect(
      decodePresentationSurfaceDraftResponse(response({ draft: "unsafe" })),
    ).rejects.toMatchObject({
      kind: "unavailable",
    } satisfies Partial<PresentationSurfaceBaseRequestError>);
    await expect(
      decodePresentationSurfaceBaseMutationResponse(
        Promise.reject(new Error("private upstream detail")),
      ),
    ).rejects.toMatchObject({
      kind: "unavailable",
      message: "Presentation surface base is unavailable",
    } satisfies Partial<PresentationSurfaceBaseRequestError>);
  });

  it("strictly separates draft, validation and rollback browser requests", () => {
    expect(
      parsePresentationSurfaceDraftRequest({
        expectedDraftVersion: 0,
        expectedHeadRowVersion: 1,
        idempotencyKey,
        placements: moved,
      }),
    ).toMatchObject({ expectedDraftVersion: 0, idempotencyKey });
    expect(
      parsePresentationSurfaceDraftValidationRequest({
        expectedDraftVersion: 1,
        expectedHeadRowVersion: 1,
        idempotencyKey,
      }),
    ).toEqual({
      expectedDraftVersion: 1,
      expectedHeadRowVersion: 1,
      idempotencyKey,
    });
    expect(
      parsePresentationSurfaceBaseRollbackRequest({
        expectedHeadRowVersion: 2,
        idempotencyKey,
        sourceBaseVersion: 1,
      }),
    ).toEqual({ expectedHeadRowVersion: 2, idempotencyKey, sourceBaseVersion: 1 });
    expect(() =>
      parsePresentationSurfaceDraftValidationRequest({
        expectedDraftVersion: 1,
        expectedHeadRowVersion: 1,
        idempotencyKey,
        operation: "publish",
      }),
    ).toThrow(PresentationSurfaceBaseRequestError);
  });
});
