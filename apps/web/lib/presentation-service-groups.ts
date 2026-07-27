import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import { decodePresentationServiceGroupDiscoveryResponse } from "./presentation-service-groups-core";

export function loadOwnPresentationServiceGroups() {
  return decodePresentationServiceGroupDiscoveryResponse(
    fetchDevelopmentApi({
      method: "GET",
      path: "/v1/platform/presentation/service-groups",
    }),
  );
}
