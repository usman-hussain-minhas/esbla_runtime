import {
  type HrTimesheetAssignedListQuery,
  type HrTimesheetDetailQuery,
  type HrTimesheetHistoryItem,
  type HrTimesheetListItem,
  type HrTimesheetListResponse,
  type HrTimesheetOwnListQuery,
  type HrTimesheetResponse,
  type HrTimesheetStatus,
  parseHrTimesheetListResponse,
  parseHrTimesheetResponse,
} from "@esbla/contracts/hr-timesheet-api";
import {
  assertPolicyAllowed,
  evaluatePolicy,
  type OperationContext,
  PlatformError,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import { hrManifest } from "./manifest.js";
import { HR_TIMESHEET_SERVICE_KEY, HrTimesheetError } from "./timesheet-service-control.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WORK_TYPE = "hr.timesheet.approval";
const SUBJECT_TYPE = "hr.timesheet.version";
type ReadAction = "list_assigned" | "list_own" | "view_detail";
type ReadRole = "employee" | "hr_operator" | "manager";

interface ListRow {
  readonly period_end: string;
  readonly period_start: string;
  readonly root_version: number;
  readonly status: HrTimesheetStatus;
  readonly submitted_at: Date | string | null;
  readonly timesheet_id: string;
  readonly timesheet_version_id: string;
  readonly total_minutes: number;
  readonly version: number;
  readonly worker_profile_id: string;
  readonly work_item_id: string | null;
}
interface DetailRow extends ListRow {
  readonly assigned_approver_worker_profile_id: string | null;
  readonly supersedes_version_id: string | null;
  readonly version_row_version: number;
}
interface EntryRow {
  readonly description: string | null;
  readonly entry_date: string;
  readonly minutes: number;
  readonly row_version: number;
  readonly timesheet_entry_id: string;
}
interface HistoryRow {
  readonly assigned_approver_worker_profile_id: string | null;
  readonly decided_at: Date | string | null;
  readonly decision_note: string | null;
  readonly row_version: number;
  readonly status: HrTimesheetStatus;
  readonly submitted_at: Date | string | null;
  readonly supersedes_version_id: string | null;
  readonly timesheet_version_id: string;
  readonly total_minutes: number;
  readonly version: number;
}

function inputInvalid(message: string): never {
  throw new HrTimesheetError("TIMESHEET_INPUT_INVALID", message);
}
function conflict(message: string): never {
  throw new HrTimesheetError("TIMESHEET_CONFLICT", message);
}
function notFound(): never {
  throw new HrTimesheetError("TIMESHEET_NOT_FOUND", "Timesheet was not found");
}
function postgresCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    codes.includes(String((error as { code?: unknown }).code))
  );
}
function normalizeUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    inputInvalid(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}
function normalizeDate(value: string, field: string): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    inputInvalid(`${field} must be a calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    inputInvalid(`${field} must be a calendar date`);
  }
  return value;
}
function normalizeTimestamp(value: string, field: string): string {
  if (typeof value !== "string") inputInvalid(`${field} must be a canonical ISO date-time`);
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/.test(value) ||
    parsed.toISOString().slice(0, 23) !== value.slice(0, 23)
  ) {
    inputInvalid(`${field} must be a canonical ISO date-time`);
  }
  return value;
}
function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    inputInvalid(`${field} must be a positive integer`);
  }
  return value;
}
function pageSize(value: number | undefined): number {
  const selected = value ?? 50;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 50) {
    inputInvalid("pageSize must be an integer from 1 through 50");
  }
  return selected;
}
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    return value;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) conflict("Stored Timesheet timestamp is invalid");
  return parsed.toISOString();
}
function mapListItem(row: ListRow): HrTimesheetListItem {
  return {
    periodEnd: row.period_end,
    periodStart: row.period_start,
    rootVersion: row.root_version,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    timesheetId: row.timesheet_id,
    timesheetVersionId: row.timesheet_version_id,
    totalMinutes: row.total_minutes,
    version: row.version,
    workerProfileId: row.worker_profile_id,
    workItemId: row.work_item_id,
  };
}

async function withTimesheetRead<T>(
  pool: Pool,
  context: OperationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withTenantTransaction(
      pool,
      context,
      async (transaction) => {
        if (transaction.lockedServiceActivation?.state !== "active") {
          throw new HrTimesheetError("TIMESHEET_SERVICE_INACTIVE", "Timesheet service is inactive");
        }
        const workforce = await transaction.client.query<{ state: string }>(
          `SELECT state FROM service_activations
           WHERE tenant_id=$1 AND service_key='workforce_profile' FOR SHARE`,
          [transaction.context.tenantId],
        );
        if (workforce.rows[0]?.state !== "active") {
          throw new HrTimesheetError(
            "TIMESHEET_DEPENDENCY_INACTIVE",
            "Timesheet dependency is unavailable",
          );
        }
        return await operation(transaction);
      },
      { serviceActivationKey: HR_TIMESHEET_SERVICE_KEY, serviceActivationLock: "share" },
    );
  } catch (error) {
    if (error instanceof HrTimesheetError || error instanceof PlatformError) throw error;
    if (postgresCode(error, "22007", "22008", "22023")) {
      inputInvalid("Timesheet query is invalid");
    }
    if (postgresCode(error, "40001", "40P01", "55P03")) {
      conflict("Timesheet read currentness check failed");
    }
    throw error;
  }
}

async function authorizeRead(
  transaction: TenantTransaction,
  action: ReadAction,
  role: ReadRole,
): Promise<void> {
  const actionKey = `hr.timesheet.${action}`;
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "tenant" && id === actionKey,
  );
  const capability = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  assertPolicyAllowed(
    evaluatePolicy(
      {
        actionKey,
        input: { capabilityCurrent: registered && capability.rows.length === 1, role },
        resourceKey: HR_TIMESHEET_SERVICE_KEY,
        transaction,
      },
      [
        {
          effect: "allow",
          id: `current_${role}_${action}`,
          matches: (input, actor) =>
            actor.roleKey === input.role && input.capabilityCurrent === true,
        },
      ],
    ),
    transaction,
    actionKey,
    HR_TIMESHEET_SERVICE_KEY,
  );
}

async function activeProfile(transaction: TenantTransaction): Promise<string> {
  const result = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id FROM hr_worker_profiles
     WHERE tenant_id=$1 AND principal_id=$2 AND workforce_status='active'
     ORDER BY worker_profile_id LIMIT 2 FOR SHARE`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId],
  );
  if (result.rows.length !== 1 || !result.rows[0]) {
    throw new PlatformError("POLICY_DENIED", "Timesheet profile authority was denied");
  }
  return result.rows[0].worker_profile_id;
}

export async function listOwnTimesheets(
  pool: Pool,
  context: OperationContext,
  query: HrTimesheetOwnListQuery,
): Promise<HrTimesheetListResponse> {
  const limit = pageSize(query.pageSize);
  const cursor =
    query.cursorPeriodStart === undefined && query.cursorTimesheetId === undefined
      ? undefined
      : {
          periodStart: normalizeDate(query.cursorPeriodStart ?? "", "cursorPeriodStart"),
          timesheetId: normalizeUuid(query.cursorTimesheetId ?? "", "cursorTimesheetId"),
        };
  if ((query.cursorPeriodStart === undefined) !== (query.cursorTimesheetId === undefined)) {
    inputInvalid("Own Timesheet cursor fields must be paired");
  }
  return await withTimesheetRead(pool, context, async (transaction) => {
    await authorizeRead(transaction, "list_own", "employee");
    const workerProfileId = await activeProfile(transaction);
    const result = cursor
      ? await transaction.client.query<ListRow>(
          `SELECT root.timesheet_id,root.worker_profile_id,root.period_start::text,
                  root.period_end::text,root.row_version root_version,
                  version.timesheet_version_id,version.version,version.status,
                  version.submitted_at,version.total_minutes,
                  NULL::uuid work_item_id
           FROM hr_timesheets root
           JOIN hr_timesheet_versions version
             ON version.tenant_id=root.tenant_id
            AND version.timesheet_id=root.timesheet_id
            AND version.timesheet_version_id=root.current_version_id
           WHERE root.tenant_id=$1 AND root.worker_profile_id=$2
             AND (root.period_start,root.timesheet_id)<($3::date,$4::uuid)
           ORDER BY root.period_start DESC,root.timesheet_id DESC
           LIMIT $5`,
          [
            transaction.context.tenantId,
            workerProfileId,
            cursor.periodStart,
            cursor.timesheetId,
            limit,
          ],
        )
      : await transaction.client.query<ListRow>(
          `SELECT root.timesheet_id,root.worker_profile_id,root.period_start::text,
                  root.period_end::text,root.row_version root_version,
                  version.timesheet_version_id,version.version,version.status,
                  version.submitted_at,version.total_minutes,
                  NULL::uuid work_item_id
           FROM hr_timesheets root
           JOIN hr_timesheet_versions version
             ON version.tenant_id=root.tenant_id
            AND version.timesheet_id=root.timesheet_id
            AND version.timesheet_version_id=root.current_version_id
           WHERE root.tenant_id=$1 AND root.worker_profile_id=$2
           ORDER BY root.period_start DESC,root.timesheet_id DESC
           LIMIT $3`,
          [transaction.context.tenantId, workerProfileId, limit],
        );
    const selected = result.rows;
    const last = result.rows.length === limit ? selected.at(-1) : undefined;
    return parseHrTimesheetListResponse({
      items: selected.map(mapListItem),
      kind: "own",
      nextCursor: last ? { periodStart: last.period_start, timesheetId: last.timesheet_id } : null,
    });
  });
}

export async function listAssignedTimesheets(
  pool: Pool,
  context: OperationContext,
  query: HrTimesheetAssignedListQuery,
): Promise<HrTimesheetListResponse> {
  const limit = pageSize(query.pageSize);
  const cursor =
    query.cursorSubmittedAt === undefined && query.cursorTimesheetVersionId === undefined
      ? undefined
      : {
          submittedAt: normalizeTimestamp(query.cursorSubmittedAt ?? "", "cursorSubmittedAt"),
          timesheetVersionId: normalizeUuid(
            query.cursorTimesheetVersionId ?? "",
            "cursorTimesheetVersionId",
          ),
        };
  if ((query.cursorSubmittedAt === undefined) !== (query.cursorTimesheetVersionId === undefined)) {
    inputInvalid("Assigned Timesheet cursor fields must be paired");
  }
  return await withTimesheetRead(pool, context, async (transaction) => {
    await authorizeRead(transaction, "list_assigned", "manager");
    const managerWorkerProfileId = await activeProfile(transaction);
    const parameters = [
      transaction.context.tenantId,
      managerWorkerProfileId,
      transaction.context.actorPrincipalId,
      ...(cursor ? [cursor.submittedAt, cursor.timesheetVersionId] : []),
      limit,
    ];
    const result = await transaction.client.query<ListRow>(
      `SELECT root.timesheet_id,root.worker_profile_id,root.period_start::text,
              root.period_end::text,root.row_version root_version,
              version.timesheet_version_id,version.version,version.status,
              to_char(version.submitted_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') submitted_at,
              version.total_minutes,
              work.work_item_id
       FROM hr_timesheet_versions version
       JOIN hr_timesheets root
         ON root.tenant_id=version.tenant_id
        AND root.timesheet_id=version.timesheet_id
        AND root.current_version_id=version.timesheet_version_id
       JOIN work_items work
         ON work.tenant_id=version.tenant_id
        AND work.subject_id=version.timesheet_version_id
        AND work.subject_type='${SUBJECT_TYPE}'
        AND work.work_type='${WORK_TYPE}'
        AND work.assignee_principal_id=$3
        AND work.status='open'
       WHERE version.tenant_id=$1
         AND version.assigned_approver_worker_profile_id=$2
         AND version.status='submitted'
         ${
           cursor
             ? "AND (version.submitted_at,version.timesheet_version_id)>($4::timestamptz,$5::uuid)"
             : ""
}
       ORDER BY version.submitted_at,version.timesheet_version_id
       LIMIT $${cursor ? 6 : 4}`,
      parameters,
    );
    const selected = result.rows;
    const last = result.rows.length === limit ? selected.at(-1) : undefined;
    return parseHrTimesheetListResponse({
      items: selected.map(mapListItem),
      kind: "assigned",
      nextCursor:
        last && last.submitted_at !== null
          ? {
              submittedAt: iso(last.submitted_at),
              timesheetVersionId: last.timesheet_version_id,
            }
          : null,
    });
  });
}

async function managerCanView(
  transaction: TenantTransaction,
  managerWorkerProfileId: string,
  timesheetId: string,
  workerProfileId: string,
): Promise<boolean> {
  const report = await transaction.client.query(
    `SELECT 1 FROM hr_worker_profiles worker
     JOIN hr_reporting_relationships relationship
       ON relationship.tenant_id=worker.tenant_id
      AND relationship.worker_profile_id=worker.worker_profile_id
      AND relationship.reporting_relationship_id=worker.current_reporting_relationship_id
     WHERE worker.tenant_id=$1 AND worker.worker_profile_id=$2
       AND worker.workforce_status='active'
       AND relationship.manager_worker_profile_id=$3
       AND relationship.relationship_status='assigned'
     LIMIT 1 FOR SHARE OF worker`,
    [transaction.context.tenantId, workerProfileId, managerWorkerProfileId],
  );
  if (report.rows.length === 1) return true;
  const work = await transaction.client.query(
    `SELECT 1 FROM work_items work
     JOIN hr_timesheet_versions version
       ON version.tenant_id=work.tenant_id
      AND version.timesheet_version_id=work.subject_id
     WHERE work.tenant_id=$1 AND version.timesheet_id=$2
       AND work.assignee_principal_id=$3
       AND work.subject_type='${SUBJECT_TYPE}'
       AND work.work_type='${WORK_TYPE}'
       AND work.status<>'cancelled'
     ORDER BY version.version,version.timesheet_version_id
     LIMIT 1 FOR SHARE OF work,version`,
    [transaction.context.tenantId, timesheetId, transaction.context.actorPrincipalId],
  );
  return work.rows.length === 1;
}

function mapHistory(row: HistoryRow): HrTimesheetHistoryItem {
  return {
    assignedApproverWorkerProfileId: row.assigned_approver_worker_profile_id,
    decidedAt: iso(row.decided_at),
    decisionNote: row.decision_note,
    rowVersion: row.row_version,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    supersedesVersionId: row.supersedes_version_id,
    timesheetVersionId: row.timesheet_version_id,
    totalMinutes: row.total_minutes,
    version: row.version,
  };
}

export async function getAuthorizedTimesheetDetail(
  pool: Pool,
  context: OperationContext,
  timesheetIdInput: string,
  query: HrTimesheetDetailQuery,
): Promise<HrTimesheetResponse> {
  const timesheetId = normalizeUuid(timesheetIdInput, "timesheetId");
  const limit = pageSize(query.pageSize);
  const cursor =
    query.cursorTimesheetVersionId === undefined && query.cursorVersion === undefined
      ? undefined
      : {
          timesheetVersionId: normalizeUuid(
            query.cursorTimesheetVersionId ?? "",
            "cursorTimesheetVersionId",
          ),
          version: positive(query.cursorVersion ?? 0, "cursorVersion"),
        };
  if ((query.cursorTimesheetVersionId === undefined) !== (query.cursorVersion === undefined)) {
    inputInvalid("Timesheet history cursor fields must be paired");
  }
  return await withTimesheetRead(pool, context, async (transaction) => {
    const role = transaction.actor.roleKey;
    let actorWorkerProfileId: string | null = null;
    if (role === "employee" || role === "manager") {
      await authorizeRead(transaction, "view_detail", role);
      actorWorkerProfileId = await activeProfile(transaction);
    } else if (role === "hr_operator") {
      await authorizeRead(transaction, "view_detail", "hr_operator");
    } else {
      await authorizeRead(transaction, "view_detail", "employee");
    }
    const selected = await transaction.client.query<DetailRow>(
      `SELECT root.timesheet_id,root.worker_profile_id,root.period_start::text,
              root.period_end::text,root.row_version root_version,
              version.timesheet_version_id,version.version,version.status,
              version.assigned_approver_worker_profile_id,version.submitted_at,
              version.supersedes_version_id,version.total_minutes,
              version.row_version version_row_version,
              NULL::uuid work_item_id
       FROM hr_timesheets root
       JOIN hr_timesheet_versions version
         ON version.tenant_id=root.tenant_id
        AND version.timesheet_id=root.timesheet_id
        AND version.timesheet_version_id=root.current_version_id
       WHERE root.tenant_id=$1 AND root.timesheet_id=$2
       LIMIT 1 FOR SHARE OF root,version`,
      [transaction.context.tenantId, timesheetId],
    );
    const root = selected.rows[0];
    if (!root) notFound();
    let accessScope: "assigned" | "own" | "tenant";
    if (role === "employee") {
      if (root.worker_profile_id !== actorWorkerProfileId) notFound();
      accessScope = "own";
    } else if (role === "manager") {
      if (
        !actorWorkerProfileId ||
        !(await managerCanView(
          transaction,
          actorWorkerProfileId,
          timesheetId,
          root.worker_profile_id,
        ))
      ) {
        notFound();
      }
      accessScope = "assigned";
    } else {
      accessScope = "tenant";
    }
    const entries = await transaction.client.query<EntryRow>(
      `SELECT timesheet_entry_id,entry_date::text,minutes,description,row_version
       FROM hr_timesheet_entries
       WHERE tenant_id=$1 AND timesheet_version_id=$2
       ORDER BY entry_date,timesheet_entry_id LIMIT 50 FOR SHARE`,
      [transaction.context.tenantId, root.timesheet_version_id],
    );
    const historyParameters = [
      transaction.context.tenantId,
      timesheetId,
      ...(cursor ? [cursor.version, cursor.timesheetVersionId] : []),
      limit,
    ];
    const history = await transaction.client.query<HistoryRow>(
      `SELECT version.timesheet_version_id,version.supersedes_version_id,
              version.version,version.status,version.assigned_approver_worker_profile_id,
              version.submitted_at,version.total_minutes,version.row_version,
              approval.decision_note,approval.decided_at
       FROM hr_timesheet_versions version
       LEFT JOIN hr_timesheet_approvals approval
         ON approval.tenant_id=version.tenant_id
        AND approval.timesheet_version_id=version.timesheet_version_id
       WHERE version.tenant_id=$1 AND version.timesheet_id=$2
         ${
           cursor ? "AND (version.version,version.timesheet_version_id)<($3::integer,$4::uuid)" : ""
}
       ORDER BY version.version DESC,version.timesheet_version_id DESC
       LIMIT $${cursor ? 5 : 3} FOR SHARE OF version`,
      historyParameters,
    );
    const page = history.rows;
    const last = history.rows.length === limit ? page.at(-1) : undefined;
    return parseHrTimesheetResponse({
      accessScope,
      currentVersion: {
        assignedApproverWorkerProfileId: root.assigned_approver_worker_profile_id,
        entries: entries.rows.map((entry) => ({
          description: entry.description,
          entryDate: entry.entry_date,
          minutes: entry.minutes,
          timesheetEntryId: entry.timesheet_entry_id,
          version: entry.row_version,
        })),
        rowVersion: root.version_row_version,
        status: root.status,
        submittedAt: iso(root.submitted_at),
        supersedesVersionId: root.supersedes_version_id,
        timesheetVersionId: root.timesheet_version_id,
        totalMinutes: root.total_minutes,
        version: root.version,
      },
      history: {
        items: page.map(mapHistory),
        nextCursor: last
          ? { timesheetVersionId: last.timesheet_version_id, version: last.version }
          : null,
      },
      periodEnd: root.period_end,
      periodStart: root.period_start,
      rootVersion: root.root_version,
      timesheetId: root.timesheet_id,
      workerProfileId: root.worker_profile_id,
    });
  });
}
