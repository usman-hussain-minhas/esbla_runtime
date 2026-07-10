import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  buildRejectLeaveRequestPath,
  decodeRejectLeaveRequestResponse,
  type HrLeaveRejectionInput,
} from "./hr-leave-reject-core";

export function rejectAssignedLeaveRequest(leaveRequestId: string, input: HrLeaveRejectionInput) {
  const decisionNote = input.body.decisionNote ?? null;
  return decodeRejectLeaveRequestResponse(
    fetchDevelopmentApi({
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      method: "POST",
      path: buildRejectLeaveRequestPath(leaveRequestId),
    }),
    leaveRequestId,
    input.body.expectedVersion,
    decisionNote,
  );
}
