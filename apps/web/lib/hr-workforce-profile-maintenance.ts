import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  decodeWorkforceMaintenanceApiResponse,
  normalizeWorkforceMaintenanceTarget,
  type WorkforceMaintenanceAction,
} from "./hr-workforce-profile-maintenance-core";

export function executeWorkforceMaintenance(
  rawWorkerProfileId: string,
  action: WorkforceMaintenanceAction,
) {
  const workerProfileId = normalizeWorkforceMaintenanceTarget(rawWorkerProfileId);
  const suffix = action.operation === "status" ? "status" : "reporting-relationships";
  return decodeWorkforceMaintenanceApiResponse(
    fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: "POST",
      path: `/v1/hr/workforce-profiles/${encodeURIComponent(workerProfileId)}/${suffix}`,
    }),
    workerProfileId,
    action,
  );
}
