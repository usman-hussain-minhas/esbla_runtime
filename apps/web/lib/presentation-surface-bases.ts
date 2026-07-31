import "server-only";

import type {
  RollbackPresentationSurfaceBaseBody,
  UpsertPresentationSurfaceDraftBody,
  ValidatePresentationSurfaceDraftBody,
  ZenV1SurfaceId,
} from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import {
  decodePresentationSurfaceBaseMutationResponse,
  decodePresentationSurfaceBaseWorkspaceResponse,
  decodePresentationSurfaceDraftResponse,
  decodePresentationSurfaceDraftValidationResponse,
} from "./presentation-surface-base-core";

function surfaceBasePath(surfaceId: ZenV1SurfaceId): string {
  return `/v1/platform/studio/surfaces/${encodeURIComponent(surfaceId)}/base`;
}

export function loadTenantPresentationSurfaceBaseWorkspace(surfaceId: ZenV1SurfaceId) {
  return decodePresentationSurfaceBaseWorkspaceResponse(
    fetchDevelopmentApi({
      method: "GET",
      path: surfaceBasePath(surfaceId),
    }),
  );
}

export function persistTenantPresentationSurfaceDraft(
  surfaceId: ZenV1SurfaceId,
  body: UpsertPresentationSurfaceDraftBody,
  idempotencyKey: string,
) {
  return decodePresentationSurfaceDraftResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: `${surfaceBasePath(surfaceId)}/draft`,
    }),
  );
}

export function validateTenantPresentationSurfaceDraft(
  surfaceId: ZenV1SurfaceId,
  body: ValidatePresentationSurfaceDraftBody,
  idempotencyKey: string,
) {
  return decodePresentationSurfaceDraftValidationResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: `${surfaceBasePath(surfaceId)}/validate`,
    }),
  );
}

export function publishTenantPresentationSurfaceDraft(
  surfaceId: ZenV1SurfaceId,
  body: ValidatePresentationSurfaceDraftBody,
  idempotencyKey: string,
) {
  return decodePresentationSurfaceBaseMutationResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: `${surfaceBasePath(surfaceId)}/publish`,
    }),
  );
}

export function rollbackTenantPresentationSurfaceBase(
  surfaceId: ZenV1SurfaceId,
  body: RollbackPresentationSurfaceBaseBody,
  idempotencyKey: string,
) {
  return decodePresentationSurfaceBaseMutationResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: `${surfaceBasePath(surfaceId)}/rollback`,
    }),
  );
}
