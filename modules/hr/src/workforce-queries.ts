import {
  type OperationContext,
  PlatformError,
  resolveSetting,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import {
  workforceInputInvalid,
  workforceProfileConflict,
  workforceProfileNotFound,
} from "./workforce-errors.js";
import {
  authorizeWorkforceAction,
  mapWorkforceProfile,
  mapWorkforceReportingRelationship,
  normalizeWorkforceUuid,
  requireWorkforceServiceActive,
  WORKFORCE_PROFILE_COLUMNS,
  type WorkforceProfileRow,
  type WorkforceReportingRelationshipRow,
  workforceTransactionOptions,
} from "./workforce-internal.js";
import { workforceProfileSettings } from "./workforce-settings.js";
import type {
  AuthorizedWorkforceListPage,
  DirectReportsCursor,
  GetAuthorizedWorkforceDetailOptions,
  ListAuthorizedWorkforceOptions,
  WorkforceListCursor,
  WorkforceProfileDetailView,
  WorkforceProfileView,
  WorkforceRelationshipHistoryCursor,
  WorkforceRelationshipHistoryView,
  WorkforceStatus,
  WorkforceStatusHistoryCursor,
  WorkforceStatusHistoryView,
} from "./workforce-types.js";

type WorkforceListRow = WorkforceProfileRow & { readonly created_at: Date | string };
type DirectReportRow = WorkforceProfileRow & WorkforceReportingRelationshipRow;
type StatusHistoryRow = {
  readonly effective_at: Date | string;
  readonly new_status: WorkforceStatus;
  readonly previous_status: WorkforceStatus | null;
  readonly workforce_status_history_id: string;
};

const workforceStatuses = new Set<WorkforceStatus>(["active", "draft", "suspended", "terminated"]);

function validatePageSize(pageSize: number | undefined): number {
  const value = pageSize ?? 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw workforceInputInvalid("pageSize must be an integer from 1 through 50");
  }
  return value;
}

function validateTimestamp(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw workforceInputInvalid(`${field} must be a canonical ISO date-time`);
  }
  return value;
}

function mapTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (Number.isNaN(Date.parse(timestamp))) {
    throw workforceProfileConflict("Workforce Profile timestamp is invalid");
  }
  return new Date(timestamp).toISOString();
}

function validateWorkforceCursor(cursor: WorkforceListCursor | undefined): void {
  if (!cursor) return;
  validateTimestamp(cursor.createdAt, "cursor.createdAt");
  normalizeWorkforceUuid(cursor.workerProfileId, "cursor.workerProfileId");
}

function validateDirectReportsCursor(cursor: DirectReportsCursor | undefined): void {
  if (!cursor) return;
  validateTimestamp(cursor.effectiveAt, "cursor.effectiveAt");
  normalizeWorkforceUuid(cursor.reportingRelationshipId, "cursor.reportingRelationshipId");
}

function validateStatusHistoryCursor(cursor: WorkforceStatusHistoryCursor | undefined): void {
  if (!cursor) return;
  validateTimestamp(cursor.effectiveAt, "statusCursor.effectiveAt");
  normalizeWorkforceUuid(cursor.workforceStatusHistoryId, "statusCursor.workforceStatusHistoryId");
}

function validateRelationshipHistoryCursor(
  cursor: WorkforceRelationshipHistoryCursor | undefined,
): void {
  if (!cursor) return;
  if (!Number.isSafeInteger(cursor.relationshipVersion) || cursor.relationshipVersion < 1) {
    throw workforceInputInvalid("relationshipCursor.relationshipVersion must be positive");
  }
  normalizeWorkforceUuid(
    cursor.reportingRelationshipId,
    "relationshipCursor.reportingRelationshipId",
  );
}

function mapStatusHistory(row: StatusHistoryRow): WorkforceStatusHistoryView {
  if (
    !workforceStatuses.has(row.new_status) ||
    (row.previous_status !== null && !workforceStatuses.has(row.previous_status))
  ) {
    throw workforceProfileConflict("Workforce status history is invalid");
  }
  return {
    effectiveAt: mapTimestamp(row.effective_at),
    newStatus: row.new_status,
    previousStatus: row.previous_status,
    workforceStatusHistoryId: normalizeWorkforceUuid(
      row.workforce_status_history_id,
      "workforceStatusHistoryId",
    ),
  };
}

function mapRelationshipHistory(
  row: WorkforceReportingRelationshipRow,
): WorkforceRelationshipHistoryView {
  const { workerProfileVersion: _workerProfileVersion, ...history } =
    mapWorkforceReportingRelationship(row, 1);
  return history;
}

async function lockWorkforceProfiles(
  transaction: TenantTransaction,
  workerProfileIds: readonly string[],
): Promise<void> {
  const profileIds = [...new Set(workerProfileIds)].sort();
  if (profileIds.length === 0) return;
  const locked = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id
     FROM hr_worker_profiles
     WHERE tenant_id=$1 AND worker_profile_id=ANY($2::uuid[])
     ORDER BY worker_profile_id
     FOR SHARE`,
    [transaction.context.tenantId, profileIds],
  );
  if (locked.rows.length !== profileIds.length) {
    throw workforceProfileConflict("Workforce Profile list state changed during authorization");
  }
}

function workforceNextCursor(
  rows: readonly WorkforceListRow[],
  pageSize: number,
): WorkforceListCursor | null {
  const last = rows.length === pageSize ? rows.at(-1) : undefined;
  return last
    ? { createdAt: mapTimestamp(last.created_at), workerProfileId: last.worker_profile_id }
    : null;
}

function directReportsNextCursor(
  rows: readonly DirectReportRow[],
  pageSize: number,
): DirectReportsCursor | null {
  const last = rows.length === pageSize ? rows.at(-1) : undefined;
  return last
    ? {
        effectiveAt: mapTimestamp(last.effective_at),
        reportingRelationshipId: last.reporting_relationship_id,
      }
    : null;
}

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

async function listWorkforceByStatus(
  transaction: TenantTransaction,
  status: WorkforceStatus,
  pageSize: number,
  cursor?: WorkforceListCursor,
): Promise<AuthorizedWorkforceListPage> {
  const candidates = cursor
    ? await transaction.client.query<{ worker_profile_id: string }>(
        `SELECT worker_profile_id
         FROM hr_worker_profiles
         WHERE tenant_id=$1 AND workforce_status=$2
           AND (created_at, worker_profile_id) < ($3::timestamptz, $4::uuid)
         ORDER BY created_at DESC, worker_profile_id DESC
         LIMIT $5`,
        [transaction.context.tenantId, status, cursor.createdAt, cursor.workerProfileId, pageSize],
      )
    : await transaction.client.query<{ worker_profile_id: string }>(
        `SELECT worker_profile_id
         FROM hr_worker_profiles
         WHERE tenant_id=$1 AND workforce_status=$2
         ORDER BY created_at DESC, worker_profile_id DESC
         LIMIT $3`,
        [transaction.context.tenantId, status, pageSize],
      );
  const profileIds = candidates.rows.map(({ worker_profile_id }) => worker_profile_id);
  await lockWorkforceProfiles(transaction, profileIds);
  if (profileIds.length === 0) return { items: [], kind: "workforce", nextCursor: null };

  const result = cursor
    ? await transaction.client.query<WorkforceListRow>(
        `SELECT worker_profile_id, employee_number,
                principal_id IS NOT NULL AS principal_linked, workforce_status, row_version,
                created_at
         FROM hr_worker_profiles
         WHERE tenant_id=$1 AND worker_profile_id=ANY($2::uuid[]) AND workforce_status=$3
           AND (created_at, worker_profile_id) < ($4::timestamptz, $5::uuid)
         ORDER BY created_at DESC, worker_profile_id DESC
         LIMIT $6`,
        [
          transaction.context.tenantId,
          profileIds,
          status,
          cursor.createdAt,
          cursor.workerProfileId,
          pageSize,
        ],
      )
    : await transaction.client.query<WorkforceListRow>(
        `SELECT worker_profile_id, employee_number,
                principal_id IS NOT NULL AS principal_linked, workforce_status, row_version,
                created_at
         FROM hr_worker_profiles
         WHERE tenant_id=$1 AND worker_profile_id=ANY($2::uuid[]) AND workforce_status=$3
         ORDER BY created_at DESC, worker_profile_id DESC
         LIMIT $4`,
        [transaction.context.tenantId, profileIds, status, pageSize],
      );
  return {
    items: result.rows.map(mapWorkforceProfile),
    kind: "workforce",
    nextCursor: workforceNextCursor(result.rows, pageSize),
  };
}

async function resolveManagerWorkerProfileId(transaction: TenantTransaction): Promise<string> {
  const result = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id
     FROM hr_worker_profiles
     WHERE tenant_id=$1 AND principal_id=$2 AND workforce_status='active'
     ORDER BY worker_profile_id
     LIMIT 2`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId],
  );
  const managerWorkerProfileId = result.rows[0]?.worker_profile_id;
  if (!managerWorkerProfileId || result.rows.length !== 1) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  return managerWorkerProfileId;
}

type DetailAuthority =
  | { readonly kind: "employee" | "hr_operator"; readonly profile: WorkforceProfileRow }
  | {
      readonly kind: "manager";
      readonly managerWorkerProfileId: string;
      readonly profile: WorkforceProfileRow;
    };

function denyDetail(): never {
  throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
}

async function profileById(
  transaction: TenantTransaction,
  workerProfileId: string,
): Promise<WorkforceProfileRow | undefined> {
  const result = await transaction.client.query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_PROFILE_COLUMNS}
     FROM hr_worker_profiles WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [transaction.context.tenantId, workerProfileId],
  );
  return result.rows[0];
}

async function resolveDetailAuthority(
  transaction: TenantTransaction,
  workerProfileId: string,
): Promise<DetailAuthority> {
  const role = transaction.actor.roleKey;
  if (role === "employee") {
    await authorizeWorkforceAction(transaction, "view_authorized_detail", "employee");
    const candidate = await transaction.client.query<{ worker_profile_id: string }>(
      `SELECT worker_profile_id FROM hr_worker_profiles
       WHERE tenant_id=$1 AND principal_id=$2 AND workforce_status='active'
       ORDER BY worker_profile_id LIMIT 2`,
      [transaction.context.tenantId, transaction.context.actorPrincipalId],
    );
    if (candidate.rows.length !== 1 || candidate.rows[0]?.worker_profile_id !== workerProfileId) {
      return denyDetail();
    }
    await lockWorkforceProfiles(transaction, [workerProfileId]);
    const profile = await profileById(transaction, workerProfileId);
    if (
      profile?.workforce_status !== "active" ||
      !(
        await transaction.client.query(
          `SELECT 1 FROM hr_worker_profiles
         WHERE tenant_id=$1 AND worker_profile_id=$2 AND principal_id=$3`,
          [transaction.context.tenantId, workerProfileId, transaction.context.actorPrincipalId],
        )
      ).rows[0]
    ) {
      return denyDetail();
    }
    await authorizeWorkforceAction(transaction, "view_authorized_detail", "employee");
    return { kind: "employee", profile };
  }
  if (role === "manager") {
    await authorizeWorkforceAction(transaction, "view_authorized_detail", "manager");
    if (
      (await resolveSetting(transaction, workforceProfileSettings.managerVisibility)).value !==
      "minimized"
    ) {
      return denyDetail();
    }
    const managerWorkerProfileId = await resolveManagerWorkerProfileId(transaction);
    const candidate = await transaction.client.query(
      `SELECT relationship.reporting_relationship_id
       FROM hr_worker_profiles profile JOIN hr_reporting_relationships relationship
         ON relationship.tenant_id=profile.tenant_id
        AND relationship.worker_profile_id=profile.worker_profile_id
        AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
       WHERE profile.tenant_id=$1 AND profile.worker_profile_id=$2
         AND relationship.manager_worker_profile_id=$3
         AND relationship.relationship_status='assigned'`,
      [transaction.context.tenantId, workerProfileId, managerWorkerProfileId],
    );
    if (candidate.rows.length !== 1) return denyDetail();
    await lockWorkforceProfiles(transaction, [managerWorkerProfileId, workerProfileId]);
    const manager = await transaction.client.query(
      `SELECT 1 FROM hr_worker_profiles WHERE tenant_id=$1 AND worker_profile_id=$2
         AND principal_id=$3 AND workforce_status='active'`,
      [transaction.context.tenantId, managerWorkerProfileId, transaction.context.actorPrincipalId],
    );
    const current = await transaction.client.query(
      `SELECT relationship.reporting_relationship_id
       FROM hr_worker_profiles profile JOIN hr_reporting_relationships relationship
         ON relationship.tenant_id=profile.tenant_id
        AND relationship.worker_profile_id=profile.worker_profile_id
        AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
       WHERE profile.tenant_id=$1 AND profile.worker_profile_id=$2
         AND relationship.manager_worker_profile_id=$3
         AND relationship.relationship_status='assigned'`,
      [transaction.context.tenantId, workerProfileId, managerWorkerProfileId],
    );
    const profile = await profileById(transaction, workerProfileId);
    if (!manager.rows[0] || !current.rows[0] || !profile) return denyDetail();
    await authorizeWorkforceAction(transaction, "view_authorized_detail", "manager");
    if (
      (await resolveSetting(transaction, workforceProfileSettings.managerVisibility)).value !==
      "minimized"
    ) {
      return denyDetail();
    }
    return { kind: "manager", managerWorkerProfileId, profile };
  }
  if (role === "hr_operator") {
    await authorizeWorkforceAction(transaction, "view_authorized_detail", "hr_operator");
    if (!(await profileById(transaction, workerProfileId))) throw workforceProfileNotFound();
    await lockWorkforceProfiles(transaction, [workerProfileId]);
    const profile = await profileById(transaction, workerProfileId);
    if (!profile) throw workforceProfileNotFound();
    await authorizeWorkforceAction(transaction, "view_authorized_detail", "hr_operator");
    return { kind: "hr_operator", profile };
  }
  return denyDetail();
}

async function readStatusHistory(
  transaction: TenantTransaction,
  workerProfileId: string,
  pageSize: number,
  cursor?: WorkforceStatusHistoryCursor,
) {
  const result = cursor
    ? await transaction.client.query<StatusHistoryRow>(
        `SELECT workforce_status_history_id, previous_status, new_status, effective_at
         FROM hr_workforce_status_history WHERE tenant_id=$1 AND worker_profile_id=$2
           AND (effective_at, workforce_status_history_id) < ($3::timestamptz, $4::uuid)
         ORDER BY effective_at DESC, workforce_status_history_id DESC LIMIT $5`,
        [
          transaction.context.tenantId,
          workerProfileId,
          cursor.effectiveAt,
          cursor.workforceStatusHistoryId,
          pageSize,
        ],
      )
    : await transaction.client.query<StatusHistoryRow>(
        `SELECT workforce_status_history_id, previous_status, new_status, effective_at
         FROM hr_workforce_status_history WHERE tenant_id=$1 AND worker_profile_id=$2
         ORDER BY effective_at DESC, workforce_status_history_id DESC LIMIT $3`,
        [transaction.context.tenantId, workerProfileId, pageSize],
      );
  const last = result.rows.length === pageSize ? result.rows.at(-1) : undefined;
  return {
    items: result.rows.map(mapStatusHistory),
    nextCursor: last
      ? {
          effectiveAt: mapTimestamp(last.effective_at),
          workforceStatusHistoryId: last.workforce_status_history_id,
        }
      : null,
  };
}

async function readRelationshipHistory(
  transaction: TenantTransaction,
  workerProfileId: string,
  pageSize: number,
  managerWorkerProfileId: string | undefined,
  cursor?: WorkforceRelationshipHistoryCursor,
) {
  const managerPredicate = managerWorkerProfileId ? " AND manager_worker_profile_id=$3" : "";
  const values: unknown[] = [transaction.context.tenantId, workerProfileId];
  if (managerWorkerProfileId) values.push(managerWorkerProfileId);
  const cursorOffset = values.length + 1;
  const cursorPredicate = cursor
    ? ` AND (relationship_version, reporting_relationship_id) < ($${cursorOffset}::integer, $${cursorOffset + 1}::uuid)`
    : "";
  if (cursor) values.push(cursor.relationshipVersion, cursor.reportingRelationshipId);
  values.push(pageSize);
  const result = await transaction.client.query<WorkforceReportingRelationshipRow>(
    `SELECT reporting_relationship_id, worker_profile_id, manager_worker_profile_id,
            relationship_status, effective_at, supersedes_reporting_relationship_id,
            relationship_version
     FROM hr_reporting_relationships WHERE tenant_id=$1 AND worker_profile_id=$2
       ${managerPredicate}${cursorPredicate}
     ORDER BY relationship_version DESC, reporting_relationship_id DESC LIMIT $${values.length}`,
    values,
  );
  const last = result.rows.length === pageSize ? result.rows.at(-1) : undefined;
  return {
    items: result.rows.map(mapRelationshipHistory),
    nextCursor: last
      ? {
          relationshipVersion: last.relationship_version,
          reportingRelationshipId: last.reporting_relationship_id,
        }
      : null,
  };
}

export async function getAuthorizedWorkforceProfileDetail(
  pool: Pool,
  context: OperationContext,
  options: GetAuthorizedWorkforceDetailOptions,
): Promise<WorkforceProfileDetailView> {
  const workerProfileId = normalizeWorkforceUuid(options.workerProfileId, "workerProfileId");
  const pageSize = validatePageSize(options.pageSize);
  validateStatusHistoryCursor(options.statusCursor);
  validateRelationshipHistoryCursor(options.relationshipCursor);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceServiceActive(transaction);
      const authority = await resolveDetailAuthority(transaction, workerProfileId);
      const statusHistory = await readStatusHistory(
        transaction,
        workerProfileId,
        pageSize,
        options.statusCursor,
      );
      const relationshipHistory = await readRelationshipHistory(
        transaction,
        workerProfileId,
        pageSize,
        authority.kind === "manager" ? authority.managerWorkerProfileId : undefined,
        options.relationshipCursor,
      );
      return { ...mapWorkforceProfile(authority.profile), relationshipHistory, statusHistory };
    },
    workforceTransactionOptions,
  );
}

async function listCurrentDirectReports(
  transaction: TenantTransaction,
  managerWorkerProfileId: string,
  pageSize: number,
  cursor?: DirectReportsCursor,
): Promise<AuthorizedWorkforceListPage> {
  const candidates = cursor
    ? await transaction.client.query<{ worker_profile_id: string }>(
        `SELECT profile.worker_profile_id
         FROM hr_worker_profiles profile
         JOIN hr_reporting_relationships relationship
           ON relationship.tenant_id=profile.tenant_id
          AND relationship.worker_profile_id=profile.worker_profile_id
          AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
         WHERE profile.tenant_id=$1 AND relationship.manager_worker_profile_id=$2
           AND relationship.relationship_status='assigned'
           AND (relationship.effective_at, relationship.reporting_relationship_id)
               < ($3::timestamptz, $4::uuid)
         ORDER BY relationship.effective_at DESC, relationship.reporting_relationship_id DESC
         LIMIT $5`,
        [
          transaction.context.tenantId,
          managerWorkerProfileId,
          cursor.effectiveAt,
          cursor.reportingRelationshipId,
          pageSize,
        ],
      )
    : await transaction.client.query<{ worker_profile_id: string }>(
        `SELECT profile.worker_profile_id
         FROM hr_worker_profiles profile
         JOIN hr_reporting_relationships relationship
           ON relationship.tenant_id=profile.tenant_id
          AND relationship.worker_profile_id=profile.worker_profile_id
          AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
         WHERE profile.tenant_id=$1 AND relationship.manager_worker_profile_id=$2
           AND relationship.relationship_status='assigned'
         ORDER BY relationship.effective_at DESC, relationship.reporting_relationship_id DESC
         LIMIT $3`,
        [transaction.context.tenantId, managerWorkerProfileId, pageSize],
      );
  const profileIds = candidates.rows.map(({ worker_profile_id }) => worker_profile_id);
  await lockWorkforceProfiles(transaction, [managerWorkerProfileId, ...profileIds]);
  const currentManager = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id
     FROM hr_worker_profiles
     WHERE tenant_id=$1 AND worker_profile_id=$2 AND principal_id=$3
       AND workforce_status='active'`,
    [transaction.context.tenantId, managerWorkerProfileId, transaction.context.actorPrincipalId],
  );
  if (currentManager.rows.length !== 1) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  if (profileIds.length === 0) return { items: [], kind: "direct_reports", nextCursor: null };

  const values = [transaction.context.tenantId, managerWorkerProfileId, profileIds] as const;
  const baseQuery = `SELECT profile.worker_profile_id, profile.employee_number,
                            profile.principal_id IS NOT NULL AS principal_linked,
                            profile.workforce_status, profile.row_version,
                            relationship.reporting_relationship_id,
                            relationship.manager_worker_profile_id,
                            relationship.relationship_status, relationship.effective_at,
                            relationship.supersedes_reporting_relationship_id,
                            relationship.relationship_version
                     FROM hr_worker_profiles profile
                     JOIN hr_reporting_relationships relationship
                       ON relationship.tenant_id=profile.tenant_id
                      AND relationship.worker_profile_id=profile.worker_profile_id
                      AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
                     WHERE profile.tenant_id=$1 AND relationship.manager_worker_profile_id=$2
                       AND profile.worker_profile_id=ANY($3::uuid[])
                       AND relationship.relationship_status='assigned'`;
  const result = cursor
    ? await transaction.client.query<DirectReportRow>(
        `${baseQuery}
           AND (relationship.effective_at, relationship.reporting_relationship_id)
               < ($4::timestamptz, $5::uuid)
         ORDER BY relationship.effective_at DESC, relationship.reporting_relationship_id DESC
         LIMIT $6`,
        [...values, cursor.effectiveAt, cursor.reportingRelationshipId, pageSize],
      )
    : await transaction.client.query<DirectReportRow>(
        `${baseQuery}
         ORDER BY relationship.effective_at DESC, relationship.reporting_relationship_id DESC
         LIMIT $4`,
        [...values, pageSize],
      );
  return {
    items: result.rows.map((row) => ({
      profile: mapWorkforceProfile(row),
      relationship: mapWorkforceReportingRelationship(row, row.row_version),
    })),
    kind: "direct_reports",
    nextCursor: directReportsNextCursor(result.rows, pageSize),
  };
}

export async function listAuthorizedWorkforceProfiles(
  pool: Pool,
  context: OperationContext,
  options: ListAuthorizedWorkforceOptions = {},
): Promise<AuthorizedWorkforceListPage> {
  const pageSize = validatePageSize(options.pageSize);
  if (options.status !== undefined) {
    if (!workforceStatuses.has(options.status)) {
      throw workforceInputInvalid("status is invalid");
    }
    validateWorkforceCursor(options.cursor);
  } else {
    validateDirectReportsCursor(options.cursor);
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceServiceActive(transaction);
      if (options.status !== undefined) {
        await authorizeWorkforceAction(transaction, "list_authorized", "hr_operator");
        return await listWorkforceByStatus(transaction, options.status, pageSize, options.cursor);
      }
      await authorizeWorkforceAction(transaction, "list_authorized", "manager");
      const visibility = await resolveSetting(
        transaction,
        workforceProfileSettings.managerVisibility,
      );
      if (visibility.value !== "minimized") {
        throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
      }
      return await listCurrentDirectReports(
        transaction,
        await resolveManagerWorkerProfileId(transaction),
        pageSize,
        options.cursor,
      );
    },
    workforceTransactionOptions,
  );
}
