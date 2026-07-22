import {
  type OperationContext,
  PlatformError,
  resolveSetting,
  type TenantTransaction,
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
  mapWorkforceReportingRelationship,
  normalizeEmployeeNumber,
  normalizeWorkforceUuid,
  prepareWorkforceMutation,
  prepareWorkforceReportingMutation,
  readWorkforceMutationReplay,
  readWorkforceReportingMutationReplay,
  recordWorkforceMutation,
  recordWorkforceReportingMutation,
  reportingCommandResult,
  requireWorkforceServiceActive,
  WORKFORCE_PROFILE_COLUMNS,
  type WorkforceProfileRow,
  type WorkforceReportingRelationshipRow,
  workforceTransactionOptions,
} from "./workforce-internal.js";
import { workforceProfileSettings } from "./workforce-settings.js";
import type {
  ChangeWorkforceReportingRelationshipInput,
  ChangeWorkforceStatusInput,
  CreateWorkforceProfileInput,
  LinkWorkforcePrincipalInput,
  WorkforceProfileCommandResult,
  WorkforceReportingRelationshipCommandResult,
} from "./workforce-types.js";

function isPostgresCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

interface ReportingProfileRow {
  readonly current_reporting_relationship_id: string | null;
  readonly principal_id: string | null;
  readonly row_version: number;
  readonly worker_profile_id: string;
  readonly workforce_status: string;
}

interface ReportingCurrentRow extends ReportingProfileRow {
  readonly current_manager_worker_profile_id: string | null;
  readonly current_relationship_status: "assigned" | "unassigned" | null;
  readonly current_relationship_version: number | null;
}

interface ReportingChainRow {
  readonly current_reporting_relationship_id: string | null;
  readonly cycle: boolean;
  readonly manager_worker_profile_id: string | null;
  readonly relationship_version: number | null;
  readonly worker_profile_id: string;
}

async function readReportingCurrent(
  transaction: TenantTransaction,
  workerProfileId: string,
): Promise<ReportingCurrentRow | null> {
  const selected = await transaction.client.query<ReportingCurrentRow>(
    `SELECT profile.worker_profile_id, profile.principal_id, profile.workforce_status,
            profile.current_reporting_relationship_id, profile.row_version,
            relationship.manager_worker_profile_id current_manager_worker_profile_id,
            relationship.relationship_status current_relationship_status,
            relationship.relationship_version current_relationship_version
     FROM hr_worker_profiles profile
     LEFT JOIN hr_reporting_relationships relationship
       ON relationship.tenant_id=profile.tenant_id
      AND relationship.worker_profile_id=profile.worker_profile_id
      AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
     WHERE profile.tenant_id=$1 AND profile.worker_profile_id=$2`,
    [transaction.context.tenantId, workerProfileId],
  );
  return selected.rows[0] ?? null;
}

async function readReportingChain(
  transaction: TenantTransaction,
  workerProfileId: string,
): Promise<ReportingChainRow[]> {
  const selected = await transaction.client.query<ReportingChainRow>(
    `WITH RECURSIVE reporting_chain AS (
       SELECT profile.worker_profile_id, profile.current_reporting_relationship_id,
              CASE WHEN relationship.relationship_status='assigned'
                   THEN relationship.manager_worker_profile_id ELSE NULL::uuid END manager_worker_profile_id,
              relationship.relationship_version,
              ARRAY[profile.worker_profile_id]::uuid[] path, false cycle, 1 depth
       FROM hr_worker_profiles profile
       LEFT JOIN hr_reporting_relationships relationship
         ON relationship.tenant_id=profile.tenant_id
        AND relationship.worker_profile_id=profile.worker_profile_id
        AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
       WHERE profile.tenant_id=$1 AND profile.worker_profile_id=$2
       UNION ALL
       SELECT manager.worker_profile_id, manager.current_reporting_relationship_id,
              CASE WHEN relationship.relationship_status='assigned'
                   THEN relationship.manager_worker_profile_id ELSE NULL::uuid END,
              relationship.relationship_version,
              chain.path || manager.worker_profile_id,
              manager.worker_profile_id=ANY(chain.path), chain.depth+1
       FROM reporting_chain chain
       JOIN hr_worker_profiles manager
         ON manager.tenant_id=$1 AND manager.worker_profile_id=chain.manager_worker_profile_id
       LEFT JOIN hr_reporting_relationships relationship
         ON relationship.tenant_id=manager.tenant_id
        AND relationship.worker_profile_id=manager.worker_profile_id
        AND relationship.reporting_relationship_id=manager.current_reporting_relationship_id
       WHERE chain.manager_worker_profile_id IS NOT NULL AND NOT chain.cycle
     )
     SELECT worker_profile_id, current_reporting_relationship_id,
            manager_worker_profile_id, relationship_version, cycle
     FROM reporting_chain ORDER BY depth`,
    [transaction.context.tenantId, workerProfileId],
  );
  return selected.rows;
}

function reportingChainSignature(rows: readonly ReportingChainRow[]): string {
  return JSON.stringify(
    rows.map(
      ({
        current_reporting_relationship_id,
        cycle,
        manager_worker_profile_id,
        relationship_version,
        worker_profile_id,
      }) => [
        worker_profile_id,
        current_reporting_relationship_id,
        manager_worker_profile_id,
        relationship_version,
        cycle,
      ],
    ),
  );
}

function translateReportingWriteError(error: unknown): never {
  if (
    isPostgresCode(error, "23505") ||
    isPostgresCode(error, "40001") ||
    isPostgresCode(error, "40P01") ||
    isPostgresCode(error, "55P03")
  ) {
    throw workforceVersionConflict();
  }
  if (isPostgresCode(error, "55000")) {
    throw workforceProfileConflict("Reporting Relationship state conflicts with the request");
  }
  throw error;
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

export async function changeWorkforceReportingRelationship(
  pool: Pool,
  context: OperationContext,
  input: ChangeWorkforceReportingRelationshipInput,
): Promise<WorkforceReportingRelationshipCommandResult> {
  const workerProfileId = normalizeWorkforceUuid(input.workerProfileId, "workerProfileId");
  assertExpectedVersion(input.expectedVersion);
  if (!(["assigned", "unassigned"] as readonly unknown[]).includes(input.relationshipStatus)) {
    throw workforceInputInvalid("Reporting relationship status is invalid");
  }
  if (
    (input.relationshipStatus === "assigned") !==
    (typeof input.managerWorkerProfileId === "string")
  ) {
    throw workforceInputInvalid("Reporting relationship manager and status conflict");
  }
  const managerWorkerProfileId =
    input.managerWorkerProfileId === null
      ? null
      : normalizeWorkforceUuid(input.managerWorkerProfileId, "managerWorkerProfileId");
  try {
    return await withTenantTransaction(
      pool,
      context,
      async (transaction) => {
        requireWorkforceServiceActive(transaction);
        await authorizeWorkforceAction(transaction, "change_reporting_relationship", "hr_operator");
        const receipt = await prepareWorkforceReportingMutation(transaction, input.idempotencyKey, {
          expectedVersion: input.expectedVersion,
          managerWorkerProfileId,
          relationshipStatus: input.relationshipStatus,
          workerProfileId,
        });
        const replay = await readWorkforceReportingMutationReplay(transaction, receipt);
        if (replay) return reportingCommandResult(replay, true);

        await transaction.client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))",
          [`hr.workforce.reporting_graph.v1:${transaction.context.tenantId}`],
        );
        const preliminary = await readReportingCurrent(transaction, workerProfileId);
        if (!preliminary) throw workforceProfileNotFound();
        if (
          preliminary.current_reporting_relationship_id !== null &&
          (preliminary.current_relationship_status === null ||
            preliminary.current_relationship_version === null)
        ) {
          throw workforceProfileConflict("Reporting Relationship head is invalid");
        }
        const preliminaryChain = managerWorkerProfileId
          ? await readReportingChain(transaction, managerWorkerProfileId)
          : [];
        if (managerWorkerProfileId && preliminaryChain.length === 0) {
          throw workforceProfileNotFound("Manager Workforce Profile was not found");
        }
        const profileIds = new Set<string>([workerProfileId]);
        if (preliminary.current_manager_worker_profile_id) {
          profileIds.add(preliminary.current_manager_worker_profile_id);
        }
        for (const row of preliminaryChain) {
          profileIds.add(row.worker_profile_id);
          if (row.manager_worker_profile_id) profileIds.add(row.manager_worker_profile_id);
        }
        const orderedProfileIds = [...profileIds].sort();
        const locked = await transaction.client.query<ReportingProfileRow>(
          `SELECT worker_profile_id, principal_id, workforce_status,
                  current_reporting_relationship_id, row_version
           FROM hr_worker_profiles
           WHERE tenant_id=$1 AND worker_profile_id=ANY($2::uuid[])
           ORDER BY worker_profile_id FOR UPDATE`,
          [transaction.context.tenantId, orderedProfileIds],
        );
        if (locked.rows.length !== orderedProfileIds.length) throw workforceProfileNotFound();
        const profiles = new Map(locked.rows.map((row) => [row.worker_profile_id, row]));
        const report = profiles.get(workerProfileId);
        if (!report) throw workforceProfileNotFound();
        const current = await readReportingCurrent(transaction, workerProfileId);
        const lockedChain = managerWorkerProfileId
          ? await readReportingChain(transaction, managerWorkerProfileId)
          : [];
        if (
          !current ||
          current.current_reporting_relationship_id !==
            preliminary.current_reporting_relationship_id ||
          current.row_version !== preliminary.row_version ||
          reportingChainSignature(lockedChain) !== reportingChainSignature(preliminaryChain)
        ) {
          throw workforceVersionConflict();
        }
        if (report.workforce_status !== "active") {
          throw workforceProfileConflict("Report Workforce Profile must be active");
        }
        if (report.row_version !== input.expectedVersion) throw workforceVersionConflict();
        if (
          (input.relationshipStatus === "unassigned" &&
            (current.current_reporting_relationship_id === null ||
              current.current_relationship_status === "unassigned")) ||
          (input.relationshipStatus === "assigned" &&
            current.current_relationship_status === "assigned" &&
            current.current_manager_worker_profile_id === managerWorkerProfileId)
        ) {
          throw workforceProfileConflict("Reporting relationship already has the requested state");
        }
        if (
          lockedChain.some(
            ({ cycle, worker_profile_id }) => cycle || worker_profile_id === workerProfileId,
          )
        ) {
          throw workforceProfileConflict("Reporting relationship would create a cycle");
        }
        if (managerWorkerProfileId) {
          const manager = profiles.get(managerWorkerProfileId);
          if (!manager) throw workforceProfileNotFound("Manager Workforce Profile was not found");
          if (manager.workforce_status !== "active" || !manager.principal_id) {
            throw workforceProfileConflict("Manager Workforce Profile must be active and linked");
          }
          const membership = await transaction.client.query<{ role_key: string; status: string }>(
            `SELECT role_key, status FROM memberships
             WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE`,
            [transaction.context.tenantId, manager.principal_id],
          );
          if (
            membership.rows[0]?.status !== "active" ||
            membership.rows[0]?.role_key !== "manager"
          ) {
            throw workforceProfileConflict("Manager membership is not current");
          }
        }
        const priorRelationshipVersion = current.current_relationship_version;
        const relationshipVersion = (priorRelationshipVersion ?? 0) + 1;
        const inserted = await transaction.client.query<WorkforceReportingRelationshipRow>(
          `INSERT INTO hr_reporting_relationships
             (tenant_id, worker_profile_id, manager_worker_profile_id, relationship_status,
              supersedes_reporting_relationship_id, relationship_version)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING reporting_relationship_id, worker_profile_id, manager_worker_profile_id,
                     relationship_status, effective_at, supersedes_reporting_relationship_id,
                     relationship_version`,
          [
            transaction.context.tenantId,
            workerProfileId,
            managerWorkerProfileId,
            input.relationshipStatus,
            current.current_reporting_relationship_id,
            relationshipVersion,
          ],
        );
        const relationshipRow = inserted.rows[0];
        if (!relationshipRow) throw workforceProfileConflict();
        const advanced = await transaction.client.query<{ row_version: number }>(
          `UPDATE hr_worker_profiles
           SET current_reporting_relationship_id=$3, row_version=row_version+1
           WHERE tenant_id=$1 AND worker_profile_id=$2 AND row_version=$4
             AND current_reporting_relationship_id IS NOT DISTINCT FROM $5
           RETURNING row_version`,
          [
            transaction.context.tenantId,
            workerProfileId,
            relationshipRow.reporting_relationship_id,
            input.expectedVersion,
            current.current_reporting_relationship_id,
          ],
        );
        const workerProfileVersion = advanced.rows[0]?.row_version;
        if (!workerProfileVersion) throw workforceVersionConflict();
        const relationship = mapWorkforceReportingRelationship(
          relationshipRow,
          workerProfileVersion,
        );
        await recordWorkforceReportingMutation(
          transaction,
          receipt,
          current.current_relationship_status,
          priorRelationshipVersion,
          relationship,
        );
        return reportingCommandResult(relationship, false);
      },
      workforceTransactionOptions,
    );
  } catch (error) {
    return translateReportingWriteError(error);
  }
}
