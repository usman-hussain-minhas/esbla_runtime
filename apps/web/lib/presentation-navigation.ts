import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import { decodePresentationNavigationDiscoveryResponse } from "./presentation-navigation-core";

export function loadOwnPresentationNavigation() {
  return decodePresentationNavigationDiscoveryResponse(
    fetchDevelopmentApi({
      method: "GET",
      path: "/v1/platform/presentation/navigation",
    }),
  );
}
