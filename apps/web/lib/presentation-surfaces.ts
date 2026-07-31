import "server-only";

import type {
  ResetPresentationSurfaceOverlayBody,
  UpdatePresentationSurfaceOverlayBody,
  ZenV1SurfaceId,
} from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import { resolveResponsivePresentationSurfaceLayout } from "./presentation-layout-core";
import {
  decodePresentationPersonalSurfaceEditorWorkspaceResponse,
  decodePresentationSurfaceLayoutResponse,
  decodePresentationSurfaceOverlayResetResponse,
  decodePresentationSurfaceOverlayUpdateResponse,
} from "./presentation-surfaces-core";

export function loadOwnPresentationSurfaceLayout(surfaceId: ZenV1SurfaceId) {
  return decodePresentationSurfaceLayoutResponse(
    fetchDevelopmentApi({
      method: "GET",
      path: `/v1/platform/presentation/surfaces/${encodeURIComponent(surfaceId)}`,
    }),
  );
}

export function loadOwnPresentationPersonalSurfaceEditorWorkspace(surfaceId: ZenV1SurfaceId) {
  return decodePresentationPersonalSurfaceEditorWorkspaceResponse(
    fetchDevelopmentApi({
      method: "GET",
      path: `/v1/platform/presentation/surfaces/${encodeURIComponent(surfaceId)}/personal-editor`,
    }),
  );
}

export async function loadOwnResponsivePresentationSurfaceLayout(surfaceId: ZenV1SurfaceId) {
  return resolveResponsivePresentationSurfaceLayout(
    await loadOwnPresentationSurfaceLayout(surfaceId),
  );
}

export function persistOwnPresentationSurfaceOverlay(
  surfaceId: ZenV1SurfaceId,
  body: UpdatePresentationSurfaceOverlayBody,
  idempotencyKey: string,
) {
  return decodePresentationSurfaceOverlayUpdateResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: `/v1/platform/presentation/surfaces/${encodeURIComponent(surfaceId)}/overlay`,
    }),
  );
}

export function resetOwnPresentationSurfaceOverlay(
  surfaceId: ZenV1SurfaceId,
  body: ResetPresentationSurfaceOverlayBody,
  idempotencyKey: string,
) {
  return decodePresentationSurfaceOverlayResetResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: `/v1/platform/presentation/surfaces/${encodeURIComponent(surfaceId)}/overlay/reset`,
    }),
  );
}
