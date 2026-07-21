import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  decodeWorkforceControlResponse,
  decodeWorkforceControlState,
  decodeWorkforceProfileMutationResponse,
  type HrWorkforceApiCommand,
} from "./hr-workforce-profile-manage-core";

function request(command: HrWorkforceApiCommand) {
  return fetchDevelopmentApi({
    body: command.body,
    idempotencyKey: command.idempotencyKey,
    method: command.method,
    path: command.path,
  });
}

export function executeWorkforceProfileCommand(command: HrWorkforceApiCommand) {
  return decodeWorkforceProfileMutationResponse(request(command));
}

export function executeWorkforceControlCommand(command: HrWorkforceApiCommand) {
  return decodeWorkforceControlResponse(request(command));
}

export function getWorkforceControlState() {
  return decodeWorkforceControlState(
    fetchDevelopmentApi({
      method: "GET",
      path: "/v1/hr/workforce-profiles/service-control",
    }),
  );
}
