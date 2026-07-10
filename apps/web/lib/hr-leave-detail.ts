import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  buildLeaveRequestDetailPath,
  decodeLeaveRequestDetailResponse,
} from "./hr-leave-detail-core";

export function getLeaveRequestDetail(leaveRequestId: string) {
  return decodeLeaveRequestDetailResponse(
    fetchDevelopmentApi({ method: "GET", path: buildLeaveRequestDetailPath(leaveRequestId) }),
  );
}
