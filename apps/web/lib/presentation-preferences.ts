import "server-only";

import type {
  ResetPresentationPreferencesBody,
  UpdatePresentationPreferencesBody,
  UpdateTenantPresentationDefaultsBody,
} from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import {
  deriveDevelopmentSessionSubjectScope,
  readDevelopmentSessionConfig,
} from "./development-session-core";
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

export function loadPresentationPreferenceCacheScope(): string {
  return deriveDevelopmentSessionSubjectScope(readDevelopmentSessionConfig(process.env));
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

export function resetOwnPresentationPreferences(
  body: ResetPresentationPreferencesBody,
  idempotencyKey: string,
) {
  return decodePresentationPreferencesUpdateResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: "/v1/platform/presentation/preferences/reset",
    }),
  );
}

export function persistTenantPresentationDefaults(
  body: UpdateTenantPresentationDefaultsBody,
  idempotencyKey: string,
) {
  return decodePresentationPreferencesUpdateResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: "/v1/platform/presentation/tenant-defaults",
    }),
  );
}

export function resetTenantPresentationDefaults(
  body: ResetPresentationPreferencesBody,
  idempotencyKey: string,
) {
  return decodePresentationPreferencesUpdateResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: "/v1/platform/presentation/tenant-defaults/reset",
    }),
  );
}
