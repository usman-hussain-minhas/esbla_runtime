import { createHash } from "node:crypto";
import type { HrShiftAssignmentHistoryEvent } from "@esbla/contracts";
import {
  appendEvidence,
  assertPolicyAllowed,
  deriveStableUuid,
  evaluatePolicy,
  type OperationContext,
  PlatformError,
  recordMutationProof,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { hrManifest } from "./manifest.js";

export const HR_SHIFT_ASSIGNMENT_SERVICE_KEY = "shift_assignment";
export const HR_SHIFT_ASSIGNMENT_BILLING_STATE = "non_billable";
export const HR_SHIFT_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "assign",
  "cancel",
  "configure_service",
  "create_roster",
  "deactivate_service",
  "list_roster",
  "publish",
  "view_detail",
  "view_service_control",
] as const);
export type ShiftAuthorizedAction = (typeof HR_SHIFT_AUTHORIZED_ACTIONS)[number];

type ShiftAction = "assign_shift" | "cancel_assignment" | "create_roster" | "publish_roster";
const SHIFT_CAPABILITY_SUFFIXES: Readonly<Record<ShiftAction, string>> = {
  assign_shift: "assign",
  cancel_assignment: "cancel",
  create_roster: "create_roster",
  publish_roster: "publish",
};
export type HrShiftCreateRosterBody = Readonly<{ periodEnd: string; periodStart: string }>;
export type HrShiftAssignBody = Readonly<{
  endsAt: string;
  ianaTimezone: string;
  startsAt: string;
  workerProfileId: string;
}>;
export type HrShiftExpectedVersionBody = Readonly<{ expectedVersion: number }>;
export interface HrShiftRoster {
  readonly periodEnd: string;
  readonly periodVersion: number;
  readonly periodStart: string;
  readonly publishedAt: string | null;
  readonly rosterVersionId: string;
  readonly status: "draft" | "published" | "superseded";
  readonly supersedesRosterVersionId: string | null;
  readonly version: number;
}
export interface HrShiftAssignment {
  readonly endsAt: string;
  readonly ianaTimezone: string;
  readonly rosterVersionId: string;
  readonly shiftAssignmentId: string;
  readonly startsAt: string;
  readonly status: "active" | "cancelled";
  readonly version: number;
  readonly workerProfileId: string;
}
type ShiftErrorCode =
  | "SHIFT_CONFLICT"
  | "SHIFT_DEPENDENCY_INACTIVE"
  | "SHIFT_INPUT_INVALID"
  | "SHIFT_NOT_FOUND"
  | "SHIFT_SERVICE_CONTROL_NOT_FOUND"
  | "SHIFT_SERVICE_INACTIVE"
  | "SHIFT_VERSION_CONFLICT";

export class HrShiftAssignmentError extends Error {
  readonly code: ShiftErrorCode;

  constructor(code: ShiftErrorCode, message: string) {
    super(message);
    this.name = "HrShiftAssignmentError";
    this.code = code;
  }
}

type Idempotent<T> = T & Readonly<{ idempotencyKey: string }>;
export type CreateShiftRosterInput = Idempotent<HrShiftCreateRosterBody>;
export type AssignShiftInput = Idempotent<
  HrShiftAssignBody & Readonly<{ rosterVersionId: string }>
>;
export type PublishShiftRosterInput = Idempotent<
  HrShiftExpectedVersionBody & Readonly<{ rosterVersionId: string }>
>;
export type CancelShiftAssignmentInput = Idempotent<
  HrShiftExpectedVersionBody & Readonly<{ shiftAssignmentId: string }>
>;
interface MutationResult {
  readonly billingState: typeof HR_SHIFT_ASSIGNMENT_BILLING_STATE;
  readonly replayed: boolean;
}
export type ShiftRosterMutationResult = MutationResult & Readonly<{ roster: HrShiftRoster }>;
export type ShiftAssignmentMutationResult = MutationResult &
  Readonly<{
    assignment: HrShiftAssignment;
    history: readonly HrShiftAssignmentHistoryEvent[];
  }>;

interface ActivationRow {
  readonly service_key: string;
  readonly state: "active" | "inactive";
  readonly version: number;
}
interface RosterRow {
  readonly period_end: string;
  readonly period_start: string;
  readonly published_at: Date | string | null;
  readonly roster_version_id: string;
  readonly row_version: number;
  readonly status: "draft" | "published" | "superseded";
  readonly supersedes_roster_version_id: string | null;
  readonly version: number;
}
interface AssignmentRow {
  readonly ends_at: Date | string;
  readonly iana_timezone: string;
  readonly roster_version_id: string;
  readonly row_version: number;
  readonly shift_assignment_id: string;
  readonly starts_at: Date | string;
  readonly status: "active" | "cancelled";
  readonly worker_profile_id: string;
}
interface AssignmentHistoryRow {
  readonly aggregate_version: number;
  readonly event_type: "hr.shift_assignment.assign_shift" | "hr.shift_assignment.cancel_assignment";
  readonly new_state: "active" | "cancelled";
  readonly occurred_at: Date | string;
  readonly prior_state: "active" | null;
}
interface Receipt {
  readonly action: ShiftAction;
  readonly eventType: string;
  readonly receiptId: string;
  readonly semanticSha256: string;
}
interface ShiftSettings {
  readonly overlapAllowed: false;
  readonly rosterHorizonDays: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ROSTER_COLUMNS = `roster_version_id,period_start::text,period_end::text,status,version,
  supersedes_roster_version_id,published_at,row_version`;
const ASSIGNMENT_COLUMNS = `shift_assignment_id,roster_version_id,worker_profile_id,starts_at,
  ends_at,iana_timezone,status,row_version`;
const SUBJECT_ROSTER = "hr.shift_assignment.roster";
const SUBJECT_ASSIGNMENT = "hr.shift_assignment";
const SUBJECT_RECEIPT = "hr.shift_assignment.idempotency";

function inputInvalid(message: string): HrShiftAssignmentError {
  return new HrShiftAssignmentError("SHIFT_INPUT_INVALID", message);
}
function conflict(message = "Shift Assignment state conflicts with the request") {
  return new HrShiftAssignmentError("SHIFT_CONFLICT", message);
}
function versionConflict() {
  return new HrShiftAssignmentError(
    "SHIFT_VERSION_CONFLICT",
    "Shift Assignment currentness check failed",
  );
}
function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Shift Assignment data",
  );
}
function normalizeUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw inputInvalid(`${field} must be a UUID`);
  return value.toLowerCase();
}
function positiveVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw inputInvalid("expectedVersion must be a positive integer");
  }
}
function normalizeDate(value: string, field: string): string {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw inputInvalid(`${field} must be a calendar date`);
  const actual = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    actual.getUTCFullYear() !== Number(match[1]) ||
    actual.getUTCMonth() !== Number(match[2]) - 1 ||
    actual.getUTCDate() !== Number(match[3])
  ) {
    throw inputInvalid(`${field} must be a valid calendar date`);
  }
  return value;
}
function normalizeInstant(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    !/[zZ]|[+-]\d\d:\d\d$/.test(value)
  ) {
    throw inputInvalid(`${field} must be a timezone-aware instant`);
  }
  return new Date(value).toISOString();
}
function iso(value: Date | string): string {
  const normalized = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(normalized))) throw conflict("Stored Shift instant is invalid");
  return normalized;
}
function mapRoster(row: RosterRow): HrShiftRoster {
  if (
    !UUID_PATTERN.test(row.roster_version_id) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < 1
  ) {
    throw conflict("Stored Shift roster is invalid");
  }
  return {
    periodEnd: row.period_end,
    periodVersion: row.version,
    periodStart: row.period_start,
    publishedAt: row.published_at === null ? null : iso(row.published_at),
    rosterVersionId: row.roster_version_id,
    status: row.status,
    supersedesRosterVersionId: row.supersedes_roster_version_id,
    version: row.row_version,
  };
}
function mapAssignment(row: AssignmentRow): HrShiftAssignment {
  if (!UUID_PATTERN.test(row.shift_assignment_id) || row.row_version < 1) {
    throw conflict("Stored Shift assignment is invalid");
  }
  return {
    endsAt: iso(row.ends_at),
    ianaTimezone: row.iana_timezone,
    rosterVersionId: row.roster_version_id,
    shiftAssignmentId: row.shift_assignment_id,
    startsAt: iso(row.starts_at),
    status: row.status,
    version: row.row_version,
    workerProfileId: row.worker_profile_id,
  };
}
function semanticSha256(action: ShiftAction, values: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([action, ...values]))
    .digest("hex");
}
function isPostgresCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    codes.includes(String((error as { code?: unknown }).code))
  );
}

async function withShiftTransaction<T>(
  pool: Pool,
  context: OperationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  for (const value of Object.values(context)) {
    if (!UUID_PATTERN.test(value)) {
      throw new PlatformError("INVALID_OPERATION_CONTEXT", "Operation context must contain UUIDs");
    }
  }
  const normalizedContext: OperationContext = {
    actorPrincipalId: context.actorPrincipalId.toLowerCase(),
    correlationId: context.correlationId.toLowerCase(),
    tenantId: context.tenantId.toLowerCase(),
  };
  return await withTenantTransaction(
    pool,
    normalizedContext,
    async (transaction) => {
      if (transaction.lockedServiceActivation?.state !== "active") {
        throw new HrShiftAssignmentError(
          "SHIFT_SERVICE_INACTIVE",
          "Shift Assignment service is inactive",
        );
      }
      const workforce = await transaction.client.query<ActivationRow>(
        `SELECT service_key,state,version FROM service_activations
         WHERE tenant_id=$1 AND service_key='workforce_profile' FOR SHARE NOWAIT`,
        [normalizedContext.tenantId],
      );
      if (workforce.rows[0]?.state !== "active") {
        throw new HrShiftAssignmentError(
          "SHIFT_DEPENDENCY_INACTIVE",
          "Shift Assignment dependency is unavailable",
        );
      }
      return await operation(transaction);
    },
    {
      serviceActivationKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
      serviceActivationLock: "share",
    },
  );
}

async function authorize(transaction: TenantTransaction, action: ShiftAction): Promise<void> {
  const actionKey = `hr.shift.${SHIFT_CAPABILITY_SUFFIXES[action]}`;
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
        input: { capabilityCurrent: registered && capability.rows.length === 1 },
        resourceKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
        transaction,
      },
      [
        {
          effect: "allow",
          id: `current_hr_operator_${action}`,
          matches: (request, actor) => actor.roleKey === "hr_operator" && request.capabilityCurrent,
        },
      ],
    ),
    transaction,
    actionKey,
    HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
  );
}

const SHIFT_ADMIN_ACTIONS = new Set<ShiftAuthorizedAction>([
  "activate_service",
  "configure_service",
  "deactivate_service",
  "view_service_control",
]);
const SHIFT_OPERATOR_ACTIONS = new Set<ShiftAuthorizedAction>([
  "assign",
  "cancel",
  "create_roster",
  "publish",
]);

function roleAllowsShiftAction(
  roleKey: string,
  action: ShiftAuthorizedAction,
  listMode?: "own" | "roster",
): boolean {
  if (action === "list_roster" && listMode)
    return listMode === "own"
      ? roleKey === "employee"
      : ["hr_operator", "manager"].includes(roleKey);
  if (SHIFT_ADMIN_ACTIONS.has(action)) return roleKey === "tenant_admin";
  if (SHIFT_OPERATOR_ACTIONS.has(action)) return roleKey === "hr_operator";
  return roleKey === "employee" || roleKey === "manager" || roleKey === "hr_operator";
}

export async function inspectShiftActionAuthority(
  pool: Pool,
  context: OperationContext,
  listMode?: "own" | "roster",
): Promise<readonly ShiftAuthorizedAction[]> {
  return await withTenantTransaction(pool, context, async (transaction) => {
    const capabilityIds = HR_SHIFT_AUTHORIZED_ACTIONS.map((action) => `hr.shift.${action}`);
    const result = await transaction.client.query<{ capability_id: string }>(
      `SELECT capability_id FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=ANY($3::text[])
       ORDER BY capability_id`,
      [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityIds],
    );
    const current = new Set(result.rows.map(({ capability_id }) => capability_id));
    return Object.freeze(
      HR_SHIFT_AUTHORIZED_ACTIONS.filter((action) => {
        const capabilityId = `hr.shift.${action}`;
        return (
          roleAllowsShiftAction(transaction.actor.roleKey, action, listMode) &&
          current.has(capabilityId) &&
          hrManifest.capabilities.some(({ id }) => id === capabilityId)
        );
      }),
    );
  });
}

async function prepareReceipt(
  transaction: TenantTransaction,
  action: ShiftAction,
  idempotencyKey: string,
  semantics: readonly unknown[],
): Promise<Receipt> {
  const receiptId = deriveStableUuid(
    "hr.shift_assignment.idempotency.v1",
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
    eventType: `hr.shift_assignment.${action}`,
    receiptId,
    semanticSha256: semanticSha256(action, semantics),
  };
}

async function readReplay(
  transaction: TenantTransaction,
  receipt: Receipt,
): Promise<HrShiftRoster | HrShiftAssignment | null> {
  const found = await transaction.client.query<{
    actor_principal_id: string;
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT actor_principal_id,correlation_id,prior_state,new_state FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 AND event_type=$4
     ORDER BY occurred_at,evidence_event_id LIMIT 2`,
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
    !binding ||
    binding.actor_principal_id !== transaction.context.actorPrincipalId ||
    binding.prior_state !== receipt.semanticSha256
  ) {
    throw idempotencyConflict();
  }
  const proof = await transaction.client.query<{
    aggregate_id: string;
    aggregate_version: number;
    new_state: string;
    payload: unknown;
    prior_state: string | null;
    subject_type: string;
  }>(
    `SELECT outbox.aggregate_id,outbox.aggregate_version,outbox.payload,
            evidence.subject_type,evidence.prior_state,evidence.new_state
     FROM evidence_events evidence
     JOIN outbox_events outbox
       ON outbox.tenant_id=evidence.tenant_id
      AND outbox.event_type=evidence.event_type
      AND outbox.aggregate_type=evidence.subject_type
      AND outbox.aggregate_id=evidence.subject_id
      AND outbox.correlation_id=evidence.correlation_id
     WHERE evidence.tenant_id=$1 AND evidence.event_type=$2
       AND evidence.correlation_id=$3 AND evidence.actor_principal_id=$4
       AND outbox.payload->>'receiptId'=$5
     ORDER BY evidence.occurred_at,evidence.evidence_event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      receipt.eventType,
      binding.correlation_id,
      transaction.context.actorPrincipalId,
      receipt.receiptId,
    ],
  );
  const recorded = proof.rows[0];
  if (proof.rows.length !== 1 || !recorded || !UUID_PATTERN.test(recorded.aggregate_id)) {
    throw idempotencyConflict();
  }
  const payload =
    typeof recorded.payload === "object" &&
    recorded.payload !== null &&
    !Array.isArray(recorded.payload)
      ? (recorded.payload as Record<string, unknown>)
      : null;
  const transitions: Readonly<Record<ShiftAction, readonly [string, string | null, string]>> = {
    assign_shift: [SUBJECT_ASSIGNMENT, null, "active"],
    cancel_assignment: [SUBJECT_ASSIGNMENT, "active", "cancelled"],
    create_roster: [SUBJECT_ROSTER, null, "draft"],
    publish_roster: [SUBJECT_ROSTER, "draft", "published"],
  };
  const [subjectType, priorState, newState] = transitions[receipt.action];
  if (
    !payload ||
    payload.receiptId !== receipt.receiptId ||
    payload.action !== receipt.action ||
    payload.billingState !== HR_SHIFT_ASSIGNMENT_BILLING_STATE ||
    payload.afterVersion !== recorded.aggregate_version ||
    recorded.subject_type !== subjectType ||
    recorded.prior_state !== priorState ||
    recorded.new_state !== newState
  ) {
    throw idempotencyConflict();
  }
  let result: HrShiftRoster | HrShiftAssignment;
  if (subjectType === SUBJECT_ROSTER) {
    const selected = await transaction.client.query<RosterRow>(
      `SELECT ${ROSTER_COLUMNS} FROM hr_shift_roster_versions
       WHERE tenant_id=$1 AND roster_version_id=$2`,
      [transaction.context.tenantId, recorded.aggregate_id],
    );
    const current = selected.rows[0];
    if (!current) throw idempotencyConflict();
    const roster = mapRoster(current);
    result = {
      ...roster,
      publishedAt: receipt.action === "create_roster" ? null : roster.publishedAt,
      status: receipt.action === "create_roster" ? "draft" : "published",
      supersedesRosterVersionId:
        receipt.action === "create_roster" ? null : roster.supersedesRosterVersionId,
      version: recorded.aggregate_version,
    };
  } else {
    const selected = await transaction.client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM hr_shift_assignments
       WHERE tenant_id=$1 AND shift_assignment_id=$2`,
      [transaction.context.tenantId, recorded.aggregate_id],
    );
    const current = selected.rows[0];
    if (!current) throw idempotencyConflict();
    result = {
      ...mapAssignment(current),
      status: receipt.action === "assign_shift" ? "active" : "cancelled",
      version: recorded.aggregate_version,
    };
  }
  if (binding.new_state !== semanticSha256(receipt.action, [result])) {
    throw idempotencyConflict();
  }
  return result;
}

async function recordResult(
  transaction: TenantTransaction,
  receipt: Receipt,
  subjectType: string,
  subjectId: string,
  priorState: string | null,
  newState: string,
  version: number,
  result: HrShiftRoster | HrShiftAssignment,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await recordMutationProof(transaction, {
    evidence: { eventType: receipt.eventType, newState, priorState, subjectId, subjectType },
    outbox: {
      aggregateId: subjectId,
      aggregateType: subjectType,
      aggregateVersion: version,
      eventType: receipt.eventType,
      payload: {
        action: receipt.action,
        billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE,
        receiptId: receipt.receiptId,
        ...extra,
      },
    },
  });
  const binding = await appendEvidence(transaction, {
    eventType: `${receipt.eventType}.response_bound`,
    newState: semanticSha256(receipt.action, [result]),
    priorState: receipt.semanticSha256,
    subjectId: receipt.receiptId,
    subjectType: SUBJECT_RECEIPT,
  });
  if (binding.replayed) throw idempotencyConflict();
}

async function assignmentHistory(
  transaction: TenantTransaction,
  assignment: HrShiftAssignment,
): Promise<readonly HrShiftAssignmentHistoryEvent[]> {
  if (assignment.version !== 1 && assignment.version !== 2) {
    throw conflict("Stored Shift assignment history is invalid");
  }
  const result = await transaction.client.query<AssignmentHistoryRow>(
    `SELECT outbox.aggregate_version,evidence.event_type,evidence.prior_state,
            evidence.new_state,evidence.occurred_at
     FROM evidence_events evidence
     JOIN outbox_events outbox
       ON outbox.tenant_id=evidence.tenant_id
      AND outbox.event_type=evidence.event_type
      AND outbox.aggregate_type=evidence.subject_type
      AND outbox.aggregate_id=evidence.subject_id
      AND outbox.correlation_id=evidence.correlation_id
     WHERE evidence.tenant_id=$1 AND evidence.subject_type=$2 AND evidence.subject_id=$3
       AND evidence.event_type=ANY($4::text[]) AND outbox.aggregate_version<=$5
     ORDER BY outbox.aggregate_version,evidence.occurred_at,evidence.evidence_event_id
     LIMIT 3`,
    [
      transaction.context.tenantId,
      SUBJECT_ASSIGNMENT,
      assignment.shiftAssignmentId,
      ["hr.shift_assignment.assign_shift", "hr.shift_assignment.cancel_assignment"],
      assignment.version,
    ],
  );
  const rows = result.rows;
  const valid =
    assignment.status === (assignment.version === 1 ? "active" : "cancelled") &&
    rows.length === assignment.version &&
    rows[0]?.aggregate_version === 1 &&
    rows[0].event_type === "hr.shift_assignment.assign_shift" &&
    rows[0].prior_state === null &&
    rows[0].new_state === "active" &&
    (assignment.version === 1 ||
      (rows[1]?.aggregate_version === 2 &&
        rows[1].event_type === "hr.shift_assignment.cancel_assignment" &&
        rows[1].prior_state === "active" &&
        rows[1].new_state === "cancelled"));
  if (!valid) throw conflict("Stored Shift assignment history is invalid");
  const history = rows.map(
    (row): HrShiftAssignmentHistoryEvent =>
      row.event_type === "hr.shift_assignment.assign_shift"
        ? {
            eventType: "hr.shift_assignment.assign_shift",
            newState: "active",
            occurredAt: iso(row.occurred_at),
            priorState: null,
          }
        : {
            eventType: "hr.shift_assignment.cancel_assignment",
            newState: "cancelled",
            occurredAt: iso(row.occurred_at),
            priorState: "active",
          },
  );
  if (
    history.some(({ occurredAt }) => !Number.isFinite(Date.parse(occurredAt))) ||
    (history[1] && history[0] && history[1].occurredAt < history[0].occurredAt)
  ) {
    throw conflict("Stored Shift assignment history is invalid");
  }
  return history;
}

async function assignmentResult(
  transaction: TenantTransaction,
  assignment: HrShiftAssignment,
  replayed: boolean,
): Promise<ShiftAssignmentMutationResult> {
  return {
    assignment,
    billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE,
    history: await assignmentHistory(transaction, assignment),
    replayed,
  };
}

async function resolveSettings(transaction: TenantTransaction): Promise<ShiftSettings> {
  const snapshot = await transaction.client.query<{
    setting_key: string | null;
    settings_version: number;
    value: unknown;
    version: number | null;
  }>(
    `SELECT control.settings_version,setting.setting_key,setting.value,setting.version
     FROM hr_shift_assignment_service_control control
     LEFT JOIN tenant_settings setting
       ON setting.tenant_id=control.tenant_id
      AND setting.setting_key=ANY($2::text[])
     WHERE control.tenant_id=$1 AND control.service_key='shift_assignment'
     ORDER BY setting.setting_key`,
    [
      transaction.context.tenantId,
      ["hr.shift_assignment.overlap_allowed", "hr.shift_assignment.roster_horizon_days"],
    ],
  );
  const settingsVersion = snapshot.rows[0]?.settings_version;
  if (
    settingsVersion === undefined ||
    !Number.isSafeInteger(settingsVersion) ||
    settingsVersion < 1
  ) {
    throw conflict("Shift Assignment settings control is missing");
  }
  const selected = snapshot.rows.filter(
    (row): row is typeof row & { setting_key: string; version: number } =>
      row.setting_key !== null && row.version !== null,
  );
  if (settingsVersion === 1 && selected.length === 0) {
    return { overlapAllowed: false, rosterHorizonDays: 14 };
  }
  const byKey = new Map(selected.map((row) => [row.setting_key, row]));
  const overlap = byKey.get("hr.shift_assignment.overlap_allowed");
  const horizon = byKey.get("hr.shift_assignment.roster_horizon_days");
  if (
    selected.length !== 2 ||
    overlap?.value !== false ||
    overlap.version !== settingsVersion - 1 ||
    !Number.isSafeInteger(horizon?.value) ||
    Number(horizon?.value) < 1 ||
    Number(horizon?.value) > 31 ||
    horizon?.version !== settingsVersion - 1
  ) {
    throw conflict("Shift Assignment settings are not current");
  }
  return { overlapAllowed: false, rosterHorizonDays: Number(horizon.value) };
}

function translateWriteError(error: unknown): never {
  if (error instanceof HrShiftAssignmentError || error instanceof PlatformError) throw error;
  if (isPostgresCode(error, "23505")) throw conflict();
  if (isPostgresCode(error, "40001", "40P01", "55P03")) throw versionConflict();
  if (isPostgresCode(error, "55000")) throw conflict();
  if (isPostgresCode(error, "22023", "22007", "22008")) throw inputInvalid("Shift data is invalid");
  throw error;
}

export async function createShiftRoster(
  pool: Pool,
  context: OperationContext,
  input: CreateShiftRosterInput,
): Promise<ShiftRosterMutationResult> {
  const periodStart = normalizeDate(input.periodStart, "periodStart");
  const periodEnd = normalizeDate(input.periodEnd, "periodEnd");
  if (periodEnd < periodStart) throw inputInvalid("periodEnd must not precede periodStart");
  try {
    return await withShiftTransaction(pool, context, async (transaction) => {
      await authorize(transaction, "create_roster");
      const receipt = await prepareReceipt(transaction, "create_roster", input.idempotencyKey, [
        periodStart,
        periodEnd,
      ]);
      const replay = (await readReplay(transaction, receipt)) as HrShiftRoster | null;
      if (replay) {
        return { billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE, replayed: true, roster: replay };
      }
      const settings = await resolveSettings(transaction);
      const inclusiveDays =
        (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) /
          86_400_000 +
        1;
      if (inclusiveDays > settings.rosterHorizonDays) {
        throw inputInvalid("Roster period exceeds the configured inclusive length");
      }
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [`hr.shift.period.v1:${transaction.context.tenantId}:${periodStart}:${periodEnd}`],
      );
      const draft = await transaction.client.query<RosterRow>(
        `SELECT ${ROSTER_COLUMNS} FROM hr_shift_roster_versions
         WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3 AND status='draft'
         ORDER BY roster_version_id FOR UPDATE`,
        [transaction.context.tenantId, periodStart, periodEnd],
      );
      const published = await transaction.client.query<RosterRow>(
        `SELECT ${ROSTER_COLUMNS} FROM hr_shift_roster_versions
         WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3 AND status='published'
         ORDER BY roster_version_id FOR SHARE`,
        [transaction.context.tenantId, periodStart, periodEnd],
      );
      if (draft.rows.length !== 0 || published.rows.length > 1) throw conflict();
      const version = (published.rows[0]?.version ?? 0) + 1;
      const inserted = await transaction.client.query<RosterRow>(
        `INSERT INTO hr_shift_roster_versions
           (tenant_id,period_start,period_end,version)
         VALUES ($1,$2,$3,$4) RETURNING ${ROSTER_COLUMNS}`,
        [transaction.context.tenantId, periodStart, periodEnd, version],
      );
      const roster = mapRoster(inserted.rows[0] as RosterRow);
      await recordResult(
        transaction,
        receipt,
        SUBJECT_ROSTER,
        roster.rosterVersionId,
        null,
        "draft",
        roster.version,
        roster,
        { afterVersion: roster.version, beforeVersion: null, periodVersion: version },
      );
      return { billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE, replayed: false, roster };
    });
  } catch (error) {
    return translateWriteError(error);
  }
}

async function localDate(
  client: Pick<PoolClient, "query">,
  startsAt: string,
  ianaTimezone: string,
): Promise<string> {
  const converted = await client.query<{ local_date: string }>(
    `SELECT ($1::timestamptz AT TIME ZONE $2)::date::text local_date
     WHERE EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=$2)`,
    [startsAt, ianaTimezone],
  );
  const value = converted.rows[0]?.local_date;
  if (!value) throw inputInvalid("ianaTimezone must be a valid IANA timezone");
  return value;
}

export async function assignShift(
  pool: Pool,
  context: OperationContext,
  input: AssignShiftInput,
): Promise<ShiftAssignmentMutationResult> {
  const rosterVersionId = normalizeUuid(input.rosterVersionId, "rosterVersionId");
  const workerProfileId = normalizeUuid(input.workerProfileId, "workerProfileId");
  const startsAt = normalizeInstant(input.startsAt, "startsAt");
  const endsAt = normalizeInstant(input.endsAt, "endsAt");
  if (endsAt <= startsAt) throw inputInvalid("endsAt must follow startsAt");
  try {
    return await withShiftTransaction(pool, context, async (transaction) => {
      await authorize(transaction, "assign_shift");
      const receipt = await prepareReceipt(transaction, "assign_shift", input.idempotencyKey, [
        rosterVersionId,
        workerProfileId,
        startsAt,
        endsAt,
        input.ianaTimezone,
      ]);
      const replay = (await readReplay(transaction, receipt)) as HrShiftAssignment | null;
      if (replay) {
        return await assignmentResult(transaction, replay, true);
      }
      await resolveSettings(transaction);
      const roster = await transaction.client.query<RosterRow>(
        `SELECT ${ROSTER_COLUMNS} FROM hr_shift_roster_versions
         WHERE tenant_id=$1 AND roster_version_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, rosterVersionId],
      );
      const draft = roster.rows[0];
      if (!draft) throw new HrShiftAssignmentError("SHIFT_NOT_FOUND", "Shift roster was not found");
      if (draft.status !== "draft") throw conflict("Assignments require a draft roster");
      const predecessor = await transaction.client.query<RosterRow>(
        `SELECT ${ROSTER_COLUMNS} FROM hr_shift_roster_versions
         WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3 AND status='published'
         ORDER BY roster_version_id FOR SHARE`,
        [transaction.context.tenantId, draft.period_start, draft.period_end],
      );
      if (predecessor.rows.length > 1) throw conflict();
      const worker = await transaction.client.query<{ workforce_status: string }>(
        `SELECT workforce_status FROM hr_worker_profiles
         WHERE tenant_id=$1 AND worker_profile_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, workerProfileId],
      );
      if (worker.rows[0]?.workforce_status !== "active") {
        throw conflict("Shift worker must be active");
      }
      await transaction.client.query(
        `SELECT assignment.shift_assignment_id FROM hr_shift_assignments assignment
         JOIN hr_shift_roster_versions parent
           ON parent.tenant_id=assignment.tenant_id
          AND parent.roster_version_id=assignment.roster_version_id
         WHERE assignment.tenant_id=$1 AND assignment.worker_profile_id=$2
           AND assignment.status='active' AND parent.status<>'superseded'
         ORDER BY assignment.starts_at,assignment.shift_assignment_id
         FOR UPDATE OF assignment`,
        [transaction.context.tenantId, workerProfileId],
      );
      const startsOn = await localDate(transaction.client, startsAt, input.ianaTimezone);
      if (startsOn < draft.period_start || startsOn > draft.period_end) {
        throw inputInvalid("Shift start date is outside the roster period");
      }
      const overlap = await transaction.client.query(
        `SELECT assignment.shift_assignment_id FROM hr_shift_assignments assignment
         JOIN hr_shift_roster_versions parent
           ON parent.tenant_id=assignment.tenant_id
          AND parent.roster_version_id=assignment.roster_version_id
         WHERE assignment.tenant_id=$1 AND assignment.worker_profile_id=$2
           AND assignment.status='active' AND parent.status<>'superseded'
           AND ($3::uuid IS NULL OR assignment.roster_version_id<>$3)
           AND assignment.starts_at<$4::timestamptz AND assignment.ends_at>$5::timestamptz
         ORDER BY assignment.starts_at,assignment.shift_assignment_id LIMIT 1`,
        [
          transaction.context.tenantId,
          workerProfileId,
          predecessor.rows[0]?.roster_version_id ?? null,
          endsAt,
          startsAt,
        ],
      );
      if (overlap.rows.length > 0) throw conflict("Shift overlaps an active assignment");
      const inserted = await transaction.client.query<AssignmentRow>(
        `INSERT INTO hr_shift_assignments
           (tenant_id,roster_version_id,worker_profile_id,starts_at,ends_at,iana_timezone)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ASSIGNMENT_COLUMNS}`,
        [
          transaction.context.tenantId,
          rosterVersionId,
          workerProfileId,
          startsAt,
          endsAt,
          input.ianaTimezone,
        ],
      );
      const assignment = mapAssignment(inserted.rows[0] as AssignmentRow);
      await recordResult(
        transaction,
        receipt,
        SUBJECT_ASSIGNMENT,
        assignment.shiftAssignmentId,
        null,
        "active",
        assignment.version,
        assignment,
        { afterVersion: assignment.version, beforeVersion: null },
      );
      return await assignmentResult(transaction, assignment, false);
    });
  } catch (error) {
    return translateWriteError(error);
  }
}

export async function publishShiftRoster(
  pool: Pool,
  context: OperationContext,
  input: PublishShiftRosterInput,
): Promise<ShiftRosterMutationResult> {
  const rosterVersionId = normalizeUuid(input.rosterVersionId, "rosterVersionId");
  positiveVersion(input.expectedVersion);
  try {
    return await withShiftTransaction(pool, context, async (transaction) => {
      await authorize(transaction, "publish_roster");
      const receipt = await prepareReceipt(transaction, "publish_roster", input.idempotencyKey, [
        rosterVersionId,
        input.expectedVersion,
      ]);
      const replay = (await readReplay(transaction, receipt)) as HrShiftRoster | null;
      if (replay) {
        return { billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE, replayed: true, roster: replay };
      }
      await resolveSettings(transaction);
      const selected = await transaction.client.query<RosterRow>(
        `SELECT ${ROSTER_COLUMNS} FROM hr_shift_roster_versions
         WHERE tenant_id=$1 AND roster_version_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, rosterVersionId],
      );
      const draft = selected.rows[0];
      if (!draft) throw new HrShiftAssignmentError("SHIFT_NOT_FOUND", "Shift roster was not found");
      if (draft.status !== "draft") throw conflict("Only a draft roster can be published");
      if (draft.row_version !== input.expectedVersion) throw versionConflict();
      const predecessor = await transaction.client.query<RosterRow>(
        `SELECT ${ROSTER_COLUMNS} FROM hr_shift_roster_versions
         WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3 AND status='published'
         ORDER BY roster_version_id FOR UPDATE`,
        [transaction.context.tenantId, draft.period_start, draft.period_end],
      );
      if (predecessor.rows.length > 1) throw conflict();
      await transaction.client.query(
        `SELECT profile.worker_profile_id FROM hr_worker_profiles profile
         JOIN (
           SELECT DISTINCT worker_profile_id FROM hr_shift_assignments
           WHERE tenant_id=$1 AND roster_version_id=$2
         ) affected ON affected.worker_profile_id=profile.worker_profile_id
         WHERE profile.tenant_id=$1 ORDER BY profile.worker_profile_id FOR UPDATE OF profile`,
        [transaction.context.tenantId, rosterVersionId],
      );
      await transaction.client.query(
        `SELECT assignment.shift_assignment_id FROM hr_shift_assignments assignment
         WHERE assignment.tenant_id=$1
           AND assignment.worker_profile_id IN (
             SELECT worker_profile_id FROM hr_shift_assignments
             WHERE tenant_id=$1 AND roster_version_id=$2
           )
         ORDER BY assignment.worker_profile_id,assignment.starts_at,
                  assignment.shift_assignment_id FOR UPDATE`,
        [transaction.context.tenantId, rosterVersionId],
      );
      const invalid = await transaction.client.query(
        `SELECT candidate.shift_assignment_id
         FROM hr_shift_assignments candidate
         JOIN hr_worker_profiles worker
           ON worker.tenant_id=candidate.tenant_id
          AND worker.worker_profile_id=candidate.worker_profile_id
         WHERE candidate.tenant_id=$1 AND candidate.roster_version_id=$2
           AND candidate.status='active'
           AND (
             worker.workforce_status<>'active'
             OR NOT EXISTS (SELECT 1 FROM pg_timezone_names zone
                            WHERE zone.name=candidate.iana_timezone)
             OR (candidate.starts_at AT TIME ZONE candidate.iana_timezone)::date
                  NOT BETWEEN $3::date AND $4::date
             OR EXISTS (
               SELECT 1 FROM hr_shift_assignments other
               JOIN hr_shift_roster_versions parent
                 ON parent.tenant_id=other.tenant_id
                AND parent.roster_version_id=other.roster_version_id
               WHERE other.tenant_id=candidate.tenant_id
                 AND other.worker_profile_id=candidate.worker_profile_id
                 AND other.status='active' AND parent.status<>'superseded'
                 AND other.shift_assignment_id<>candidate.shift_assignment_id
                 AND ($5::uuid IS NULL OR other.roster_version_id<>$5)
                 AND other.starts_at<candidate.ends_at AND other.ends_at>candidate.starts_at
             )
           )
         ORDER BY candidate.worker_profile_id,candidate.starts_at,candidate.shift_assignment_id
         LIMIT 1`,
        [
          transaction.context.tenantId,
          rosterVersionId,
          draft.period_start,
          draft.period_end,
          predecessor.rows[0]?.roster_version_id ?? null,
        ],
      );
      if (invalid.rows.length > 0) throw conflict("Shift roster assignments are not publishable");
      const prior = predecessor.rows[0] ?? null;
      if (prior) {
        const superseded = await transaction.client.query(
          `UPDATE hr_shift_roster_versions SET status='superseded',row_version=row_version+1
           WHERE tenant_id=$1 AND roster_version_id=$2 AND status='published'
             AND row_version=$3 RETURNING roster_version_id`,
          [transaction.context.tenantId, prior.roster_version_id, prior.row_version],
        );
        if (superseded.rows.length !== 1) throw versionConflict();
      }
      const updated = await transaction.client.query<RosterRow>(
        `UPDATE hr_shift_roster_versions
         SET status='published',supersedes_roster_version_id=$3,row_version=row_version+1
         WHERE tenant_id=$1 AND roster_version_id=$2 AND status='draft' AND row_version=$4
         RETURNING ${ROSTER_COLUMNS}`,
        [
          transaction.context.tenantId,
          rosterVersionId,
          prior?.roster_version_id ?? null,
          input.expectedVersion,
        ],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      const roster = mapRoster(updated.rows[0] as RosterRow);
      await recordResult(
        transaction,
        receipt,
        SUBJECT_ROSTER,
        roster.rosterVersionId,
        "draft",
        "published",
        roster.version,
        roster,
        {
          afterVersion: roster.version,
          beforeVersion: input.expectedVersion,
          supersededRosterVersionId: prior?.roster_version_id ?? null,
        },
      );
      return { billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE, replayed: false, roster };
    });
  } catch (error) {
    return translateWriteError(error);
  }
}

export async function cancelShiftAssignment(
  pool: Pool,
  context: OperationContext,
  input: CancelShiftAssignmentInput,
): Promise<ShiftAssignmentMutationResult> {
  const shiftAssignmentId = normalizeUuid(input.shiftAssignmentId, "shiftAssignmentId");
  positiveVersion(input.expectedVersion);
  try {
    return await withShiftTransaction(pool, context, async (transaction) => {
      await authorize(transaction, "cancel_assignment");
      const receipt = await prepareReceipt(transaction, "cancel_assignment", input.idempotencyKey, [
        shiftAssignmentId,
        input.expectedVersion,
      ]);
      const replay = (await readReplay(transaction, receipt)) as HrShiftAssignment | null;
      if (replay) {
        return await assignmentResult(transaction, replay, true);
      }
      const selected = await transaction.client.query<AssignmentRow>(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM hr_shift_assignments
         WHERE tenant_id=$1 AND shift_assignment_id=$2 FOR UPDATE`,
        [transaction.context.tenantId, shiftAssignmentId],
      );
      const before = selected.rows[0];
      if (!before) {
        throw new HrShiftAssignmentError("SHIFT_NOT_FOUND", "Shift assignment was not found");
      }
      if (before.status !== "active") throw conflict("Shift assignment is already terminal");
      if (before.row_version !== input.expectedVersion) throw versionConflict();
      const updated = await transaction.client.query<AssignmentRow>(
        `UPDATE hr_shift_assignments SET status='cancelled',row_version=row_version+1
         WHERE tenant_id=$1 AND shift_assignment_id=$2 AND status='active' AND row_version=$3
         RETURNING ${ASSIGNMENT_COLUMNS}`,
        [transaction.context.tenantId, shiftAssignmentId, input.expectedVersion],
      );
      if (updated.rows.length !== 1) throw versionConflict();
      const assignment = mapAssignment(updated.rows[0] as AssignmentRow);
      await recordResult(
        transaction,
        receipt,
        SUBJECT_ASSIGNMENT,
        assignment.shiftAssignmentId,
        "active",
        "cancelled",
        assignment.version,
        assignment,
        { afterVersion: assignment.version, beforeVersion: input.expectedVersion },
      );
      return await assignmentResult(transaction, assignment, false);
    });
  } catch (error) {
    return translateWriteError(error);
  }
}
