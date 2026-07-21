import {
  type OperationContext,
  PlatformError,
  resolveSetting,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import {
  HrWorkforceProfileError,
  workforceInputInvalid,
  workforceProfileConflict,
  workforceProfileNotFound,
  workforceVersionConflict,
} from "./workforce-errors.js";
import {
  assertExpectedVersion,
  authorizeWorkforceAction,
  commandResult,
  isAllowedWorkforceStatusTransition,
  mapWorkforceProfile,
  normalizeEmployeeNumber,
  normalizeWorkforceUuid,
  prepareWorkforceMutation,
  readWorkforceMutationReplay,
  recordWorkforceMutation,
  requireWorkforceServiceActive,
  WORKFORCE_PROFILE_COLUMNS,
  type WorkforceProfileRow,
  workforceTransactionOptions,
} from "./workforce-internal.js";
import { workforceProfileSettings } from "./workforce-settings.js";
import type {
  ChangeWorkforceStatusInput,
  CreateWorkforceProfileInput,
  LinkWorkforcePrincipalInput,
  WorkforceProfileCommandResult,
} from "./workforce-types.js";

function isPostgresCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export async function createWorkforceProfile(
  pool: Pool,
  context: OperationContext,
  input: CreateWorkforceProfileInput,
): Promise<WorkforceProfileCommandResult> {
  const employeeNumber = normalizeEmployeeNumber(input.employeeNumber);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceServiceActive(transaction);
      await authorizeWorkforceAction(transaction, "create_profile", "hr_operator");
      const receipt = await prepareWorkforceMutation(
        transaction,
        "create_profile",
        input.idempotencyKey,
        { employeeNumber },
      );
      const replay = await readWorkforceMutationReplay(transaction, receipt);
      if (replay) return commandResult(replay, true);

      const required = await resolveSetting(
        transaction,
        workforceProfileSettings.employeeNumberRequired,
      );
      const unlinkedAllowed = await resolveSetting(
        transaction,
        workforceProfileSettings.unlinkedWorkerCreationAllowed,
      );
      if (required.value && employeeNumber === null) {
        throw workforceInputInvalid("Employee number is required by tenant policy");
      }
      if (!unlinkedAllowed.value) {
        throw new PlatformError("POLICY_DENIED", "Unlinked worker creation is disabled");
      }

      const inserted = await transaction.client.query<WorkforceProfileRow>(
        `INSERT INTO hr_worker_profiles (tenant_id, employee_number)
         VALUES ($1, $2)
         RETURNING ${WORKFORCE_PROFILE_COLUMNS}`,
        [transaction.context.tenantId, employeeNumber],
      );
      const row = inserted.rows[0];
      if (!row) throw workforceProfileConflict();
      const profile = mapWorkforceProfile(row);
      await recordWorkforceMutation(transaction, receipt, null, null, profile);
      return commandResult(profile, false);
    },
    workforceTransactionOptions,
  );
}

export async function linkWorkforcePrincipal(
  pool: Pool,
  context: OperationContext,
  input: LinkWorkforcePrincipalInput,
): Promise<WorkforceProfileCommandResult> {
  const workerProfileId = normalizeWorkforceUuid(input.workerProfileId, "workerProfileId");
  const principalId = normalizeWorkforceUuid(input.principalId, "principalId");
  assertExpectedVersion(input.expectedVersion);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceServiceActive(transaction);
      await authorizeWorkforceAction(transaction, "link_principal", "hr_operator");
      const receipt = await prepareWorkforceMutation(
        transaction,
        "link_principal",
        input.idempotencyKey,
        { expectedVersion: input.expectedVersion, principalId, workerProfileId },
      );
      const replay = await readWorkforceMutationReplay(transaction, receipt);
      if (replay) return commandResult(replay, true);

      const membership = await transaction.client.query<{ status: string }>(
        `SELECT status FROM memberships
         WHERE tenant_id = $1 AND principal_id = $2
         FOR SHARE`,
        [transaction.context.tenantId, principalId],
      );
      if (membership.rows[0]?.status !== "active") {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PRINCIPAL_INELIGIBLE",
          "Canonical principal is not eligible for linking",
        );
      }
      const selected = await transaction.client.query<WorkforceProfileRow>(
        `SELECT ${WORKFORCE_PROFILE_COLUMNS}
         FROM hr_worker_profiles
         WHERE tenant_id = $1 AND worker_profile_id = $2
         FOR UPDATE`,
        [transaction.context.tenantId, workerProfileId],
      );
      const before = selected.rows[0];
      if (!before) throw workforceProfileNotFound();
      if (before.row_version !== input.expectedVersion) throw workforceVersionConflict();
      if (before.workforce_status !== "draft" || before.principal_linked) {
        throw workforceProfileConflict("Only an unlinked draft Workforce Profile can be linked");
      }
      const updated = await transaction.client
        .query<WorkforceProfileRow>(
          `UPDATE hr_worker_profiles
           SET principal_id = $3, row_version = row_version + 1
           WHERE tenant_id = $1 AND worker_profile_id = $2 AND row_version = $4
           RETURNING ${WORKFORCE_PROFILE_COLUMNS}`,
          [transaction.context.tenantId, workerProfileId, principalId, input.expectedVersion],
        )
        .catch((error: unknown) => {
          if (isPostgresCode(error, "23505")) throw workforceProfileConflict();
          throw error;
        });
      const row = updated.rows[0];
      if (!row) throw workforceVersionConflict();
      const profile = mapWorkforceProfile(row);
      await recordWorkforceMutation(
        transaction,
        receipt,
        before.row_version,
        before.workforce_status,
        profile,
      );
      return commandResult(profile, false);
    },
    workforceTransactionOptions,
  );
}

export async function changeWorkforceStatus(
  pool: Pool,
  context: OperationContext,
  input: ChangeWorkforceStatusInput,
): Promise<WorkforceProfileCommandResult> {
  const workerProfileId = normalizeWorkforceUuid(input.workerProfileId, "workerProfileId");
  assertExpectedVersion(input.expectedVersion);
  if (!["active", "suspended", "terminated"].includes(input.status)) {
    throw workforceInputInvalid("Workforce status target is invalid");
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceServiceActive(transaction);
      await authorizeWorkforceAction(transaction, "change_status", "hr_operator");
      const receipt = await prepareWorkforceMutation(
        transaction,
        "change_status",
        input.idempotencyKey,
        { expectedVersion: input.expectedVersion, status: input.status, workerProfileId },
      );
      const replay = await readWorkforceMutationReplay(transaction, receipt);
      if (replay) return commandResult(replay, true);

      const preliminary = await transaction.client.query<{
        principal_id: string | null;
      }>(
        `SELECT principal_id
         FROM hr_worker_profiles
         WHERE tenant_id = $1 AND worker_profile_id = $2`,
        [transaction.context.tenantId, workerProfileId],
      );
      const observed = preliminary.rows[0];
      if (!observed) throw workforceProfileNotFound();
      if (input.status === "active") {
        if (!observed.principal_id) {
          throw workforceProfileConflict("Active status requires a linked principal");
        }
        const membership = await transaction.client.query<{ status: string }>(
          `SELECT status FROM memberships
           WHERE tenant_id = $1 AND principal_id = $2
           FOR SHARE`,
          [transaction.context.tenantId, observed.principal_id],
        );
        if (membership.rows[0]?.status !== "active") {
          throw new HrWorkforceProfileError(
            "WORKFORCE_PRINCIPAL_INELIGIBLE",
            "Linked principal is not eligible for active status",
          );
        }
      }
      const selected = await transaction.client.query<WorkforceProfileRow>(
        `SELECT ${WORKFORCE_PROFILE_COLUMNS}
         FROM hr_worker_profiles
         WHERE tenant_id = $1 AND worker_profile_id = $2
         FOR UPDATE`,
        [transaction.context.tenantId, workerProfileId],
      );
      const before = selected.rows[0];
      if (!before) throw workforceProfileNotFound();
      if (before.row_version !== input.expectedVersion) throw workforceVersionConflict();
      if (!isAllowedWorkforceStatusTransition(before.workforce_status, input.status)) {
        throw workforceProfileConflict("Workforce status transition is not allowed");
      }

      const updated = await transaction.client.query<WorkforceProfileRow>(
        `UPDATE hr_worker_profiles
         SET workforce_status = $3, row_version = row_version + 1
         WHERE tenant_id = $1 AND worker_profile_id = $2 AND row_version = $4
         RETURNING ${WORKFORCE_PROFILE_COLUMNS}`,
        [transaction.context.tenantId, workerProfileId, input.status, input.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw workforceVersionConflict();
      const profile = mapWorkforceProfile(row);
      await recordWorkforceMutation(
        transaction,
        receipt,
        before.row_version,
        before.workforce_status,
        profile,
      );
      return commandResult(profile, false);
    },
    workforceTransactionOptions,
  );
}
