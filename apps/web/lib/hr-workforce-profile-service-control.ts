import "server-only";

import type { HrServiceControl } from "@esbla/contracts/hr-service-control-api";
import { fetchDevelopmentApi } from "./development-session";
import {
  decodeWorkforceServiceControlApiResponse,
  type WorkforceServiceControlAction,
  type WorkforceServiceControlFormState,
  workforceServiceControlStateForError,
} from "./hr-workforce-service-control-core";

const serviceControlPath = "/v1/hr/workforce-profiles/service-control";

export type WorkforceServiceControlLoadState =
  | { readonly control: HrServiceControl; readonly status: "success" }
  | (WorkforceServiceControlFormState & { readonly status: "error" });

export async function loadWorkforceProfileServiceControl(): Promise<WorkforceServiceControlLoadState> {
  try {
    return {
      control: await decodeWorkforceServiceControlApiResponse(
        fetchDevelopmentApi({ method: "GET", path: serviceControlPath }),
        { operation: "view" },
      ),
      status: "success",
    };
  } catch (error) {
    return workforceServiceControlStateForError(error);
  }
}

export function executeWorkforceProfileServiceControl(
  before: HrServiceControl | null,
  action: WorkforceServiceControlAction,
) {
  const path =
    action.operation === "configure"
      ? `${serviceControlPath}/settings`
      : `${serviceControlPath}/${action.operation}`;
  return decodeWorkforceServiceControlApiResponse(
    fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: action.operation === "configure" ? "PATCH" : "POST",
      path,
    }),
    { action, before, operation: "mutate" },
  );
}
