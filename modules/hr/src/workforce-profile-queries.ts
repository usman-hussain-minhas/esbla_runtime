import {
  type OperationContext,
  PlatformError,
  resolveSetting,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import { HrWorkforceProfileError } from "./workforce-profile-errors.js";
import {
  authorizeTenantAdmin,
  authorizeWorkforceAction,
  mapWorkforceProfileRow,
  requireWorkforceProfileServiceActive,
  WORKFORCE_PROFILE_COLUMNS,
  type WorkforceProfileRow,
} from "./workforce-profile-internal.js";
import { hrWorkforceProfileSettings } from "./workforce-profile-settings.js";
import {
  HR_WORKFORCE_PROFILE_SERVICE_KEY,
  type WorkforceProfile,
  type WorkforceProfileServiceControl,
} from "./workforce-profile-types.js";

export async function getOwnWorkforceProfile(
  pool: Pool,
  context: OperationContext,
): Promise<WorkforceProfile> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceProfileServiceActive(transaction);
      authorizeWorkforceAction(transaction, "hr.workforce.view_own", "own", {}, [
        {
          effect: "allow",
          id: "current_employee_may_request_own_profile",
          matches: (_input, actor) => actor.roleKey === "employee",
        },
      ]);

      const result = await transaction.client.query<WorkforceProfileRow>(
        `SELECT ${WORKFORCE_PROFILE_COLUMNS}
         FROM hr_worker_profiles
         WHERE tenant_id = $1 AND principal_id = $2 AND workforce_status = 'active'
         ORDER BY worker_profile_id ASC
         LIMIT 1`,
        [transaction.context.tenantId, transaction.context.actorPrincipalId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new PlatformError("POLICY_DENIED", "Policy denied access to the requested resource");
      }
      return mapWorkforceProfileRow(row);
    },
    { serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY },
  );
}

interface ServiceControlSourceRow {
  readonly activation_state: "active" | "inactive";
  readonly activation_version: number;
  readonly row_version: number;
  readonly service_key: typeof HR_WORKFORCE_PROFILE_SERVICE_KEY;
  readonly settings_version: number;
  readonly updated_at: string;
}

export async function getWorkforceProfileServiceControl(
  pool: Pool,
  context: OperationContext,
): Promise<WorkforceProfileServiceControl> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      authorizeTenantAdmin(
        transaction,
        "hr.workforce.view_service_control",
        HR_WORKFORCE_PROFILE_SERVICE_KEY,
      );

      await resolveSetting(transaction, hrWorkforceProfileSettings.employeeNumberRequired);
      await resolveSetting(transaction, hrWorkforceProfileSettings.managerVisibility);
      await resolveSetting(transaction, hrWorkforceProfileSettings.unlinkedWorkerCreationAllowed);

      const result = await transaction.client.query<ServiceControlSourceRow>(
        `SELECT service_key, activation_state, activation_version, settings_version,
              row_version,
              to_char(updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM hr_workforce_profile_service_control
       WHERE tenant_id = $1 AND service_key = $2
       ORDER BY service_control_id ASC
       LIMIT 1
       FOR SHARE`,
        [transaction.context.tenantId, HR_WORKFORCE_PROFILE_SERVICE_KEY],
      );
      const source = result.rows[0];
      const activation = transaction.lockedServiceActivation;
      if (!source && !activation) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_NOT_FOUND",
          "Workforce Profile service control is not initialized",
        );
      }
      if (
        !source ||
        !activation ||
        activation.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
        source.service_key !== activation.serviceKey ||
        source.activation_state !== activation.state ||
        source.activation_version !== activation.version
      ) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_STATE_CONFLICT",
          "Workforce Profile service control is not current",
        );
      }

      return {
        activationState: source.activation_state,
        activationVersion: source.activation_version,
        serviceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
        settingsVersion: source.settings_version,
        updatedAt: source.updated_at,
        version: source.row_version,
      };
    },
    { serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY },
  );
}
