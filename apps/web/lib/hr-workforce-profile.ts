import "server-only";

import { createHmac } from "node:crypto";
import { fetchDevelopmentApi } from "./development-session";
import { readDevelopmentSessionConfig } from "./development-session-core";
import {
  decodeWorkforceApiResponse,
  type OwnWorkforceProfileState,
  ownWorkforceProfileStateForError,
  type WorkforceAction,
} from "./hr-workforce-profile-core";

export async function loadOwnWorkforceProfile(): Promise<OwnWorkforceProfileState> {
  try {
    return {
      profile: await decodeWorkforceApiResponse(
        fetchDevelopmentApi({ method: "GET", path: "/v1/hr/workforce-profiles/own" }),
        { operation: "own" },
      ),
      status: "success",
    };
  } catch (error) {
    return ownWorkforceProfileStateForError(error);
  }
}

export function executeWorkforceAction(action: WorkforceAction) {
  if (action.operation === "create") {
    return decodeWorkforceApiResponse(
      fetchDevelopmentApi({
        body: action.body,
        idempotencyKey: action.idempotencyKey,
        method: "POST",
        path: "/v1/hr/workforce-profiles",
      }),
      { employeeNumber: action.body.employeeNumber ?? null, operation: "create" },
    );
  }
  const suffix = action.operation === "link" ? "principal-link" : "status";
  return decodeWorkforceApiResponse(
    fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: "POST",
      path: `/v1/hr/workforce-profiles/${encodeURIComponent(action.workerProfileId)}/${suffix}`,
    }),
    {
      expectedVersion: action.body.expectedVersion,
      operation: action.operation,
      workerProfileId: action.workerProfileId,
    },
  );
}

export function getWorkforceOnboardingStorageKey(): string {
  const session = readDevelopmentSessionConfig(process.env);
  return createHmac("sha256", session.secret)
    .update("esbla-workforce-onboarding-v1\0")
    .update(session.tenantId)
    .update("\0")
    .update(session.principalId)
    .digest("hex");
}
