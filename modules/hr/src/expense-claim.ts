import { createHash } from "node:crypto";
import {
  type HrExpenseClaimApproveBody,
  type HrExpenseClaimCreateBody,
  type HrExpenseClaimDecisionBody,
  type HrExpenseClaimEditDraftBody,
  type HrExpenseClaimRejectBody,
  type HrExpenseClaimResponse,
  type HrExpenseClaimSubmitBody,
  parseHrExpenseClaimResponse,
} from "@esbla/contracts/hr-expense-claim-api";
import {
  appendEvidence,
  assertPolicyAllowed,
  completeWorkItem,
  createWorkItem,
  deriveStableUuid,
  evaluatePolicy,
  lockMembershipAuthority,
  type OperationContext,
  PlatformError,
  recordMutationProof,
  resolveSetting,
  type SettingDefinition,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import {
  HR_EXPENSE_CLAIM_BILLING_STATE,
  HR_EXPENSE_CLAIM_SERVICE_KEY,
  HrExpenseClaimError,
} from "./expense-claim-service-control.js";
import { hrManifest } from "./manifest.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUBJECT_VERSION = "hr.expense.version";
const SUBJECT_RECEIPT = "hr.expense.idempotency";
const WORK_TYPE = "hr.expense.approval";
type EmployeeAction = "create" | "edit_draft" | "submit";
type ManagerAction = "approve" | "reject";
type ExpenseAction = EmployeeAction | ManagerAction;

interface Receipt {
  readonly action: ExpenseAction;
  readonly eventType: string;
  readonly receiptId: string;
  readonly semanticSha256: string;
}
interface RootRow {
  readonly created_at: Date | string;
  readonly current_version_id: string;
  readonly expense_claim_id: string;
  readonly row_version: number;
  readonly worker_profile_id: string;
}
interface VersionRow {
  readonly assigned_approver_worker_profile_id: string | null;
  readonly currency_code: string;
  readonly expense_claim_id: string;
  readonly expense_claim_version_id: string;
  readonly row_version: number;
  readonly status: "approved" | "draft" | "rejected" | "submitted";
  readonly submitted_at: Date | string | null;
  readonly supersedes_version_id: string | null;
  readonly total_amount_minor: number;
  readonly version: number;
}
interface LineRow {
  readonly amount_minor: number;
  readonly category_code: string;
  readonly description: string | null;
  readonly expense_date: string;
  readonly expense_line_id: string;
  readonly row_version: number;
}
interface WorkRow {
  readonly assignee_principal_id: string;
  readonly status: "cancelled" | "completed" | "open";
  readonly subject_id: string;
  readonly subject_type: string;
  readonly work_item_id: string;
  readonly work_type: string;
}
type DetailRow = RootRow &
  Omit<VersionRow, "row_version"> & {
    readonly version_row_version: number;
  };

export interface ExpenseClaimMutationResult {
  readonly billingState: typeof HR_EXPENSE_CLAIM_BILLING_STATE;
  readonly expenseClaim: HrExpenseClaimResponse;
  readonly replayed: boolean;
}

const categoryCodes = Object.freeze({
  allowTenantOverride: true,
  defaultValue: "other",
  key: "hr.expense.category_codes",
  validate: (value: string) => {
    const selected = value.split(",");
    return (
      selected.length > 0 &&
      selected.length <= 50 &&
      selected.every((code) => /^[^\s,]{1,64}$/.test(code)) &&
      new Set(selected).size === selected.length
    );
  },
  valueType: "text",
} satisfies SettingDefinition<string>);
const rejectionNoteRequired = Object.freeze({
  allowTenantOverride: true,
  defaultValue: true,
  key: "hr.expense.rejection_note_required",
  validate: (value: boolean) => typeof value === "boolean",
  valueType: "boolean",
} satisfies SettingDefinition<boolean>);
function inputInvalid(message: string): HrExpenseClaimError {
  return new HrExpenseClaimError("EXPENSE_INPUT_INVALID", message);
}
function conflict(message = "Expense Claim currentness check failed"): HrExpenseClaimError {
  return new HrExpenseClaimError("EXPENSE_CONFLICT", message);
}
function versionConflict(): HrExpenseClaimError {
  return new HrExpenseClaimError("EXPENSE_VERSION_CONFLICT", "Expense Claim version conflict");
}
function notFound(): HrExpenseClaimError {
  return new HrExpenseClaimError("EXPENSE_NOT_FOUND", "Expense Claim was not found");
}
function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Expense Claim data",
  );
}
function postgresCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    codes.includes(String((error as { code?: unknown }).code))
  );
}
function normalizeUuid(value: string, field: string): string {
  if (value.length !== 36 || !UUID_PATTERN.test(value)) {
    throw inputInvalid(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}
function normalizeDate(value: string, field: string): string {
  if (!DATE_PATTERN.test(value)) throw inputInvalid(`${field} must be a calendar date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw inputInvalid(`${field} must be a calendar date`);
  }
  return value;
}
function normalizeCurrency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value) || !new Set(Intl.supportedValuesOf("currency")).has(value)) {
    throw inputInvalid("currencyCode must be a supported ISO 4217 currency code");
  }
  return value;
}
function normalizeCategory(value: string): string {
  if (!/^[^\s,]{1,64}$/.test(value)) {
    throw inputInvalid("Expense category code must be an opaque identifier");
  }
  return value;
}
function normalizeDescription(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const selected = value.trim();
  if (selected.length < 1 || selected.length > 500) {
    throw inputInvalid("Expense line description must contain 1 to 500 characters");
  }
  return selected;
}
function normalizeDecisionNote(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const selected = value.trim();
  if (selected.length < 1 || selected.length > 2000) {
    throw inputInvalid("Expense decision note must contain 1 to 2000 characters");
  }
  return selected;
}
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw conflict("Stored Expense Claim timestamp is invalid");
  }
  return parsed.toISOString();
}
function translate(error: unknown): never {
  if (error instanceof HrExpenseClaimError || error instanceof PlatformError) throw error;
  if (postgresCode(error, "42501")) {
    throw new PlatformError("POLICY_DENIED", "Expense Claim denied");
  }
  if (postgresCode(error, "22003", "22007", "22008", "22023", "23514")) {
    throw inputInvalid("Expense Claim data is invalid");
  }
  if (postgresCode(error, "23505", "40001", "40P01", "55000")) throw conflict();
  throw error;
}

async function withExpenseTransaction<T>(
  pool: Pool,
  context: OperationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
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
        dependencies.rows.some(({ state }) => state !== "active")
      ) {
        throw new HrExpenseClaimError(
          "EXPENSE_DEPENDENCY_INACTIVE",
          "Expense Claim dependency is unavailable",
        );
      }
      if (
        dependencies.rows[0]?.service_key !== "workforce_profile" ||
        dependencies.rows[1]?.service_key !== "workspace.task"
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
}

async function authorizeEmployee(transaction: TenantTransaction, action: EmployeeAction) {
  const actionKey = `hr.expense.${action}`;
  const capability = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "tenant" && id === actionKey,
  );
  assertPolicyAllowed(
    evaluatePolicy(
      {
        actionKey,
        input: { capabilityCurrent: registered && capability.rows.length === 1 },
        resourceKey: HR_EXPENSE_CLAIM_SERVICE_KEY,
        transaction,
      },
      [
        {
          effect: "allow",
          id: `current_employee_${action}`,
          matches: (request, actor) => actor.roleKey === "employee" && request.capabilityCurrent,
        },
      ],
    ),
    transaction,
    actionKey,
    HR_EXPENSE_CLAIM_SERVICE_KEY,
  );
}

async function employeeProfile(transaction: TenantTransaction): Promise<string> {
  const result = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id FROM hr_worker_profiles
     WHERE tenant_id=$1 AND principal_id=$2 AND workforce_status='active'
     ORDER BY worker_profile_id LIMIT 2 FOR SHARE`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId],
  );
  if (result.rows.length !== 1 || !result.rows[0]) {
    throw new PlatformError("POLICY_DENIED", "Expense employee authority was denied");
  }
  return result.rows[0].worker_profile_id;
}

async function currentCategories(transaction: TenantTransaction): Promise<ReadonlySet<string>> {
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
    [`hr.expense.settings.v1:${transaction.context.tenantId}`],
  );
  const resolved = await resolveSetting(transaction, categoryCodes);
  return new Set(resolved.value.split(","));
}

async function mapExpenseClaim(
  transaction: TenantTransaction,
  expenseClaimId: string,
  expenseClaimVersionId: string | null = null,
): Promise<HrExpenseClaimResponse> {
  const selected = await transaction.client.query<DetailRow>(
    `SELECT root.expense_claim_id,root.worker_profile_id,root.created_at,
            root.current_version_id,root.row_version,
            version.expense_claim_version_id,version.expense_claim_id,
            version.supersedes_version_id,version.version,version.currency_code,
            version.status,version.assigned_approver_worker_profile_id,
            version.submitted_at,version.total_amount_minor,
            version.row_version version_row_version
     FROM hr_expense_claims root JOIN hr_expense_claim_versions version
       ON version.tenant_id=root.tenant_id
      AND version.expense_claim_id=root.expense_claim_id
      AND version.expense_claim_version_id=COALESCE($3::uuid,root.current_version_id)
     WHERE root.tenant_id=$1 AND root.expense_claim_id=$2`,
    [transaction.context.tenantId, expenseClaimId, expenseClaimVersionId],
  );
  const row = selected.rows[0];
  if (!row) throw notFound();
  const lines = await transaction.client.query<LineRow>(
    `SELECT expense_line_id,expense_date::text,category_code,amount_minor,
            description,row_version
     FROM hr_expense_claim_lines
     WHERE tenant_id=$1 AND expense_claim_version_id=$2
     ORDER BY expense_date,expense_line_id LIMIT 51`,
    [transaction.context.tenantId, row.expense_claim_version_id],
  );
  if (lines.rows.length > 50) throw conflict("Stored Expense Claim line bound is invalid");
  return parseHrExpenseClaimResponse({
    currentVersion: {
      assignedApproverWorkerProfileId: row.assigned_approver_worker_profile_id,
      currencyCode: row.currency_code,
      expenseClaimVersionId: row.expense_claim_version_id,
      lines: lines.rows.map((line) => ({
        amountMinor: line.amount_minor,
        categoryCode: line.category_code,
        description: line.description,
        expenseDate: line.expense_date,
        expenseLineId: line.expense_line_id,
        version: line.row_version,
      })),
      rowVersion: row.version_row_version,
      status: row.status,
      submittedAt: iso(row.submitted_at),
      supersedesVersionId: row.supersedes_version_id,
      totalAmountMinor: row.total_amount_minor,
      version: row.version,
    },
    expenseClaimId: row.expense_claim_id,
    rootVersion: row.row_version,
    workerProfileId: row.worker_profile_id,
  });
}

async function prepareReceipt(
  transaction: TenantTransaction,
  action: ExpenseAction,
  idempotencyKey: string,
  semantics: unknown,
): Promise<Receipt> {
  const receiptId = deriveStableUuid(
    "hr.expense.idempotency.v1",
    transaction.context.tenantId,
    transaction.context.actorPrincipalId,
    action,
    normalizeUuid(idempotencyKey, "idempotencyKey"),
  );
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
    [receiptId],
  );
  return {
    action,
    eventType: `hr.expense.${action}`,
    receiptId,
    semanticSha256: sha256(semantics),
  };
}

async function readReplay(
  transaction: TenantTransaction,
  receipt: Receipt,
  replayInput:
    | HrExpenseClaimDecisionBody
    | HrExpenseClaimEditDraftBody
    | HrExpenseClaimSubmitBody
    | null = null,
): Promise<HrExpenseClaimResponse | null> {
  const found = await transaction.client.query<{
    actor_principal_id: string;
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT actor_principal_id,correlation_id,prior_state,new_state FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3
       AND event_type=$4 LIMIT 2`,
    [
      transaction.context.tenantId,
      SUBJECT_RECEIPT,
      receipt.receiptId,
      `${receipt.eventType}.response_bound`,
    ],
  );
  if (found.rows.length === 0) return null;
  const binding = found.rows[0];
  if (
    found.rows.length !== 1 ||
    binding?.actor_principal_id !== transaction.context.actorPrincipalId ||
    binding.prior_state !== receipt.semanticSha256
  ) {
    throw idempotencyConflict();
  }
  const proof = await transaction.client.query<{
    aggregate_id: string;
    aggregate_type: string;
    aggregate_version: number;
    new_state: string;
    payload: unknown;
    prior_state: string | null;
    subject_type: string;
  }>(
    `SELECT outbox.aggregate_id,outbox.aggregate_type,outbox.aggregate_version,outbox.payload,
            evidence.subject_type,evidence.prior_state,evidence.new_state
     FROM evidence_events evidence JOIN outbox_events outbox
       ON outbox.tenant_id=evidence.tenant_id
      AND outbox.event_type=evidence.event_type
      AND outbox.aggregate_type=evidence.subject_type
      AND outbox.aggregate_id=evidence.subject_id
      AND outbox.correlation_id=evidence.correlation_id
     WHERE evidence.tenant_id=$1 AND evidence.event_type=$2
       AND evidence.correlation_id=$3 AND evidence.actor_principal_id=$4
       AND outbox.payload->>'receiptId'=$5 LIMIT 2`,
    [
      transaction.context.tenantId,
      receipt.eventType,
      binding.correlation_id,
      transaction.context.actorPrincipalId,
      receipt.receiptId,
    ],
  );
  const recorded = proof.rows[0];
  const payload =
    typeof recorded?.payload === "object" &&
    recorded.payload !== null &&
    !Array.isArray(recorded.payload)
      ? (recorded.payload as Record<string, unknown>)
      : null;
  const beforeVersion = receipt.action === "create" ? null : replayInput?.expectedVersion;
  const afterVersion = (beforeVersion ?? 0) + 1;
  const transition =
    receipt.action === "approve"
      ? (["submitted", "approved"] as const)
      : receipt.action === "reject"
        ? (["submitted", "rejected"] as const)
        : receipt.action === "submit"
          ? (["draft", "submitted"] as const)
          : receipt.action === "edit_draft"
            ? (["draft", "draft"] as const)
            : ([null, "draft"] as const);
  if (
    proof.rows.length !== 1 ||
    !recorded ||
    !payload ||
    Object.keys(payload).sort().join(",") !==
      "action,afterVersion,beforeVersion,billingState,expenseClaimId,payloadVersion,receiptId" ||
    payload.action !== receipt.action ||
    payload.afterVersion !== afterVersion ||
    payload.beforeVersion !== beforeVersion ||
    payload.billingState !== HR_EXPENSE_CLAIM_BILLING_STATE ||
    payload.payloadVersion !== 1 ||
    payload.receiptId !== receipt.receiptId ||
    recorded.aggregate_type !== SUBJECT_VERSION ||
    recorded.subject_type !== SUBJECT_VERSION ||
    recorded.aggregate_version !== afterVersion ||
    recorded?.prior_state !== transition[0] ||
    recorded?.new_state !== transition[1] ||
    !UUID_PATTERN.test(String(payload.expenseClaimId))
  ) {
    throw idempotencyConflict();
  }
  const expenseClaimId = String(payload.expenseClaimId).toLowerCase();
  const versionId =
    receipt.action === "create"
      ? deriveStableUuid("hr.expense.version.v1", receipt.receiptId)
      : normalizeUuid(
          replayInput?.expectedExpenseClaimVersionId ?? "",
          "expectedExpenseClaimVersionId",
        );
  if (recorded.aggregate_id !== versionId) throw idempotencyConflict();
  const current = await mapExpenseClaim(transaction, expenseClaimId, versionId);
  let result: HrExpenseClaimResponse;
  if (receipt.action === "create") {
    result = parseHrExpenseClaimResponse({
      ...current,
      currentVersion: {
        ...current.currentVersion,
        assignedApproverWorkerProfileId: null,
        lines: [],
        rowVersion: 1,
        status: "draft",
        submittedAt: null,
        totalAmountMinor: 0,
      },
      rootVersion: 1,
    });
  } else if (replayInput && (receipt.action === "approve" || receipt.action === "reject")) {
    result = parseHrExpenseClaimResponse({
      ...current,
      currentVersion: {
        ...current.currentVersion,
        rowVersion: afterVersion,
        status: receipt.action === "approve" ? "approved" : "rejected",
      },
      rootVersion: replayInput.expectedRootVersion,
    });
  } else if (replayInput && "lines" in replayInput) {
    const lines = replayInput.lines
      .map((line, index) => ({
        amountMinor: line.amountMinor,
        categoryCode: normalizeCategory(line.categoryCode),
        description: normalizeDescription(line.description),
        expenseDate: normalizeDate(line.expenseDate, "expenseDate"),
        expenseLineId: line.expenseLineId
          ? normalizeUuid(line.expenseLineId, "expenseLineId")
          : deriveStableUuid("hr.expense.line.v1", receipt.receiptId, String(index)),
        version: line.expectedVersion ? line.expectedVersion + 1 : 1,
      }))
      .sort(
        (left, right) =>
          left.expenseDate.localeCompare(right.expenseDate) ||
          left.expenseLineId.localeCompare(right.expenseLineId),
      );
    result = parseHrExpenseClaimResponse({
      ...current,
      currentVersion: {
        ...current.currentVersion,
        assignedApproverWorkerProfileId: null,
        lines,
        rowVersion: afterVersion,
        status: "draft",
        submittedAt: null,
        totalAmountMinor: lines.reduce((total, line) => total + line.amountMinor, 0),
      },
      rootVersion: replayInput.expectedRootVersion,
    });
  } else if (replayInput) {
    result = parseHrExpenseClaimResponse({
      ...current,
      currentVersion: {
        ...current.currentVersion,
        rowVersion: afterVersion,
        status: "submitted",
      },
      rootVersion: replayInput.expectedRootVersion,
    });
  } else {
    throw idempotencyConflict();
  }
  if (binding.new_state !== sha256(result)) throw idempotencyConflict();
  return result;
}

async function recordResult(
  transaction: TenantTransaction,
  receipt: Receipt,
  expenseClaim: HrExpenseClaimResponse,
  subjectId: string,
  priorState: string | null,
  newState: string,
  beforeVersion: number | null,
  aggregateVersion: number,
): Promise<void> {
  await recordMutationProof(transaction, {
    evidence: {
      eventType: receipt.eventType,
      newState,
      priorState,
      subjectId,
      subjectType: SUBJECT_VERSION,
    },
    outbox: {
      aggregateId: subjectId,
      aggregateType: SUBJECT_VERSION,
      aggregateVersion,
      eventType: receipt.eventType,
      payload: {
        action: receipt.action,
        afterVersion: aggregateVersion,
        beforeVersion,
        billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
        expenseClaimId: expenseClaim.expenseClaimId,
        payloadVersion: 1,
        receiptId: receipt.receiptId,
      },
    },
  });
  const bound = await appendEvidence(transaction, {
    eventType: `${receipt.eventType}.response_bound`,
    newState: sha256(expenseClaim),
    priorState: receipt.semanticSha256,
    subjectId: receipt.receiptId,
    subjectType: SUBJECT_RECEIPT,
  });
  if (bound.replayed) throw idempotencyConflict();
}

export async function createExpenseClaim(
  pool: Pool,
  context: OperationContext,
  input: HrExpenseClaimCreateBody & { readonly idempotencyKey: string },
): Promise<ExpenseClaimMutationResult> {
  const currencyCode = normalizeCurrency(input.currencyCode);
  try {
    return await withExpenseTransaction(pool, context, async (transaction) => {
      await authorizeEmployee(transaction, "create");
      const workerProfileId = await employeeProfile(transaction);
      await currentCategories(transaction);
      const receipt = await prepareReceipt(transaction, "create", input.idempotencyKey, [
        currencyCode,
      ]);
      const replay = await readReplay(transaction, receipt);
      if (replay) {
        return {
          billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
          expenseClaim: replay,
          replayed: true,
        };
      }
      const expenseClaimId = deriveStableUuid("hr.expense.root.v1", receipt.receiptId);
      const versionId = deriveStableUuid("hr.expense.version.v1", receipt.receiptId);
      await transaction.client.query(
        `INSERT INTO hr_expense_claims
           (expense_claim_id,tenant_id,worker_profile_id,current_version_id)
         VALUES ($1,$2,$3,$4)`,
        [expenseClaimId, transaction.context.tenantId, workerProfileId, versionId],
      );
      await transaction.client.query(
        `INSERT INTO hr_expense_claim_versions
           (expense_claim_version_id,tenant_id,expense_claim_id,version,currency_code)
         VALUES ($1,$2,$3,1,$4)`,
        [versionId, transaction.context.tenantId, expenseClaimId, currencyCode],
      );
      const expenseClaim = await mapExpenseClaim(transaction, expenseClaimId);
      await recordResult(transaction, receipt, expenseClaim, versionId, null, "draft", null, 1);
      return {
        billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
        expenseClaim,
        replayed: false,
      };
    });
  } catch (error) {
    return translate(error);
  }
}

export async function editExpenseClaimDraft(
  pool: Pool,
  context: OperationContext,
  expenseClaimIdInput: string,
  input: HrExpenseClaimEditDraftBody & { readonly idempotencyKey: string },
): Promise<ExpenseClaimMutationResult> {
  const expenseClaimId = normalizeUuid(expenseClaimIdInput, "expenseClaimId");
  try {
    return await withExpenseTransaction(pool, context, async (transaction) => {
      await authorizeEmployee(transaction, "edit_draft");
      const workerProfileId = await employeeProfile(transaction);
      const receipt = await prepareReceipt(transaction, "edit_draft", input.idempotencyKey, [
        expenseClaimId,
        input,
      ]);
      const replay = await readReplay(transaction, receipt, input);
      if (replay) {
        return {
          billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
          expenseClaim: replay,
          replayed: true,
        };
      }
      const configuredCategories = await currentCategories(transaction);
      const root = await transaction.client.query<RootRow>(
        `SELECT expense_claim_id,worker_profile_id,created_at,current_version_id,row_version
         FROM hr_expense_claims
         WHERE tenant_id=$1 AND expense_claim_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, expenseClaimId],
      );
      const selectedRoot = root.rows[0];
      if (!selectedRoot || selectedRoot.worker_profile_id !== workerProfileId) throw notFound();
      const expectedVersionId = normalizeUuid(
        input.expectedExpenseClaimVersionId,
        "expectedExpenseClaimVersionId",
      );
      if (
        selectedRoot.row_version !== input.expectedRootVersion ||
        selectedRoot.current_version_id !== expectedVersionId
      ) {
        throw versionConflict();
      }
      const version = await transaction.client.query<VersionRow>(
        `SELECT expense_claim_version_id,expense_claim_id,supersedes_version_id,
                version,currency_code,status,assigned_approver_worker_profile_id,
                submitted_at,total_amount_minor,row_version
         FROM hr_expense_claim_versions
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3
         FOR UPDATE`,
        [transaction.context.tenantId, expenseClaimId, expectedVersionId],
      );
      const selectedVersion = version.rows[0];
      if (
        selectedVersion?.status !== "draft" ||
        selectedVersion.row_version !== input.expectedVersion
      ) {
        throw versionConflict();
      }
      const currentLines = await transaction.client.query<LineRow>(
        `SELECT expense_line_id,expense_date::text,category_code,amount_minor,
                description,row_version
         FROM hr_expense_claim_lines
         WHERE tenant_id=$1 AND expense_claim_version_id=$2
         ORDER BY expense_line_id FOR UPDATE`,
        [transaction.context.tenantId, expectedVersionId],
      );
      const existing = new Map(currentLines.rows.map((line) => [line.expense_line_id, line]));
      if (input.lines.length > 50) {
        throw inputInvalid("Expense Claim lines exceed the bound");
      }
      const retained = new Set<string>();
      let totalAmountMinor = 0;
      for (const [index, candidate] of input.lines.entries()) {
        if ((candidate.expenseLineId === undefined) !== (candidate.expectedVersion === undefined)) {
          throw inputInvalid("Expense line identity and version must be supplied together");
        }
        const categoryCode = normalizeCategory(candidate.categoryCode);
        if (!configuredCategories.has(categoryCode)) {
          throw inputInvalid("Expense category is not enabled for this tenant");
        }
        if (
          !Number.isSafeInteger(candidate.amountMinor) ||
          candidate.amountMinor < 1 ||
          candidate.amountMinor > 2_147_483_647 ||
          totalAmountMinor + candidate.amountMinor > 2_147_483_647
        ) {
          throw inputInvalid("Expense total exceeds the bounded integer amount");
        }
        totalAmountMinor += candidate.amountMinor;
        const expenseDate = normalizeDate(candidate.expenseDate, "expenseDate");
        const description = normalizeDescription(candidate.description);
        if (candidate.expenseLineId) {
          const lineId = normalizeUuid(candidate.expenseLineId, "expenseLineId");
          const prior = existing.get(lineId);
          if (!prior || prior.row_version !== candidate.expectedVersion || retained.has(lineId)) {
            throw versionConflict();
          }
          retained.add(lineId);
          const updated = await transaction.client.query(
            `UPDATE hr_expense_claim_lines
             SET expense_date=$3,category_code=$4,amount_minor=$5,description=$6,
                 row_version=row_version+1
             WHERE tenant_id=$1 AND expense_line_id=$2 AND row_version=$7`,
            [
              transaction.context.tenantId,
              lineId,
              expenseDate,
              categoryCode,
              candidate.amountMinor,
              description,
              prior.row_version,
            ],
          );
          if (updated.rowCount !== 1) throw versionConflict();
        } else {
          const lineId = deriveStableUuid("hr.expense.line.v1", receipt.receiptId, String(index));
          retained.add(lineId);
          await transaction.client.query(
            `INSERT INTO hr_expense_claim_lines
               (expense_line_id,tenant_id,expense_claim_version_id,expense_date,
                category_code,amount_minor,description)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              lineId,
              transaction.context.tenantId,
              expectedVersionId,
              expenseDate,
              categoryCode,
              candidate.amountMinor,
              description,
            ],
          );
        }
      }
      const removed = [...existing.keys()].filter((lineId) => !retained.has(lineId));
      if (removed.length > 0) {
        const deleted = await transaction.client.query(
          `DELETE FROM hr_expense_claim_lines
           WHERE tenant_id=$1 AND expense_claim_version_id=$2
             AND expense_line_id=ANY($3::uuid[])`,
          [transaction.context.tenantId, expectedVersionId, removed],
        );
        if (deleted.rowCount !== removed.length) throw versionConflict();
      }
      const updated = await transaction.client.query(
        `UPDATE hr_expense_claim_versions
         SET total_amount_minor=$4,
             updated_at=GREATEST(now(),updated_at + interval '1 microsecond'),
             row_version=row_version+1
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3
           AND row_version=$5 AND status='draft' RETURNING row_version`,
        [
          transaction.context.tenantId,
          expenseClaimId,
          expectedVersionId,
          totalAmountMinor,
          selectedVersion.row_version,
        ],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      const expenseClaim = await mapExpenseClaim(transaction, expenseClaimId);
      await recordResult(
        transaction,
        receipt,
        expenseClaim,
        expectedVersionId,
        "draft",
        "draft",
        selectedVersion.row_version,
        expenseClaim.currentVersion.rowVersion,
      );
      return {
        billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
        expenseClaim,
        replayed: false,
      };
    });
  } catch (error) {
    return translate(error);
  }
}

async function currentApprover(
  transaction: TenantTransaction,
  workerProfileId: string,
): Promise<{ managerPrincipalId: string; managerWorkerProfileId: string }> {
  const candidate = await transaction.client.query<{
    manager_principal_id: string | null;
    manager_worker_profile_id: string;
    reporting_relationship_id: string;
  }>(
    `SELECT manager.principal_id manager_principal_id,
            manager.worker_profile_id manager_worker_profile_id,
            relationship.reporting_relationship_id
     FROM hr_worker_profiles worker JOIN hr_reporting_relationships relationship
       ON relationship.tenant_id=worker.tenant_id
      AND relationship.worker_profile_id=worker.worker_profile_id
      AND relationship.reporting_relationship_id=worker.current_reporting_relationship_id
     JOIN hr_worker_profiles manager
       ON manager.tenant_id=relationship.tenant_id
      AND manager.worker_profile_id=relationship.manager_worker_profile_id
     WHERE worker.tenant_id=$1 AND worker.worker_profile_id=$2
       AND worker.workforce_status='active'
       AND relationship.relationship_status='assigned'
       AND manager.workforce_status='active'`,
    [transaction.context.tenantId, workerProfileId],
  );
  const selected = candidate.rows[0];
  if (!selected?.manager_principal_id || candidate.rows.length !== 1) {
    throw new HrExpenseClaimError(
      "EXPENSE_APPROVER_UNAVAILABLE",
      "A current Expense Claim approver is unavailable",
    );
  }
  const authority = await lockMembershipAuthority(
    transaction.client,
    transaction.context,
    selected.manager_principal_id,
  );
  if (authority?.status !== "active" || authority.roleKey !== "manager") {
    throw new HrExpenseClaimError(
      "EXPENSE_APPROVER_UNAVAILABLE",
      "A current Expense Claim approver is unavailable",
    );
  }
  const locked = await transaction.client.query(
    `SELECT 1 FROM hr_worker_profiles worker JOIN hr_reporting_relationships relationship
       ON relationship.tenant_id=worker.tenant_id
      AND relationship.worker_profile_id=worker.worker_profile_id
      AND relationship.reporting_relationship_id=worker.current_reporting_relationship_id
     JOIN hr_worker_profiles manager
       ON manager.tenant_id=relationship.tenant_id
      AND manager.worker_profile_id=relationship.manager_worker_profile_id
     WHERE worker.tenant_id=$1 AND worker.worker_profile_id=$2
       AND relationship.reporting_relationship_id=$3
       AND relationship.relationship_status='assigned'
       AND manager.worker_profile_id=$4 AND manager.principal_id=$5
       AND worker.workforce_status='active' AND manager.workforce_status='active'
     FOR SHARE OF worker,manager`,
    [
      transaction.context.tenantId,
      workerProfileId,
      selected.reporting_relationship_id,
      selected.manager_worker_profile_id,
      selected.manager_principal_id,
    ],
  );
  if (locked.rows.length !== 1) {
    throw new HrExpenseClaimError(
      "EXPENSE_APPROVER_UNAVAILABLE",
      "A current Expense Claim approver is unavailable",
    );
  }
  return {
    managerPrincipalId: selected.manager_principal_id,
    managerWorkerProfileId: selected.manager_worker_profile_id,
  };
}

export async function submitExpenseClaim(
  pool: Pool,
  context: OperationContext,
  expenseClaimIdInput: string,
  input: HrExpenseClaimSubmitBody & { readonly idempotencyKey: string },
): Promise<ExpenseClaimMutationResult> {
  const expenseClaimId = normalizeUuid(expenseClaimIdInput, "expenseClaimId");
  try {
    return await withExpenseTransaction(pool, context, async (transaction) => {
      await authorizeEmployee(transaction, "submit");
      const workerProfileId = await employeeProfile(transaction);
      const receipt = await prepareReceipt(transaction, "submit", input.idempotencyKey, [
        expenseClaimId,
        input,
      ]);
      const replay = await readReplay(transaction, receipt, input);
      if (replay) {
        return {
          billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
          expenseClaim: replay,
          replayed: true,
        };
      }
      const configuredCategories = await currentCategories(transaction);
      const approver = await currentApprover(transaction, workerProfileId);
      const root = await transaction.client.query<RootRow>(
        `SELECT expense_claim_id,worker_profile_id,created_at,current_version_id,row_version
         FROM hr_expense_claims
         WHERE tenant_id=$1 AND expense_claim_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, expenseClaimId],
      );
      const selectedRoot = root.rows[0];
      if (!selectedRoot || selectedRoot.worker_profile_id !== workerProfileId) throw notFound();
      const versionId = normalizeUuid(
        input.expectedExpenseClaimVersionId,
        "expectedExpenseClaimVersionId",
      );
      if (
        selectedRoot.row_version !== input.expectedRootVersion ||
        selectedRoot.current_version_id !== versionId
      ) {
        throw versionConflict();
      }
      const version = await transaction.client.query<VersionRow>(
        `SELECT expense_claim_version_id,expense_claim_id,supersedes_version_id,
                version,currency_code,status,assigned_approver_worker_profile_id,
                submitted_at,total_amount_minor,row_version
         FROM hr_expense_claim_versions
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3
         FOR UPDATE`,
        [transaction.context.tenantId, expenseClaimId, versionId],
      );
      const selectedVersion = version.rows[0];
      if (
        selectedVersion?.status !== "draft" ||
        selectedVersion.row_version !== input.expectedVersion
      ) {
        throw versionConflict();
      }
      const totals = await transaction.client.query<{
        invalid_category: boolean;
        line_count: number;
        total: string;
      }>(
        `SELECT count(*)::integer line_count,
                COALESCE(sum(amount_minor),0)::text total,
                COALESCE(bool_or(NOT (category_code=ANY($3::text[]))),false)
                  invalid_category
         FROM hr_expense_claim_lines
         WHERE tenant_id=$1 AND expense_claim_version_id=$2`,
        [transaction.context.tenantId, versionId, [...configuredCategories]],
      );
      const summary = totals.rows[0];
      const total = Number(summary?.total ?? -1);
      if (
        !summary ||
        summary.line_count < 1 ||
        summary.line_count > 50 ||
        !Number.isSafeInteger(total) ||
        total < 1 ||
        total > 2_147_483_647 ||
        total !== selectedVersion.total_amount_minor ||
        summary.invalid_category
      ) {
        throw conflict("Expense Claim lines are not valid for submission");
      }
      const updated = await transaction.client.query(
        `UPDATE hr_expense_claim_versions
         SET status='submitted',assigned_approver_worker_profile_id=$4,submitted_at=now(),
             updated_at=GREATEST(now(),updated_at + interval '1 microsecond'),
             row_version=row_version+1
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3
           AND row_version=$5 AND status='draft' RETURNING row_version`,
        [
          transaction.context.tenantId,
          expenseClaimId,
          versionId,
          approver.managerWorkerProfileId,
          selectedVersion.row_version,
        ],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      await createWorkItem(transaction, {
        assigneePrincipalId: approver.managerPrincipalId,
        subjectId: versionId,
        subjectType: SUBJECT_VERSION,
        workItemId: deriveStableUuid("hr.expense.work_item.v1", receipt.receiptId),
        workType: WORK_TYPE,
      });
      const expenseClaim = await mapExpenseClaim(transaction, expenseClaimId);
      await recordResult(
        transaction,
        receipt,
        expenseClaim,
        versionId,
        "draft",
        "submitted",
        selectedVersion.row_version,
        expenseClaim.currentVersion.rowVersion,
      );
      return {
        billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
        expenseClaim,
        replayed: false,
      };
    });
  } catch (error) {
    return translate(error);
  }
}

async function managerProfile(
  transaction: TenantTransaction,
  action: ManagerAction,
): Promise<string> {
  const actionKey = `hr.expense.${action}`;
  const capability = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  const profile = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id FROM hr_worker_profiles
     WHERE tenant_id=$1 AND principal_id=$2 AND workforce_status='active'
     ORDER BY worker_profile_id LIMIT 2 FOR SHARE`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId],
  );
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "tenant" && id === actionKey,
  );
  assertPolicyAllowed(
    evaluatePolicy(
      {
        actionKey,
        input: {
          capabilityCurrent: registered && capability.rows.length === 1,
          profileCurrent: profile.rows.length === 1,
        },
        resourceKey: HR_EXPENSE_CLAIM_SERVICE_KEY,
        transaction,
      },
      [
        {
          effect: "allow",
          id: `current_manager_${action}`,
          matches: (request, actor) =>
            actor.roleKey === "manager" && request.capabilityCurrent && request.profileCurrent,
        },
      ],
    ),
    transaction,
    actionKey,
    HR_EXPENSE_CLAIM_SERVICE_KEY,
  );
  const selected = profile.rows[0];
  if (!selected) {
    throw new PlatformError("POLICY_DENIED", "Expense manager authority was denied");
  }
  return selected.worker_profile_id;
}

async function rejectionNoteIsRequired(transaction: TenantTransaction): Promise<boolean> {
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
    [`hr.expense.settings.v1:${transaction.context.tenantId}`],
  );
  return (await resolveSetting(transaction, rejectionNoteRequired)).value;
}

async function decideExpenseClaim(
  pool: Pool,
  context: OperationContext,
  expenseClaimIdInput: string,
  input: HrExpenseClaimDecisionBody & { readonly idempotencyKey: string },
  action: ManagerAction,
): Promise<ExpenseClaimMutationResult> {
  const expenseClaimId = normalizeUuid(expenseClaimIdInput, "expenseClaimId");
  const decisionNote = normalizeDecisionNote(input.decisionNote);
  try {
    return await withExpenseTransaction(pool, context, async (transaction) => {
      const approverWorkerProfileId = await managerProfile(transaction, action);
      const noteRequired = action === "reject" ? await rejectionNoteIsRequired(transaction) : false;
      const versionId = normalizeUuid(
        input.expectedExpenseClaimVersionId,
        "expectedExpenseClaimVersionId",
      );
      const receipt = await prepareReceipt(transaction, action, input.idempotencyKey, [
        expenseClaimId,
        input.expectedRootVersion,
        versionId,
        input.expectedVersion,
        decisionNote,
      ]);
      const root = await transaction.client.query<RootRow>(
        `SELECT expense_claim_id,worker_profile_id,created_at,current_version_id,row_version
         FROM hr_expense_claims
         WHERE tenant_id=$1 AND expense_claim_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, expenseClaimId],
      );
      const selectedRoot = root.rows[0];
      if (!selectedRoot) throw notFound();
      if (
        selectedRoot.row_version !== input.expectedRootVersion ||
        selectedRoot.current_version_id !== versionId
      ) {
        throw versionConflict();
      }
      const version = await transaction.client.query<VersionRow>(
        `SELECT expense_claim_version_id,expense_claim_id,supersedes_version_id,
                version,currency_code,status,assigned_approver_worker_profile_id,
                submitted_at,total_amount_minor,row_version
         FROM hr_expense_claim_versions
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3
         FOR UPDATE`,
        [transaction.context.tenantId, expenseClaimId, versionId],
      );
      const selectedVersion = version.rows[0];
      if (!selectedVersion) throw versionConflict();
      const work = await transaction.client.query<WorkRow>(
        `SELECT work_item_id,assignee_principal_id,status,work_type,subject_type,subject_id
         FROM work_items
         WHERE tenant_id=$1 AND work_type=$2 AND subject_type=$3 AND subject_id=$4
         ORDER BY work_item_id LIMIT 2 FOR UPDATE`,
        [transaction.context.tenantId, WORK_TYPE, SUBJECT_VERSION, versionId],
      );
      const selectedWork = work.rows[0];
      const assignmentCurrent =
        work.rows.length === 1 &&
        selectedVersion.assigned_approver_worker_profile_id === approverWorkerProfileId &&
        selectedWork?.assignee_principal_id === transaction.context.actorPrincipalId &&
        selectedWork.work_type === WORK_TYPE &&
        selectedWork.subject_type === SUBJECT_VERSION &&
        selectedWork.subject_id === versionId &&
        selectedWork.status !== "cancelled";
      const actionKey = `hr.expense.${action}`;
      assertPolicyAllowed(
        evaluatePolicy(
          {
            actionKey,
            input: { assignmentCurrent },
            resourceKey: versionId,
            transaction,
          },
          [
            {
              effect: "allow",
              id: `exact_assigned_manager_${action}`,
              matches: (request, actor) => actor.roleKey === "manager" && request.assignmentCurrent,
            },
          ],
        ),
        transaction,
        actionKey,
        versionId,
      );
      const replay = await readReplay(transaction, receipt, input);
      if (replay) {
        return {
          billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
          expenseClaim: replay,
          replayed: true,
        };
      }
      if (noteRequired && !decisionNote) {
        throw inputInvalid("An Expense Claim rejection note is required by tenant policy");
      }
      if (
        selectedVersion.status !== "submitted" ||
        selectedVersion.row_version !== input.expectedVersion ||
        selectedWork?.status !== "open"
      ) {
        throw versionConflict();
      }
      const targetStatus = action === "approve" ? "approved" : "rejected";
      await transaction.client.query(
        `INSERT INTO hr_expense_claim_approvals
           (expense_approval_id,tenant_id,expense_claim_version_id,
            approver_worker_profile_id,decision,decision_note,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          deriveStableUuid("hr.expense.approval.v1", receipt.receiptId),
          transaction.context.tenantId,
          versionId,
          approverWorkerProfileId,
          targetStatus,
          decisionNote,
          transaction.context.correlationId,
        ],
      );
      const updated = await transaction.client.query(
        `UPDATE hr_expense_claim_versions
         SET status=$4,updated_at=GREATEST(now(),updated_at + interval '1 microsecond'),
             row_version=row_version+1
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3
           AND status='submitted' AND row_version=$5
         RETURNING row_version`,
        [
          transaction.context.tenantId,
          expenseClaimId,
          versionId,
          targetStatus,
          selectedVersion.row_version,
        ],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      await completeWorkItem(transaction, selectedWork.work_item_id);
      const expenseClaim = await mapExpenseClaim(transaction, expenseClaimId);
      await recordResult(
        transaction,
        receipt,
        expenseClaim,
        versionId,
        "submitted",
        targetStatus,
        selectedVersion.row_version,
        expenseClaim.currentVersion.rowVersion,
      );
      return {
        billingState: HR_EXPENSE_CLAIM_BILLING_STATE,
        expenseClaim,
        replayed: false,
      };
    });
  } catch (error) {
    return translate(error);
  }
}

export async function approveExpenseClaim(
  pool: Pool,
  context: OperationContext,
  expenseClaimId: string,
  input: HrExpenseClaimApproveBody & { readonly idempotencyKey: string },
): Promise<ExpenseClaimMutationResult> {
  return await decideExpenseClaim(pool, context, expenseClaimId, input, "approve");
}

export async function rejectExpenseClaim(
  pool: Pool,
  context: OperationContext,
  expenseClaimId: string,
  input: HrExpenseClaimRejectBody & { readonly idempotencyKey: string },
): Promise<ExpenseClaimMutationResult> {
  return await decideExpenseClaim(pool, context, expenseClaimId, input, "reject");
}
