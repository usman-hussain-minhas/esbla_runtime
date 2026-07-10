import "server-only";

import type { HrLeaveRequestCursor } from "@esbla/contracts/hr-leave-api";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildOwnLeaveRequestListPath,
  decodeOwnLeaveRequestListResponse,
} from "./hr-leave-list-core";

export function getOwnLeaveRequests(cursor?: HrLeaveRequestCursor) {
  return decodeOwnLeaveRequestListResponse(
    fetchDevelopmentApi({ method: "GET", path: buildOwnLeaveRequestListPath(cursor) }),
  );
}
