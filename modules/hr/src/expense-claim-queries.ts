import {
  type HrExpenseClaimAssignedListQuery,
  type HrExpenseClaimDetailQuery,
  type HrExpenseClaimHistoryItem,
  type HrExpenseClaimListItem,
  type HrExpenseClaimListResponse,
  type HrExpenseClaimOwnListQuery,
  type HrExpenseClaimResponse,
  type HrExpenseClaimStatus,
  parseHrExpenseClaimListResponse,
  parseHrExpenseClaimResponse,
} from "@esbla/contracts/hr-expense-claim-api";
import {
  assertPolicyAllowed,
  evaluatePolicy,
  type OperationContext,
  PlatformError,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import {
  HR_EXPENSE_CLAIM_SERVICE_KEY,
  HrExpenseClaimError,
} from "./expense-claim-service-control.js";
import { hrManifest } from "./manifest.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT_TYPE = "hr.expense.version";
const WORK_TYPE = "hr.expense.approval";
type ReadAction = "list_assigned" | "list_own" | "view_detail";
type ReadRole = "employee" | "manager";

interface ListRow {
  readonly created_at: Date | string;
  readonly currency_code: string;
  readonly expense_claim_id: string;
  readonly expense_claim_version_id: string;
  readonly root_version: number;
  readonly status: HrExpenseClaimStatus;
  readonly submitted_at: Date | string | null;
  readonly total_amount_minor: number;
  readonly version: number;
  readonly worker_profile_id: string;
  readonly work_item_id: string | null;
}
interface DetailRow extends ListRow {
  readonly assigned_approver_worker_profile_id: string | null;
  readonly supersedes_version_id: string | null;
  readonly version_row_version: number;
}
interface LineRow {
  readonly amount_minor: number;
  readonly category_code: string;
  readonly description: string | null;
  readonly expense_date: string;
  readonly expense_line_id: string;
  readonly row_version: number;
}
interface HistoryRow {
  readonly assigned_approver_worker_profile_id: string | null;
  readonly currency_code: string;
  readonly decided_at: Date | string | null;
  readonly decision_note: string | null;
  readonly expense_claim_version_id: string;
  readonly row_version: number;
  readonly status: HrExpenseClaimStatus;
  readonly submitted_at: Date | string | null;
  readonly supersedes_version_id: string | null;
  readonly total_amount_minor: number;
  readonly version: number;
}

function inputInvalid(message: string): never {
  throw new HrExpenseClaimError("EXPENSE_INPUT_INVALID", message);
}
function conflict(message: string): never {
  throw new HrExpenseClaimError("EXPENSE_CONFLICT", message);
}
function notFound(): never {
  throw new HrExpenseClaimError("EXPENSE_NOT_FOUND", "Expense Claim was not found");
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
  if (!Number.isFinite(parsed.valueOf())) conflict("Stored Expense Claim timestamp is invalid");
  return parsed.toISOString();
}
function mapListItem(row: ListRow): HrExpenseClaimListItem {
  return {
    createdAt: iso(row.created_at) ?? conflict("Stored Expense Claim creation time is invalid"),
    currencyCode: row.currency_code,
    expenseClaimId: row.expense_claim_id,
    expenseClaimVersionId: row.expense_claim_version_id,
    rootVersion: row.root_version,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    totalAmountMinor: row.total_amount_minor,
    version: row.version,
    workerProfileId: row.worker_profile_id,
    workItemId: row.work_item_id,
  };
}

async function withExpenseRead<T>(
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
          throw new HrExpenseClaimError(
            "EXPENSE_SERVICE_INACTIVE",
            "Expense Claim Boundary service is inactive",
          );
        }
        const dependencies = await transaction.client.query<{
          service_key: string;
          state: string;
        }>(
          `SELECT service_key,state FROM service_activations
           WHERE tenant_id=$1 AND service_key=ANY($2::text[])
           ORDER BY service_key FOR SHARE`,
          [transaction.context.tenantId, ["workforce_profile", "workspace.task"]],
        );
        if (
          dependencies.rows.length !== 2 ||
          dependencies.rows[0]?.service_key !== "workforce_profile" ||
          dependencies.rows[1]?.service_key !== "workspace.task" ||
          dependencies.rows.some(({ state }) => state !== "active")
        ) {
          throw new HrExpenseClaimError(
            "EXPENSE_DEPENDENCY_INACTIVE",
            "Expense Claim dependency is unavailable",
          );
        }
        return await operation(transaction);
      },
      { serviceActivationKey: HR_EXPENSE_CLAIM_SERVICE_KEY, serviceActivationLock: "share" },
    );
  } catch (error) {
    if (error instanceof HrExpenseClaimError || error instanceof PlatformError) throw error;
    if (postgresCode(error, "42501")) {
      throw new PlatformError("POLICY_DENIED", "Expense Claim denied");
    }
    if (postgresCode(error, "22007", "22008", "22023")) {
      inputInvalid("Expense Claim query is invalid");
    }
    if (postgresCode(error, "40001", "40P01", "55P03")) {
      conflict("Expense Claim read currentness check failed");
    }
    throw error;
  }
}

async function authorizeRead(
  transaction: TenantTransaction,
  action: ReadAction,
  role: ReadRole,
): Promise<void> {
  const actionKey = `hr.expense.${action}`;
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
        resourceKey: HR_EXPENSE_CLAIM_SERVICE_KEY,
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
    HR_EXPENSE_CLAIM_SERVICE_KEY,
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
    throw new PlatformError("POLICY_DENIED", "Expense Claim profile authority was denied");
  }
  return result.rows[0].worker_profile_id;
}

export async function listOwnExpenseClaims(
  pool: Pool,
  context: OperationContext,
  query: HrExpenseClaimOwnListQuery,
): Promise<HrExpenseClaimListResponse> {
  const limit = pageSize(query.pageSize);
  const cursor =
    query.cursorCreatedAt === undefined && query.cursorExpenseClaimId === undefined
      ? undefined
      : {
          createdAt: normalizeTimestamp(query.cursorCreatedAt ?? "", "cursorCreatedAt"),
          expenseClaimId: normalizeUuid(query.cursorExpenseClaimId ?? "", "cursorExpenseClaimId"),
        };
  if ((query.cursorCreatedAt === undefined) !== (query.cursorExpenseClaimId === undefined)) {
    inputInvalid("Own Expense Claim cursor fields must be paired");
  }
  return await withExpenseRead(pool, context, async (transaction) => {
    await authorizeRead(transaction, "list_own", "employee");
    const workerProfileId = await activeProfile(transaction);
    const parameters = [
      transaction.context.tenantId,
      workerProfileId,
      ...(cursor ? [cursor.createdAt, cursor.expenseClaimId] : []),
      limit,
    ];
    const result = await transaction.client.query<ListRow>(
      `SELECT root.expense_claim_id,root.worker_profile_id,
              to_char(root.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
              root.row_version root_version,
              version.expense_claim_version_id,version.version,version.currency_code,
              version.status,
              to_char(version.submitted_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') submitted_at,
              version.total_amount_minor,
              NULL::uuid work_item_id
       FROM hr_expense_claims root
       JOIN hr_expense_claim_versions version
         ON version.tenant_id=root.tenant_id
        AND version.expense_claim_id=root.expense_claim_id
        AND version.expense_claim_version_id=root.current_version_id
       WHERE root.tenant_id=$1 AND root.worker_profile_id=$2
         ${cursor ? "AND (root.created_at,root.expense_claim_id)<($3::timestamptz,$4::uuid)" : ""}
       ORDER BY root.created_at DESC,root.expense_claim_id DESC
       LIMIT $${cursor ? 5 : 3}`,
      parameters,
    );
    const last = result.rows.length === limit ? result.rows.at(-1) : undefined;
    return parseHrExpenseClaimListResponse({
      items: result.rows.map(mapListItem),
      kind: "own",
      nextCursor: last
        ? { createdAt: iso(last.created_at), expenseClaimId: last.expense_claim_id }
        : null,
    });
  });
}

export async function listAssignedExpenseClaims(
  pool: Pool,
  context: OperationContext,
  query: HrExpenseClaimAssignedListQuery,
): Promise<HrExpenseClaimListResponse> {
  const limit = pageSize(query.pageSize);
  const cursor =
    query.cursorSubmittedAt === undefined && query.cursorExpenseClaimVersionId === undefined
      ? undefined
      : {
          expenseClaimVersionId: normalizeUuid(
            query.cursorExpenseClaimVersionId ?? "",
            "cursorExpenseClaimVersionId",
          ),
          submittedAt: normalizeTimestamp(query.cursorSubmittedAt ?? "", "cursorSubmittedAt"),
        };
  if (
    (query.cursorSubmittedAt === undefined) !==
    (query.cursorExpenseClaimVersionId === undefined)
  ) {
    inputInvalid("Assigned Expense Claim cursor fields must be paired");
  }
  return await withExpenseRead(pool, context, async (transaction) => {
    await authorizeRead(transaction, "list_assigned", "manager");
    const managerWorkerProfileId = await activeProfile(transaction);
    const parameters = [
      transaction.context.tenantId,
      managerWorkerProfileId,
      transaction.context.actorPrincipalId,
      ...(cursor ? [cursor.submittedAt, cursor.expenseClaimVersionId] : []),
      limit,
    ];
    const result = await transaction.client.query<ListRow>(
      `SELECT root.expense_claim_id,root.worker_profile_id,
              to_char(root.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
              root.row_version root_version,
              version.expense_claim_version_id,version.version,version.currency_code,
              version.status,
              to_char(version.submitted_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') submitted_at,
              version.total_amount_minor,work.work_item_id
       FROM hr_expense_claim_versions version
       JOIN hr_expense_claims root
         ON root.tenant_id=version.tenant_id
        AND root.expense_claim_id=version.expense_claim_id
        AND root.current_version_id=version.expense_claim_version_id
       JOIN work_items work
         ON work.tenant_id=version.tenant_id
        AND work.subject_id=version.expense_claim_version_id
        AND work.subject_type='${SUBJECT_TYPE}'
        AND work.work_type='${WORK_TYPE}'
        AND work.assignee_principal_id=$3
        AND work.status='open'
       WHERE version.tenant_id=$1
         AND version.assigned_approver_worker_profile_id=$2
         AND version.status='submitted'
         ${
           cursor
             ? "AND (version.submitted_at,version.expense_claim_version_id)>($4::timestamptz,$5::uuid)"
             : ""
}
       ORDER BY version.submitted_at,version.expense_claim_version_id
       LIMIT $${cursor ? 6 : 4}`,
      parameters,
    );
    const last = result.rows.length === limit ? result.rows.at(-1) : undefined;
    return parseHrExpenseClaimListResponse({
      items: result.rows.map(mapListItem),
      kind: "assigned",
      nextCursor:
        last && last.submitted_at !== null
          ? {
              expenseClaimVersionId: last.expense_claim_version_id,
              submittedAt: iso(last.submitted_at),
            }
          : null,
    });
  });
}

async function managerCanView(
  transaction: TenantTransaction,
  managerWorkerProfileId: string,
  expenseClaimId: string,
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
     JOIN hr_expense_claim_versions version
       ON version.tenant_id=work.tenant_id
      AND version.expense_claim_version_id=work.subject_id
     WHERE work.tenant_id=$1 AND version.expense_claim_id=$2
       AND work.assignee_principal_id=$3
       AND work.subject_type='${SUBJECT_TYPE}'
       AND work.work_type='${WORK_TYPE}'
       AND work.status<>'cancelled'
     ORDER BY version.version,version.expense_claim_version_id
     LIMIT 1 FOR SHARE OF work,version`,
    [transaction.context.tenantId, expenseClaimId, transaction.context.actorPrincipalId],
  );
  return work.rows.length === 1;
}

function mapHistory(row: HistoryRow): HrExpenseClaimHistoryItem {
  return {
    assignedApproverWorkerProfileId: row.assigned_approver_worker_profile_id,
    currencyCode: row.currency_code,
    decidedAt: iso(row.decided_at),
    decisionNote: row.decision_note,
    expenseClaimVersionId: row.expense_claim_version_id,
    rowVersion: row.row_version,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    supersedesVersionId: row.supersedes_version_id,
    totalAmountMinor: row.total_amount_minor,
    version: row.version,
  };
}

export async function getAuthorizedExpenseClaimDetail(
  pool: Pool,
  context: OperationContext,
  expenseClaimIdInput: string,
  query: HrExpenseClaimDetailQuery,
): Promise<HrExpenseClaimResponse> {
  const expenseClaimId = normalizeUuid(expenseClaimIdInput, "expenseClaimId");
  const limit = pageSize(query.pageSize);
  const cursor =
    query.cursorExpenseClaimVersionId === undefined && query.cursorVersion === undefined
      ? undefined
      : {
          expenseClaimVersionId: normalizeUuid(
            query.cursorExpenseClaimVersionId ?? "",
            "cursorExpenseClaimVersionId",
          ),
          version: positive(query.cursorVersion ?? 0, "cursorVersion"),
        };
  if ((query.cursorExpenseClaimVersionId === undefined) !== (query.cursorVersion === undefined)) {
    inputInvalid("Expense Claim history cursor fields must be paired");
  }
  return await withExpenseRead(pool, context, async (transaction) => {
    const role = transaction.actor.roleKey;
    if (role !== "employee" && role !== "manager") {
      await authorizeRead(transaction, "view_detail", "employee");
    }
    await authorizeRead(transaction, "view_detail", role as ReadRole);
    const actorWorkerProfileId = await activeProfile(transaction);
    const identity = await transaction.client.query<{
      worker_profile_id: string;
    }>(
      `SELECT worker_profile_id FROM hr_expense_claims
       WHERE tenant_id=$1 AND expense_claim_id=$2`,
      [transaction.context.tenantId, expenseClaimId],
    );
    const owner = identity.rows[0]?.worker_profile_id;
    if (!owner) notFound();
    if (role === "employee" && owner !== actorWorkerProfileId) notFound();
    if (
      role === "manager" &&
      !(await managerCanView(transaction, actorWorkerProfileId, expenseClaimId, owner))
    ) {
      notFound();
    }
    const selected = await transaction.client.query<DetailRow>(
      `SELECT root.expense_claim_id,root.worker_profile_id,
              to_char(root.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
              root.row_version root_version,
              version.expense_claim_version_id,version.version,version.currency_code,
              version.status,version.assigned_approver_worker_profile_id,
              to_char(version.submitted_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') submitted_at,
              version.supersedes_version_id,version.total_amount_minor,
              version.row_version version_row_version,
              work.work_item_id
       FROM hr_expense_claims root
       JOIN hr_expense_claim_versions version
         ON version.tenant_id=root.tenant_id
        AND version.expense_claim_id=root.expense_claim_id
        AND version.expense_claim_version_id=root.current_version_id
       LEFT JOIN work_items work
         ON work.tenant_id=version.tenant_id
        AND work.subject_id=version.expense_claim_version_id
        AND work.subject_type='${SUBJECT_TYPE}'
        AND work.work_type='${WORK_TYPE}'
        AND work.assignee_principal_id=$3
        AND work.status='open'
       WHERE root.tenant_id=$1 AND root.expense_claim_id=$2
       LIMIT 1 FOR SHARE OF root,version`,
      [transaction.context.tenantId, expenseClaimId, transaction.context.actorPrincipalId],
    );
    const root = selected.rows[0];
    if (!root || root.worker_profile_id !== owner) notFound();
    const lines = await transaction.client.query<LineRow>(
      `SELECT expense_line_id,expense_date::text,category_code,amount_minor,
              description,row_version
       FROM hr_expense_claim_lines
       WHERE tenant_id=$1 AND expense_claim_version_id=$2
       ORDER BY expense_date,expense_line_id LIMIT 51 FOR SHARE`,
      [transaction.context.tenantId, root.expense_claim_version_id],
    );
    if (lines.rows.length > 50) conflict("Stored Expense Claim line bound is invalid");
    const historyParameters = [
      transaction.context.tenantId,
      expenseClaimId,
      ...(cursor ? [cursor.version, cursor.expenseClaimVersionId] : []),
      limit,
    ];
    const history = await transaction.client.query<HistoryRow>(
      `SELECT version.expense_claim_version_id,version.supersedes_version_id,
              version.version,version.currency_code,version.status,
              version.assigned_approver_worker_profile_id,
              to_char(version.submitted_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') submitted_at,
              version.total_amount_minor,version.row_version,
              approval.decision_note,
              to_char(approval.decided_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') decided_at
       FROM hr_expense_claim_versions version
       LEFT JOIN hr_expense_claim_approvals approval
         ON approval.tenant_id=version.tenant_id
        AND approval.expense_claim_version_id=version.expense_claim_version_id
       WHERE version.tenant_id=$1 AND version.expense_claim_id=$2
         ${
           cursor
             ? "AND (version.version,version.expense_claim_version_id)<($3::integer,$4::uuid)"
             : ""
}
       ORDER BY version.version DESC,version.expense_claim_version_id DESC
       LIMIT $${cursor ? 5 : 3} FOR SHARE OF version`,
      historyParameters,
    );
    const last = history.rows.length === limit ? history.rows.at(-1) : undefined;
    return parseHrExpenseClaimResponse({
      accessScope: role === "employee" ? "own" : "assigned",
      currentVersion: {
        assignedApproverWorkerProfileId: root.assigned_approver_worker_profile_id,
        currencyCode: root.currency_code,
        expenseClaimVersionId: root.expense_claim_version_id,
        lines: lines.rows.map((line) => ({
          amountMinor: line.amount_minor,
          categoryCode: line.category_code,
          description: line.description,
          expenseDate: line.expense_date,
          expenseLineId: line.expense_line_id,
          version: line.row_version,
        })),
        rowVersion: root.version_row_version,
        status: root.status,
        submittedAt: iso(root.submitted_at),
        supersedesVersionId: root.supersedes_version_id,
        totalAmountMinor: root.total_amount_minor,
        version: root.version,
      },
      decisionEligible:
        role === "manager" &&
        root.status === "submitted" &&
        root.assigned_approver_worker_profile_id === actorWorkerProfileId &&
        root.work_item_id !== null,
      expenseClaimId: root.expense_claim_id,
      history: {
        items: history.rows.map(mapHistory),
        nextCursor: last
          ? {
              expenseClaimVersionId: last.expense_claim_version_id,
              version: last.version,
            }
          : null,
      },
      rootVersion: root.root_version,
      workerProfileId: root.worker_profile_id,
    });
  });
}
