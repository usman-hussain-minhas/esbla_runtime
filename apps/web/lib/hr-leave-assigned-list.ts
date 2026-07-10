import "server-only";

import type { HrLeaveRequestCursor } from "@esbla/contracts/hr-leave-api";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildAssignedLeaveRequestListPath,
  decodeAssignedLeaveRequestListResponse,
} from "./hr-leave-assigned-list-core";

export function getAssignedLeaveRequests(cursor?: HrLeaveRequestCursor) {
  return decodeAssignedLeaveRequestListResponse(
    fetchDevelopmentApi({ method: "GET", path: buildAssignedLeaveRequestListPath(cursor) }),
  );
}
