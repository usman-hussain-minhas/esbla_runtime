import "server-only";

import type { UpdatePresentationPreferencesBody } from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import {
  decodePresentationPreferencesResponse,
  decodePresentationPreferencesUpdateResponse,
} from "./presentation-preferences-core";

export function loadOwnPresentationPreferences() {
  return decodePresentationPreferencesResponse(
    fetchDevelopmentApi({
      method: "GET",
      path: "/v1/platform/presentation/preferences",
    }),
  );
}

export function persistOwnPresentationPreferences(
  body: UpdatePresentationPreferencesBody,
  idempotencyKey: string,
) {
  return decodePresentationPreferencesUpdateResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: "/v1/platform/presentation/preferences",
    }),
  );
}
