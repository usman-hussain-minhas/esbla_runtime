import { type OperationContext, withTenantTransaction } from "@esbla/platform-core";
import type { Pool } from "pg";
import { workforceProfileConflict, workforceProfileNotFound } from "./workforce-errors.js";
import {
  authorizeWorkforceAction,
  mapWorkforceProfile,
  requireWorkforceServiceActive,
  WORKFORCE_PROFILE_COLUMNS,
  type WorkforceProfileRow,
  workforceTransactionOptions,
} from "./workforce-internal.js";
import type { WorkforceProfileView } from "./workforce-types.js";

export async function getOwnWorkforceProfile(
  pool: Pool,
  context: OperationContext,
): Promise<WorkforceProfileView> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceServiceActive(transaction);
      await authorizeWorkforceAction(transaction, "view_own", "employee");
      const result = await transaction.client.query<WorkforceProfileRow>(
        `SELECT ${WORKFORCE_PROFILE_COLUMNS}
         FROM hr_worker_profiles
         WHERE tenant_id = $1 AND principal_id = $2 AND workforce_status = 'active'
         ORDER BY worker_profile_id
         LIMIT 2`,
        [transaction.context.tenantId, transaction.context.actorPrincipalId],
      );
      const row = result.rows[0];
      if (!row) {
        throw workforceProfileNotFound("Active own Workforce Profile was not found");
      }
      if (result.rows.length !== 1) {
        throw workforceProfileConflict("Own Workforce Profile state is ambiguous");
      }
      return mapWorkforceProfile(row);
    },
    workforceTransactionOptions,
  );
}
