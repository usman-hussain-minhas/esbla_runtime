import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import type { HrLeaveSubmissionInput } from "./hr-leave-submit-core";
import { decodeSubmitLeaveRequestResponse } from "./hr-leave-submit-core";

export function submitOwnLeaveRequest(input: HrLeaveSubmissionInput) {
  return decodeSubmitLeaveRequestResponse(
    fetchDevelopmentApi({
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      method: "POST",
      path: "/v1/hr/leave-requests",
    }),
  );
}
