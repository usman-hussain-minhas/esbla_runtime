import { createHash } from "node:crypto";
import {
  type HrTimesheetApproveBody,
  type HrTimesheetCreateBody,
  type HrTimesheetDecisionBody,
  type HrTimesheetEditDraftBody,
  type HrTimesheetRejectBody,
  type HrTimesheetResponse,
  type HrTimesheetSubmitBody,
  parseHrTimesheetResponse,
} from "@esbla/contracts";
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
import { hrManifest } from "./manifest.js";
import {
  HR_TIMESHEET_BILLING_STATE,
  HR_TIMESHEET_SERVICE_KEY,
  HrTimesheetError,
} from "./timesheet-service-control.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUBJECT_VERSION = "hr.timesheet.version";
const SUBJECT_RECEIPT = "hr.timesheet.idempotency";
const WORK_TYPE = "hr.timesheet.approval";
type EmployeeAction = "create" | "edit_draft" | "submit";
type ManagerAction = "approve" | "reject";
type TimesheetAction = EmployeeAction | ManagerAction;
interface Receipt {
  readonly action: TimesheetAction;
  readonly eventType: string;
  readonly receiptId: string;
  readonly semanticSha256: string;
}
interface RootRow {
  readonly current_version_id: string;
  readonly period_end: string;
  readonly period_start: string;
  readonly row_version: number;
  readonly timesheet_id: string;
  readonly worker_profile_id: string;
}
interface VersionRow {
  readonly assigned_approver_worker_profile_id: string | null;
  readonly row_version: number;
  readonly status: "approved" | "draft" | "rejected" | "submitted";
  readonly submitted_at: Date | string | null;
  readonly supersedes_version_id: string | null;
  readonly timesheet_id: string;
  readonly timesheet_version_id: string;
  readonly total_minutes: number;
  readonly version: number;
}
interface EntryRow {
  readonly description: string | null;
  readonly entry_date: string;
  readonly minutes: number;
  readonly row_version: number;
  readonly timesheet_entry_id: string;
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
export interface TimesheetMutationResult {
  readonly billingState: typeof HR_TIMESHEET_BILLING_STATE;
  readonly replayed: boolean;
  readonly timesheet: HrTimesheetResponse;
}

const maxDailyMinutes = Object.freeze({
  allowTenantOverride: true,
  defaultValue: 1440,
  key: "hr.timesheet.max_daily_minutes",
  policyFloor: { kind: "maximum", value: 1440 } as const,
  validate: (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 1440,
  valueType: "integer" as const,
});
const periodCadence = Object.freeze({
  allowTenantOverride: true,
  defaultValue: "weekly",
  key: "hr.timesheet.period_cadence",
  policyFloor: { kind: "locked", value: "weekly" } as const,
  validate: (value: string) => value === "weekly",
  valueType: "enum" as const,
});
const rejectionNoteRequired = Object.freeze({
  allowTenantOverride: true,
  defaultValue: true,
  key: "hr.timesheet.rejection_note_required",
  validate: (value: boolean) => typeof value === "boolean",
  valueType: "boolean",
} satisfies SettingDefinition<boolean>);

function inputInvalid(message: string): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_INPUT_INVALID", message);
}
function conflict(message = "Timesheet currentness check failed"): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_CONFLICT", message);
}
function versionConflict(): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_VERSION_CONFLICT", "Timesheet version conflict");
}
function notFound(): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_NOT_FOUND", "Timesheet was not found");
}
function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Timesheet data",
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
  if (!UUID_PATTERN.test(value)) throw inputInvalid(`${field} must be a UUID`);
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
function weeklyPeriod(periodStart: string, periodEnd: string): readonly [string, string] {
  const start = normalizeDate(periodStart, "periodStart");
  const end = normalizeDate(periodEnd, "periodEnd");
  if (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) !== 6 * 86_400_000) {
    throw inputInvalid("Timesheet period must contain exactly seven inclusive dates");
  }
  return [start, end];
}
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw conflict("Stored Timesheet timestamp is invalid");
  return parsed.toISOString();
}
function normalizeDescription(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const selected = value.trim();
  if (selected.length < 1 || selected.length > 500) {
    throw inputInvalid("Timesheet entry description must contain 1 to 500 characters");
  }
  return selected;
}
function normalizeDecisionNote(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const selected = value.trim();
  if (selected.length < 1 || selected.length > 2000) {
    throw inputInvalid("Timesheet decision note must contain 1 to 2000 characters");
  }
  return selected;
}
function translate(error: unknown): never {
  if (error instanceof HrTimesheetError || error instanceof PlatformError) throw error;
  if (postgresCode(error, "42501")) throw new PlatformError("POLICY_DENIED", "Timesheet denied");
  if (postgresCode(error, "22007", "22008", "22023"))
    throw inputInvalid("Timesheet data is invalid");
  if (postgresCode(error, "23505", "40001", "40P01", "55000")) throw conflict();
  throw error;
}

async function withTimesheetTransaction<T>(
  pool: Pool,
  context: OperationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
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
}

async function authorizeEmployee(
  transaction: TenantTransaction,
  action: EmployeeAction,
): Promise<void> {
  const actionKey = `hr.timesheet.${action}`;
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
        resourceKey: HR_TIMESHEET_SERVICE_KEY,
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
    HR_TIMESHEET_SERVICE_KEY,
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
    throw new PlatformError("POLICY_DENIED", "Timesheet employee authority was denied");
  }
  return result.rows[0].worker_profile_id;
}

async function currentSettings(transaction: TenantTransaction): Promise<{ maximum: number }> {
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
    [`hr.timesheet.settings.v1:${transaction.context.tenantId}`],
  );
  const maximum = await resolveSetting(transaction, maxDailyMinutes);
  const cadence = await resolveSetting(transaction, periodCadence);
  if (cadence.value !== "weekly") throw conflict("Timesheet settings are not current");
  return { maximum: maximum.value };
}

async function mapTimesheet(
  transaction: TenantTransaction,
  timesheetId: string,
  timesheetVersionId: string | null = null,
): Promise<HrTimesheetResponse> {
  const selected = await transaction.client.query<DetailRow>(
    `SELECT root.timesheet_id,root.worker_profile_id,root.period_start::text,
            root.period_end::text,root.current_version_id,root.row_version,
            version.timesheet_version_id,version.timesheet_id,version.supersedes_version_id,
            version.version,version.status,version.assigned_approver_worker_profile_id,
            version.submitted_at,version.total_minutes,
            version.row_version version_row_version
     FROM hr_timesheets root JOIN hr_timesheet_versions version
       ON version.tenant_id=root.tenant_id AND version.timesheet_id=root.timesheet_id
      AND version.timesheet_version_id=COALESCE($3::uuid,root.current_version_id)
     WHERE root.tenant_id=$1 AND root.timesheet_id=$2`,
    [transaction.context.tenantId, timesheetId, timesheetVersionId],
  );
  const row = selected.rows[0];
  if (!row) throw notFound();
  const entries = await transaction.client.query<EntryRow>(
    `SELECT timesheet_entry_id,entry_date::text,minutes,description,row_version
     FROM hr_timesheet_entries WHERE tenant_id=$1 AND timesheet_version_id=$2
     ORDER BY entry_date,timesheet_entry_id LIMIT 51`,
    [transaction.context.tenantId, row.timesheet_version_id],
  );
  if (entries.rows.length > 50) throw conflict("Stored Timesheet entry bound is invalid");
  return parseHrTimesheetResponse({
    currentVersion: {
      assignedApproverWorkerProfileId: row.assigned_approver_worker_profile_id,
      entries: entries.rows.map((entry) => ({
        description: entry.description,
        entryDate: entry.entry_date,
        minutes: entry.minutes,
        timesheetEntryId: entry.timesheet_entry_id,
        version: entry.row_version,
      })),
      rowVersion: row.version_row_version,
      status: row.status,
      submittedAt: iso(row.submitted_at),
      supersedesVersionId: row.supersedes_version_id,
      timesheetVersionId: row.timesheet_version_id,
      totalMinutes: row.total_minutes,
      version: row.version,
    },
    periodEnd: row.period_end,
    periodStart: row.period_start,
    rootVersion: row.row_version,
    timesheetId: row.timesheet_id,
    workerProfileId: row.worker_profile_id,
  });
}

async function prepareReceipt(
  transaction: TenantTransaction,
  action: TimesheetAction,
  idempotencyKey: string,
  semantics: unknown,
): Promise<Receipt> {
  const receiptId = deriveStableUuid(
    "hr.timesheet.idempotency.v1",
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
    eventType: `hr.timesheet.${action}`,
    receiptId,
    semanticSha256: sha256(semantics),
  };
}

async function readReplay(
  transaction: TenantTransaction,
  receipt: Receipt,
  replayInput:
    | HrTimesheetDecisionBody
    | HrTimesheetEditDraftBody
    | HrTimesheetSubmitBody
    | null = null,
): Promise<HrTimesheetResponse | null> {
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
      "action,afterVersion,beforeVersion,billingState,payloadVersion,receiptId,timesheetId" ||
    payload.action !== receipt.action ||
    payload.afterVersion !== afterVersion ||
    payload.beforeVersion !== beforeVersion ||
    payload.billingState !== HR_TIMESHEET_BILLING_STATE ||
    payload.payloadVersion !== 1 ||
    payload.receiptId !== receipt.receiptId ||
    recorded.aggregate_type !== SUBJECT_VERSION ||
    recorded.subject_type !== SUBJECT_VERSION ||
    recorded.aggregate_version !== afterVersion ||
    recorded.prior_state !== transition[0] ||
    recorded.new_state !== transition[1] ||
    !UUID_PATTERN.test(String(payload.timesheetId))
  ) {
    throw idempotencyConflict();
  }
  const timesheetId = String(payload.timesheetId).toLowerCase();
  const timesheetVersionId =
    receipt.action === "create"
      ? deriveStableUuid("hr.timesheet.version.v1", receipt.receiptId)
      : normalizeUuid(replayInput?.expectedTimesheetVersionId ?? "", "expectedTimesheetVersionId");
  if (recorded.aggregate_id !== timesheetVersionId) throw idempotencyConflict();
  const current = await mapTimesheet(transaction, timesheetId, timesheetVersionId);
  let result: HrTimesheetResponse;
  if (receipt.action === "create") {
    result = parseHrTimesheetResponse({
      ...current,
      currentVersion: {
        ...current.currentVersion,
        assignedApproverWorkerProfileId: null,
        entries: [],
        rowVersion: afterVersion,
        status: "draft",
        submittedAt: null,
        totalMinutes: 0,
      },
      rootVersion: 1,
    });
  } else if (replayInput && (receipt.action === "approve" || receipt.action === "reject")) {
    result = parseHrTimesheetResponse({
      ...current,
      currentVersion: {
        ...current.currentVersion,
        rowVersion: afterVersion,
        status: receipt.action === "approve" ? "approved" : "rejected",
      },
      rootVersion: replayInput.expectedRootVersion,
    });
  } else if (replayInput && "entries" in replayInput) {
    const entries = replayInput.entries
      .map((entry, index) => ({
        description: normalizeDescription(entry.description),
        entryDate: normalizeDate(entry.entryDate, "entryDate"),
        minutes: entry.minutes,
        timesheetEntryId: entry.timesheetEntryId
          ? normalizeUuid(entry.timesheetEntryId, "timesheetEntryId")
          : deriveStableUuid("hr.timesheet.entry.v1", receipt.receiptId, String(index)),
        version: entry.expectedVersion ? entry.expectedVersion + 1 : 1,
      }))
      .sort(
        (left, right) =>
          left.entryDate.localeCompare(right.entryDate) ||
          left.timesheetEntryId.localeCompare(right.timesheetEntryId),
      );
    result = parseHrTimesheetResponse({
      ...current,
      currentVersion: {
        ...current.currentVersion,
        assignedApproverWorkerProfileId: null,
        entries,
        rowVersion: afterVersion,
        status: "draft",
        submittedAt: null,
        totalMinutes: entries.reduce((total, entry) => total + entry.minutes, 0),
      },
      rootVersion: replayInput.expectedRootVersion,
    });
  } else if (replayInput) {
    result = parseHrTimesheetResponse({
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
  timesheet: HrTimesheetResponse,
  subjectId: string,
  subjectType: string,
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
      subjectType,
    },
    outbox: {
      aggregateId: subjectId,
      aggregateType: subjectType,
      aggregateVersion,
      eventType: receipt.eventType,
      payload: {
        action: receipt.action,
        afterVersion: aggregateVersion,
        beforeVersion,
        billingState: HR_TIMESHEET_BILLING_STATE,
        payloadVersion: 1,
        receiptId: receipt.receiptId,
        timesheetId: timesheet.timesheetId,
      },
    },
  });
  const bound = await appendEvidence(transaction, {
    eventType: `${receipt.eventType}.response_bound`,
    newState: sha256(timesheet),
    priorState: receipt.semanticSha256,
    subjectId: receipt.receiptId,
    subjectType: SUBJECT_RECEIPT,
  });
  if (bound.replayed) throw idempotencyConflict();
}

export async function createTimesheet(
  pool: Pool,
  context: OperationContext,
  input: HrTimesheetCreateBody & { readonly idempotencyKey: string },
): Promise<TimesheetMutationResult> {
  const [periodStart, periodEnd] = weeklyPeriod(input.periodStart, input.periodEnd);
  try {
    return await withTimesheetTransaction(pool, context, async (transaction) => {
      await authorizeEmployee(transaction, "create");
      const workerProfileId = await employeeProfile(transaction);
      await currentSettings(transaction);
      const receipt = await prepareReceipt(transaction, "create", input.idempotencyKey, [
        periodStart,
        periodEnd,
      ]);
      const replay = await readReplay(transaction, receipt);
      if (replay)
        return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: true, timesheet: replay };
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [
          `hr.timesheet.period:${transaction.context.tenantId}:${workerProfileId}:${periodStart}:${periodEnd}`,
        ],
      );
      const timesheetId = deriveStableUuid("hr.timesheet.root.v1", receipt.receiptId);
      const versionId = deriveStableUuid("hr.timesheet.version.v1", receipt.receiptId);
      await transaction.client.query(
        `INSERT INTO hr_timesheets
           (timesheet_id,tenant_id,worker_profile_id,period_start,period_end,current_version_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          timesheetId,
          transaction.context.tenantId,
          workerProfileId,
          periodStart,
          periodEnd,
          versionId,
        ],
      );
      await transaction.client.query(
        `INSERT INTO hr_timesheet_versions
           (timesheet_version_id,tenant_id,timesheet_id,version)
         VALUES ($1,$2,$3,1)`,
        [versionId, transaction.context.tenantId, timesheetId],
      );
      const timesheet = await mapTimesheet(transaction, timesheetId);
      await recordResult(
        transaction,
        receipt,
        timesheet,
        versionId,
        SUBJECT_VERSION,
        null,
        "draft",
        null,
        1,
      );
      return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: false, timesheet };
    });
  } catch (error) {
    return translate(error);
  }
}

export async function editTimesheetDraft(
  pool: Pool,
  context: OperationContext,
  timesheetIdInput: string,
  input: HrTimesheetEditDraftBody & { readonly idempotencyKey: string },
): Promise<TimesheetMutationResult> {
  const timesheetId = normalizeUuid(timesheetIdInput, "timesheetId");
  try {
    return await withTimesheetTransaction(pool, context, async (transaction) => {
      await authorizeEmployee(transaction, "edit_draft");
      const workerProfileId = await employeeProfile(transaction);
      const receipt = await prepareReceipt(transaction, "edit_draft", input.idempotencyKey, [
        timesheetId,
        input,
      ]);
      const replay = await readReplay(transaction, receipt, input);
      if (replay)
        return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: true, timesheet: replay };
      const settings = await currentSettings(transaction);
      const root = await transaction.client.query<RootRow>(
        `SELECT timesheet_id,worker_profile_id,period_start::text,period_end::text,
                current_version_id,row_version
         FROM hr_timesheets WHERE tenant_id=$1 AND timesheet_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, timesheetId],
      );
      const selectedRoot = root.rows[0];
      if (!selectedRoot || selectedRoot.worker_profile_id !== workerProfileId) throw notFound();
      if (
        selectedRoot.row_version !== input.expectedRootVersion ||
        selectedRoot.current_version_id !==
          normalizeUuid(input.expectedTimesheetVersionId, "expectedTimesheetVersionId")
      ) {
        throw versionConflict();
      }
      const version = await transaction.client.query<VersionRow>(
        `SELECT timesheet_version_id,timesheet_id,supersedes_version_id,version,status,
                assigned_approver_worker_profile_id,submitted_at,total_minutes,row_version
         FROM hr_timesheet_versions
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3 FOR UPDATE`,
        [transaction.context.tenantId, timesheetId, selectedRoot.current_version_id],
      );
      const selectedVersion = version.rows[0];
      if (
        selectedVersion?.status !== "draft" ||
        selectedVersion.row_version !== input.expectedVersion
      ) {
        throw versionConflict();
      }
      const currentEntries = await transaction.client.query<EntryRow>(
        `SELECT timesheet_entry_id,entry_date::text,minutes,description,row_version
         FROM hr_timesheet_entries WHERE tenant_id=$1 AND timesheet_version_id=$2
         ORDER BY timesheet_entry_id FOR UPDATE`,
        [transaction.context.tenantId, selectedVersion.timesheet_version_id],
      );
      const existing = new Map(
        currentEntries.rows.map((entry) => [entry.timesheet_entry_id, entry]),
      );
      if (input.entries.length > 50) throw inputInvalid("Timesheet entries exceed the bound");
      const retained = new Set<string>();
      const daily = new Map<string, number>();
      const maximum = settings.maximum;
      for (const [index, candidate] of input.entries.entries()) {
        if (
          (candidate.timesheetEntryId === undefined) !==
          (candidate.expectedVersion === undefined)
        ) {
          throw inputInvalid("Timesheet entry identity and version must be supplied together");
        }
        const entryDate = normalizeDate(candidate.entryDate, "entryDate");
        if (entryDate < selectedRoot.period_start || entryDate > selectedRoot.period_end) {
          throw inputInvalid("Timesheet entry date is outside the period");
        }
        if (
          !Number.isSafeInteger(candidate.minutes) ||
          candidate.minutes < 1 ||
          candidate.minutes > maximum
        ) {
          throw inputInvalid("Timesheet entry minutes exceed the configured daily bound");
        }
        daily.set(entryDate, (daily.get(entryDate) ?? 0) + candidate.minutes);
        if ((daily.get(entryDate) ?? 0) > maximum) {
          throw inputInvalid("Timesheet daily minutes exceed the configured bound");
        }
        const description = normalizeDescription(candidate.description);
        if (candidate.timesheetEntryId) {
          const entryId = normalizeUuid(candidate.timesheetEntryId, "timesheetEntryId");
          const prior = existing.get(entryId);
          if (!prior || prior.row_version !== candidate.expectedVersion || retained.has(entryId)) {
            throw versionConflict();
          }
          retained.add(entryId);
          await transaction.client.query(
            `UPDATE hr_timesheet_entries
             SET entry_date=$3,minutes=$4,description=$5,row_version=row_version+1
             WHERE tenant_id=$1 AND timesheet_entry_id=$2 AND row_version=$6`,
            [
              transaction.context.tenantId,
              entryId,
              entryDate,
              candidate.minutes,
              description,
              prior.row_version,
            ],
          );
        } else {
          const entryId = deriveStableUuid(
            "hr.timesheet.entry.v1",
            receipt.receiptId,
            String(index),
          );
          retained.add(entryId);
          await transaction.client.query(
            `INSERT INTO hr_timesheet_entries
               (timesheet_entry_id,tenant_id,timesheet_version_id,entry_date,minutes,description)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              entryId,
              transaction.context.tenantId,
              selectedVersion.timesheet_version_id,
              entryDate,
              candidate.minutes,
              description,
            ],
          );
        }
      }
      const removed = [...existing.keys()].filter((entryId) => !retained.has(entryId));
      if (removed.length > 0) {
        await transaction.client.query(
          `DELETE FROM hr_timesheet_entries
           WHERE tenant_id=$1 AND timesheet_version_id=$2 AND timesheet_entry_id=ANY($3::uuid[])`,
          [transaction.context.tenantId, selectedVersion.timesheet_version_id, removed],
        );
      }
      const totalMinutes = [...daily.values()].reduce((sum, value) => sum + value, 0);
      const updated = await transaction.client.query(
        `UPDATE hr_timesheet_versions
         SET total_minutes=$4,updated_at=GREATEST(now(),updated_at + interval '1 microsecond'),
             row_version=row_version+1
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3
           AND row_version=$5 AND status='draft' RETURNING row_version`,
        [
          transaction.context.tenantId,
          timesheetId,
          selectedVersion.timesheet_version_id,
          totalMinutes,
          selectedVersion.row_version,
        ],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      const timesheet = await mapTimesheet(transaction, timesheetId);
      await recordResult(
        transaction,
        receipt,
        timesheet,
        selectedVersion.timesheet_version_id,
        SUBJECT_VERSION,
        "draft",
        "draft",
        selectedVersion.row_version,
        timesheet.currentVersion.rowVersion,
      );
      return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: false, timesheet };
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
       AND worker.workforce_status='active' AND relationship.relationship_status='assigned'
       AND manager.workforce_status='active'`,
    [transaction.context.tenantId, workerProfileId],
  );
  const selected = candidate.rows[0];
  if (!selected?.manager_principal_id || candidate.rows.length !== 1) {
    throw new HrTimesheetError(
      "TIMESHEET_APPROVER_UNAVAILABLE",
      "A current Timesheet approver is unavailable",
    );
  }
  const authority = await lockMembershipAuthority(
    transaction.client,
    transaction.context,
    selected.manager_principal_id,
  );
  if (authority?.status !== "active" || authority.roleKey !== "manager") {
    throw new HrTimesheetError(
      "TIMESHEET_APPROVER_UNAVAILABLE",
      "A current Timesheet approver is unavailable",
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
    throw new HrTimesheetError(
      "TIMESHEET_APPROVER_UNAVAILABLE",
      "A current Timesheet approver is unavailable",
    );
  }
  return {
    managerPrincipalId: selected.manager_principal_id,
    managerWorkerProfileId: selected.manager_worker_profile_id,
  };
}

export async function submitTimesheet(
  pool: Pool,
  context: OperationContext,
  timesheetIdInput: string,
  input: HrTimesheetSubmitBody & { readonly idempotencyKey: string },
): Promise<TimesheetMutationResult> {
  const timesheetId = normalizeUuid(timesheetIdInput, "timesheetId");
  try {
    return await withTimesheetTransaction(pool, context, async (transaction) => {
      await authorizeEmployee(transaction, "submit");
      const workerProfileId = await employeeProfile(transaction);
      const receipt = await prepareReceipt(transaction, "submit", input.idempotencyKey, [
        timesheetId,
        input,
      ]);
      const replay = await readReplay(transaction, receipt, input);
      if (replay)
        return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: true, timesheet: replay };
      const settings = await currentSettings(transaction);
      const approver = await currentApprover(transaction, workerProfileId);
      const root = await transaction.client.query<RootRow>(
        `SELECT timesheet_id,worker_profile_id,period_start::text,period_end::text,
                current_version_id,row_version
         FROM hr_timesheets WHERE tenant_id=$1 AND timesheet_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, timesheetId],
      );
      const selectedRoot = root.rows[0];
      if (!selectedRoot || selectedRoot.worker_profile_id !== workerProfileId) throw notFound();
      if (
        selectedRoot.row_version !== input.expectedRootVersion ||
        selectedRoot.current_version_id !==
          normalizeUuid(input.expectedTimesheetVersionId, "expectedTimesheetVersionId")
      ) {
        throw versionConflict();
      }
      const version = await transaction.client.query<VersionRow>(
        `SELECT timesheet_version_id,timesheet_id,supersedes_version_id,version,status,
                assigned_approver_worker_profile_id,submitted_at,total_minutes,row_version
         FROM hr_timesheet_versions
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3 FOR UPDATE`,
        [transaction.context.tenantId, timesheetId, selectedRoot.current_version_id],
      );
      const selectedVersion = version.rows[0];
      if (
        selectedVersion?.status !== "draft" ||
        selectedVersion.row_version !== input.expectedVersion
      ) {
        throw versionConflict();
      }
      const entries = await transaction.client.query<{ daily_total: number; total: number }>(
        `SELECT sum(daily_total)::integer total,max(daily_total)::integer daily_total
         FROM (SELECT sum(minutes)::integer daily_total
               FROM hr_timesheet_entries
               WHERE tenant_id=$1 AND timesheet_version_id=$2 GROUP BY entry_date) daily`,
        [transaction.context.tenantId, selectedVersion.timesheet_version_id],
      );
      const totals = entries.rows[0];
      const maximum = settings.maximum;
      if (
        !totals ||
        totals.total <= 0 ||
        totals.total !== selectedVersion.total_minutes ||
        totals.daily_total > maximum
      ) {
        throw conflict("Timesheet entries are not valid for submission");
      }
      const updated = await transaction.client.query(
        `UPDATE hr_timesheet_versions
         SET status='submitted',assigned_approver_worker_profile_id=$4,submitted_at=now(),
             updated_at=GREATEST(now(),updated_at + interval '1 microsecond'),
             row_version=row_version+1
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3
           AND row_version=$5 AND status='draft' RETURNING row_version`,
        [
          transaction.context.tenantId,
          timesheetId,
          selectedVersion.timesheet_version_id,
          approver.managerWorkerProfileId,
          selectedVersion.row_version,
        ],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      await createWorkItem(transaction, {
        assigneePrincipalId: approver.managerPrincipalId,
        subjectId: selectedVersion.timesheet_version_id,
        subjectType: SUBJECT_VERSION,
        workItemId: deriveStableUuid("hr.timesheet.work_item.v1", receipt.receiptId),
        workType: WORK_TYPE,
      });
      const timesheet = await mapTimesheet(transaction, timesheetId);
      await recordResult(
        transaction,
        receipt,
        timesheet,
        selectedVersion.timesheet_version_id,
        SUBJECT_VERSION,
        "draft",
        "submitted",
        selectedVersion.row_version,
        timesheet.currentVersion.rowVersion,
      );
      return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: false, timesheet };
    });
  } catch (error) {
    return translate(error);
  }
}

async function managerProfile(
  transaction: TenantTransaction,
  action: ManagerAction,
): Promise<string> {
  const actionKey = `hr.timesheet.${action}`;
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
        resourceKey: HR_TIMESHEET_SERVICE_KEY,
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
    HR_TIMESHEET_SERVICE_KEY,
  );
  const selected = profile.rows[0];
  if (!selected) throw new PlatformError("POLICY_DENIED", "Timesheet manager authority was denied");
  return selected.worker_profile_id;
}

async function rejectionNoteIsRequired(transaction: TenantTransaction): Promise<boolean> {
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
    [`hr.timesheet.settings.v1:${transaction.context.tenantId}`],
  );
  return (await resolveSetting(transaction, rejectionNoteRequired)).value;
}

async function decideTimesheet(
  pool: Pool,
  context: OperationContext,
  timesheetIdInput: string,
  input: HrTimesheetDecisionBody & { readonly idempotencyKey: string },
  action: ManagerAction,
): Promise<TimesheetMutationResult> {
  const timesheetId = normalizeUuid(timesheetIdInput, "timesheetId");
  const decisionNote = normalizeDecisionNote(input.decisionNote);
  try {
    return await withTimesheetTransaction(pool, context, async (transaction) => {
      const approverWorkerProfileId = await managerProfile(transaction, action);
      const noteRequired = action === "reject" ? await rejectionNoteIsRequired(transaction) : false;
      const receipt = await prepareReceipt(transaction, action, input.idempotencyKey, [
        timesheetId,
        input.expectedRootVersion,
        normalizeUuid(input.expectedTimesheetVersionId, "expectedTimesheetVersionId"),
        input.expectedVersion,
        decisionNote,
      ]);
      const root = await transaction.client.query<RootRow>(
        `SELECT timesheet_id,worker_profile_id,period_start::text,period_end::text,
                current_version_id,row_version
         FROM hr_timesheets WHERE tenant_id=$1 AND timesheet_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, timesheetId],
      );
      const selectedRoot = root.rows[0];
      if (!selectedRoot) throw notFound();
      const versionId = normalizeUuid(
        input.expectedTimesheetVersionId,
        "expectedTimesheetVersionId",
      );
      if (
        selectedRoot.row_version !== input.expectedRootVersion ||
        selectedRoot.current_version_id !== versionId
      ) {
        throw versionConflict();
      }
      const version = await transaction.client.query<VersionRow>(
        `SELECT timesheet_version_id,timesheet_id,supersedes_version_id,version,status,
                assigned_approver_worker_profile_id,submitted_at,total_minutes,row_version
         FROM hr_timesheet_versions
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3 FOR UPDATE`,
        [transaction.context.tenantId, timesheetId, versionId],
      );
      const selectedVersion = version.rows[0];
      if (!selectedVersion) throw versionConflict();
      const work = await transaction.client.query<WorkRow>(
        `SELECT work_item_id,assignee_principal_id,status,work_type,subject_type,subject_id
         FROM work_items
         WHERE tenant_id=$1 AND work_type=$2 AND subject_type=$3 AND subject_id=$4
         FOR UPDATE`,
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
      const actionKey = `hr.timesheet.${action}`;
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
        return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: true, timesheet: replay };
      }
      if (noteRequired && !decisionNote) {
        throw inputInvalid("A Timesheet rejection note is required by tenant policy");
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
        `INSERT INTO hr_timesheet_approvals
           (timesheet_approval_id,tenant_id,timesheet_version_id,
            approver_worker_profile_id,decision,decision_note,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          deriveStableUuid("hr.timesheet.approval.v1", receipt.receiptId),
          transaction.context.tenantId,
          versionId,
          approverWorkerProfileId,
          targetStatus,
          decisionNote,
          transaction.context.correlationId,
        ],
      );
      const updated = await transaction.client.query(
        `UPDATE hr_timesheet_versions
         SET status=$4,updated_at=GREATEST(now(),updated_at + interval '1 microsecond'),
             row_version=row_version+1
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3
           AND status='submitted' AND row_version=$5
         RETURNING row_version`,
        [
          transaction.context.tenantId,
          timesheetId,
          versionId,
          targetStatus,
          selectedVersion.row_version,
        ],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      await completeWorkItem(transaction, selectedWork.work_item_id);
      const timesheet = await mapTimesheet(transaction, timesheetId);
      await recordResult(
        transaction,
        receipt,
        timesheet,
        versionId,
        SUBJECT_VERSION,
        "submitted",
        targetStatus,
        selectedVersion.row_version,
        timesheet.currentVersion.rowVersion,
      );
      return { billingState: HR_TIMESHEET_BILLING_STATE, replayed: false, timesheet };
    });
  } catch (error) {
    return translate(error);
  }
}

export async function approveTimesheet(
  pool: Pool,
  context: OperationContext,
  timesheetId: string,
  input: HrTimesheetApproveBody & { readonly idempotencyKey: string },
): Promise<TimesheetMutationResult> {
  return await decideTimesheet(pool, context, timesheetId, input, "approve");
}

export async function rejectTimesheet(
  pool: Pool,
  context: OperationContext,
  timesheetId: string,
  input: HrTimesheetRejectBody & { readonly idempotencyKey: string },
): Promise<TimesheetMutationResult> {
  return await decideTimesheet(pool, context, timesheetId, input, "reject");
}
