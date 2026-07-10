import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  buildApproveLeaveRequestPath,
  decodeApproveLeaveRequestResponse,
  type HrLeaveApprovalInput,
} from "./hr-leave-approve-core";

export function approveAssignedLeaveRequest(leaveRequestId: string, input: HrLeaveApprovalInput) {
  return decodeApproveLeaveRequestResponse(
    fetchDevelopmentApi({
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      method: "POST",
      path: buildApproveLeaveRequestPath(leaveRequestId),
    }),
    leaveRequestId,
    input.body.expectedVersion,
  );
}
