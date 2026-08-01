import "server-only";

import type {
  PresentationShortcutDiscoveryQuery,
  UpdatePresentationShortcutBody,
} from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildPresentationShortcutsPath,
  decodePresentationShortcutDiscoveryResponse,
  decodePresentationShortcutUpdateResponse,
} from "./presentation-shortcuts-core";

export function loadOwnPresentationShortcuts(query: PresentationShortcutDiscoveryQuery = {}) {
  return decodePresentationShortcutDiscoveryResponse(
    fetchDevelopmentApi({
      method: "GET",
      path: buildPresentationShortcutsPath(query),
    }),
  );
}

export function persistOwnPresentationShortcut(
  body: UpdatePresentationShortcutBody,
  idempotencyKey: string,
) {
  return decodePresentationShortcutUpdateResponse(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: "/v1/platform/presentation/shortcuts",
    }),
  );
}
