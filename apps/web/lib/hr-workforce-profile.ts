import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import { decodeOwnWorkforceProfileResponse } from "./hr-workforce-profile-core";

export function getOwnWorkforceProfileState() {
  return decodeOwnWorkforceProfileResponse(
    fetchDevelopmentApi({ method: "GET", path: "/v1/hr/workforce-profiles/own" }),
  );
}
