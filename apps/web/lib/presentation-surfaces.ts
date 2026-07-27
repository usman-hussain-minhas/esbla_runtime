import "server-only";

import type { UpdatePresentationSurfaceOverlayBody, ZenV1SurfaceId } from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import {
  decodePresentationSurfaceLayoutResponse,
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
