import { createHash } from "node:crypto";
import {
  type HrEmploymentAccessScope,
  type HrEmploymentHistoryCursor,
  type HrEmploymentListCursor,
  type HrEmploymentListResponse,
  type HrEmploymentRecord,
  type HrEmploymentRecordMutationOperation,
  type HrEmploymentRecordMutationResponse,
  type HrEmploymentRecordStatus,
  type HrEmploymentRecordSummary,
  type HrEmploymentRecordVersion,
  type HrEmploymentRecordVersionKind,
  parseHrEmploymentRecord,
  parseHrEmploymentRecordMutationResponse,
} from "@esbla/contracts";
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
import type { Pool } from "pg";
import { hrManifest } from "./manifest.js";

export const HR_EMPLOYMENT_RECORD_SERVICE_KEY = "employment_record";
export const HR_EMPLOYMENT_RECORD_BILLING_STATE = "non_billable";

const SUBJECT_TYPE = "hr.employment_record";
const RECEIPT_SUBJECT_TYPE = "hr.employment_record.idempotency";
const RESPONSE_BINDING_EVENT = "hr.employment_record.response_bound";
const EMPLOYMENT_TYPE_CODES_KEY = "hr.employment_record.employment_type_codes";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type EmploymentAccessScope = HrEmploymentAccessScope;
export type EmploymentRecordStatus = HrEmploymentRecordStatus;
export type EmploymentVersionKind = HrEmploymentRecordVersionKind;

export type EmploymentErrorCode =
  | "EMPLOYMENT_CONFLICT"
  | "EMPLOYMENT_DEPENDENCY_INACTIVE"
  | "EMPLOYMENT_INPUT_INVALID"
  | "EMPLOYMENT_NOT_FOUND"
  | "EMPLOYMENT_SERVICE_CONTROL_NOT_FOUND"
  | "EMPLOYMENT_SERVICE_INACTIVE"
  | "EMPLOYMENT_VERSION_CONFLICT";

export class EmploymentError extends Error {
  readonly code: EmploymentErrorCode;

  constructor(code: EmploymentErrorCode, message: string) {
    super(message);
    this.name = "EmploymentError";
    this.code = code;
  }
}

export type EmploymentRecordVersionView = HrEmploymentRecordVersion;
export type EmploymentRecordView = HrEmploymentRecordSummary;
export type EmploymentListCursor = HrEmploymentListCursor;
export type EmploymentHistoryCursor = HrEmploymentHistoryCursor;
export type EmploymentRecordListResult = HrEmploymentListResponse;
export type EmploymentRecordDetailResult = HrEmploymentRecord;

export const HR_EMPLOYMENT_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "configure_service",
  "create_record",
  "create_version",
  "deactivate_service",
  "end_record",
  "list_authorized",
  "view_detail",
  "view_service_control",
] as const);

export type EmploymentAuthorizedAction = (typeof HR_EMPLOYMENT_AUTHORIZED_ACTIONS)[number];

export interface CreateEmploymentRecordInput {
  readonly idempotencyKey: string;
  readonly workerProfileId: string;
}

interface EmploymentFactsInput {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly employmentTypeCode: string | null;
  readonly organizationReference: string | null;
  readonly positionReference: string | null;
}

export interface CreateEmploymentRecordVersionInput extends EmploymentFactsInput {
  readonly employmentRecordId: string;
  readonly expectedCurrentVersion: number | null;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface EndEmploymentRecordInput {
  readonly effectiveTo: string;
  readonly employmentRecordId: string;
  readonly expectedCurrentVersion: number;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface EmploymentMutationResult {
  readonly billingState: typeof HR_EMPLOYMENT_RECORD_BILLING_STATE;
  readonly mutation: HrEmploymentRecordMutationResponse;
  readonly replayed: boolean;
}

export interface ListEmploymentRecordsOptions {
  readonly cursor?: EmploymentListCursor;
  readonly pageSize?: number;
}

export interface GetEmploymentRecordDetailOptions {
  readonly cursor?: EmploymentHistoryCursor;
  readonly employmentRecordId: string;
  readonly pageSize?: number;
}

interface RecordRow {
  readonly created_at: Date | string;
  readonly current_version_id: string | null;
  readonly effective_from: string | null;
  readonly effective_to: string | null;
  readonly employment_record_id: string;
  readonly employment_record_version_id: string | null;
  readonly employment_type_code: string | null;
  readonly organization_reference: string | null;
  readonly position_reference: string | null;
  readonly row_version: number;
  readonly status: EmploymentRecordStatus;
  readonly supersedes_version_id: string | null;
  readonly terminal_version: boolean | null;
  readonly version_kind: EmploymentVersionKind | null;
  readonly version_number: number | null;
  readonly worker_profile_id: string;
}

interface VersionRow {
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly employment_record_version_id: string;
  readonly employment_type_code: string | null;
  readonly organization_reference: string | null;
  readonly position_reference: string | null;
  readonly supersedes_version_id: string | null;
  readonly terminal_version: boolean;
  readonly version: number;
  readonly version_kind: EmploymentVersionKind;
}

type MutationAction = "create_record" | "create_version" | "end_record";

interface MutationReceipt {
  readonly action: MutationAction;
  readonly eventType: string;
  readonly receiptId: string;
  readonly semanticSha256: string;
}

interface MutationPayload {
  readonly action: MutationAction;
  readonly afterVersion: number;
  readonly beforeVersion: number | null;
  readonly billingState: typeof HR_EMPLOYMENT_RECORD_BILLING_STATE;
  readonly payloadVersion: 1;
  readonly receiptId: string;
}

function employmentInputInvalid(message: string): EmploymentError {
  return new EmploymentError("EMPLOYMENT_INPUT_INVALID", message);
}

function employmentConflict(message = "Employment Record state conflicts with the request") {
  return new EmploymentError("EMPLOYMENT_CONFLICT", message);
}

function employmentVersionConflict() {
  return new EmploymentError(
    "EMPLOYMENT_VERSION_CONFLICT",
    "Employment Record currentness check failed",
  );
}

function employmentNotFound() {
  return new EmploymentError("EMPLOYMENT_NOT_FOUND", "Employment Record was not found");
}

function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Employment Record data",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPostgresCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function normalizeUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw employmentInputInvalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

function normalizeDate(value: string, field: string): string {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw employmentInputInvalid(`${field} must be a calendar date`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (
    actual.getUTCFullYear() !== year ||
    actual.getUTCMonth() !== month - 1 ||
    actual.getUTCDate() !== day
  ) {
    throw employmentInputInvalid(`${field} must be a valid calendar date`);
  }
  return value;
}

function normalizeOptionalText(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw employmentInputInvalid(`${field} must be null or non-blank text`);
  }
  return value;
}

function assertPositiveVersion(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw employmentInputInvalid(`${field} must be a positive integer`);
  }
}

function normalizeFacts(input: EmploymentFactsInput): EmploymentFactsInput {
  const effectiveFrom = normalizeDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo =
    input.effectiveTo === null ? null : normalizeDate(input.effectiveTo, "effectiveTo");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw employmentInputInvalid("effectiveTo must not precede effectiveFrom");
  }
  return {
    effectiveFrom,
    effectiveTo,
    employmentTypeCode: normalizeOptionalText(input.employmentTypeCode, "employmentTypeCode"),
    organizationReference: normalizeOptionalText(
      input.organizationReference,
      "organizationReference",
    ),
    positionReference: normalizeOptionalText(input.positionReference, "positionReference"),
  };
}

function pageSize(value: number | undefined): number {
  const normalized = value ?? 50;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 50) {
    throw employmentInputInvalid("pageSize must be an integer from 1 through 50");
  }
  return normalized;
}

function canonicalTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf()))
    throw employmentConflict("Employment Record timestamp is invalid");
  return date.toISOString();
}

function validateListCursor(cursor: EmploymentListCursor | undefined): void {
  if (!cursor) return;
  const parsed = new Date(cursor.createdAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== cursor.createdAt) {
    throw employmentInputInvalid("cursor.createdAt must be a canonical ISO date-time");
  }
  normalizeUuid(cursor.employmentRecordId, "cursor.employmentRecordId");
}

function validateHistoryCursor(cursor: EmploymentHistoryCursor | undefined): void {
  if (!cursor) return;
  assertPositiveVersion(cursor.version, "cursor.version");
  normalizeUuid(cursor.employmentRecordVersionId, "cursor.employmentRecordVersionId");
}

function mapVersion(row: VersionRow): EmploymentRecordVersionView {
  if (
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    (row.version_kind === "end") !== row.terminal_version ||
    (row.version_kind === "end" && row.effective_to === null)
  ) {
    throw employmentConflict("Employment Record version state is invalid");
  }
  return {
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    employmentRecordVersionId: row.employment_record_version_id,
    employmentTypeCode: row.employment_type_code,
    organizationReference: row.organization_reference,
    positionReference: row.position_reference,
    supersedesVersionId: row.supersedes_version_id,
    kind: row.version_kind,
    rowVersion: 1,
    terminal: row.terminal_version,
    version: row.version,
  };
}

function mapRecord(row: RecordRow): EmploymentRecordView {
  if (!Number.isSafeInteger(row.row_version) || row.row_version < 1) {
    throw employmentConflict("Employment Record root state is invalid");
  }
  const hasHead = row.current_version_id !== null;
  if (
    (row.status === "draft") === hasHead ||
    (hasHead && row.employment_record_version_id === null)
  ) {
    throw employmentConflict("Employment Record head state is invalid");
  }
  const currentVersion = hasHead
    ? mapVersion({
        effective_from: row.effective_from as string,
        effective_to: row.effective_to,
        employment_record_version_id: row.employment_record_version_id as string,
        employment_type_code: row.employment_type_code,
        organization_reference: row.organization_reference,
        position_reference: row.position_reference,
        supersedes_version_id: row.supersedes_version_id,
        terminal_version: row.terminal_version as boolean,
        version: row.version_number as number,
        version_kind: row.version_kind as EmploymentVersionKind,
      })
    : null;
  if ((currentVersion?.employmentRecordVersionId ?? null) !== row.current_version_id) {
    throw employmentConflict("Employment Record head state is invalid");
  }
  return {
    createdAt: canonicalTimestamp(row.created_at),
    currentVersion,
    employmentRecordId: row.employment_record_id,
    status: row.status,
    version: row.row_version,
    workerProfileId: row.worker_profile_id,
  };
}

const RECORD_COLUMNS = `record.employment_record_id, record.worker_profile_id, record.status,
  record.current_version_id, record.created_at, record.row_version,
  head.employment_record_version_id, head.effective_from::text AS effective_from,
  head.effective_to::text AS effective_to,
  head.employment_type_code, head.organization_reference, head.position_reference,
  head.supersedes_version_id, head.version AS version_number, head.version_kind,
  head.terminal_version`;

async function readRecord(
  transaction: TenantTransaction,
  employmentRecordId: string,
  lock?: "share" | "update",
): Promise<RecordRow | null> {
  const result = await transaction.client.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS}
     FROM hr_employment_records record
     LEFT JOIN hr_employment_record_versions head
       ON head.tenant_id=record.tenant_id
      AND head.employment_record_id=record.employment_record_id
      AND head.employment_record_version_id=record.current_version_id
     WHERE record.tenant_id=$1 AND record.employment_record_id=$2
     ${lock === "share" ? "FOR SHARE OF record" : lock === "update" ? "FOR UPDATE OF record" : ""}`,
    [transaction.context.tenantId, employmentRecordId],
  );
  return result.rows[0] ?? null;
}

async function readHistoryPage(
  transaction: TenantTransaction,
  employmentRecordId: string,
  limit: number,
  cursor?: EmploymentHistoryCursor,
): Promise<EmploymentRecordDetailResult["history"]> {
  const values: unknown[] = [transaction.context.tenantId, employmentRecordId];
  let cursorClause = "";
  if (cursor) {
    values.push(cursor.version, cursor.employmentRecordVersionId);
    cursorClause = `AND (version, employment_record_version_id) < ($3::integer, $4::uuid)`;
  }
  values.push(limit + 1);
  const result = await transaction.client.query<VersionRow>(
    `SELECT employment_record_version_id, effective_from::text AS effective_from,
            effective_to::text AS effective_to,
            employment_type_code, organization_reference, position_reference,
            supersedes_version_id, version, version_kind, terminal_version
     FROM hr_employment_record_versions
     WHERE tenant_id=$1 AND employment_record_id=$2 ${cursorClause}
     ORDER BY version DESC NULLS LAST, employment_record_version_id DESC NULLS LAST
     LIMIT $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = hasMore ? rows.at(-1) : undefined;
  return {
    items: rows.map(mapVersion),
    nextCursor: last
      ? {
          employmentRecordVersionId: last.employment_record_version_id,
          version: last.version,
        }
      : null,
  };
}

async function detailFromRow(
  transaction: TenantTransaction,
  row: RecordRow,
  accessScope: EmploymentAccessScope,
  limit = 50,
  cursor?: EmploymentHistoryCursor,
): Promise<EmploymentRecordDetailResult> {
  const summary = mapRecord(row);
  return {
    ...summary,
    accessScope,
    history: await readHistoryPage(transaction, summary.employmentRecordId, limit, cursor),
  };
}

async function requireDependencies(transaction: TenantTransaction): Promise<void> {
  if (
    transaction.lockedServiceActivation?.serviceKey !== HR_EMPLOYMENT_RECORD_SERVICE_KEY ||
    transaction.lockedServiceActivation.state !== "active"
  ) {
    throw new EmploymentError(
      "EMPLOYMENT_SERVICE_INACTIVE",
      "Employment Record service is inactive",
    );
  }
  const workforce = await transaction.client.query<{ state: string }>(
    `SELECT state FROM service_activations
     WHERE tenant_id=$1 AND service_key='workforce_profile'
     FOR SHARE`,
    [transaction.context.tenantId],
  );
  if (workforce.rows[0]?.state !== "active") {
    throw new EmploymentError(
      "EMPLOYMENT_DEPENDENCY_INACTIVE",
      "Employment Record dependency is inactive",
    );
  }
}

type TenantAction =
  | "create_record"
  | "create_version"
  | "end_record"
  | "list_authorized"
  | "view_detail";

async function hasCapability(
  transaction: TenantTransaction,
  actionKey: string,
  exposure: "admin" | "tenant",
): Promise<boolean> {
  const registered = hrManifest.capabilities.some(
    ({ exposure: candidateExposure, id }) => candidateExposure === exposure && id === actionKey,
  );
  if (!registered) return false;
  const result = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  return result.rows.length === 1;
}

const EMPLOYMENT_ACTION_ROLES: Readonly<
  Record<EmploymentAuthorizedAction, "employee_or_hr_operator" | "hr_operator" | "tenant_admin">
> = Object.freeze({
  activate_service: "tenant_admin",
  configure_service: "tenant_admin",
  create_record: "hr_operator",
  create_version: "hr_operator",
  deactivate_service: "tenant_admin",
  end_record: "hr_operator",
  list_authorized: "employee_or_hr_operator",
  view_detail: "employee_or_hr_operator",
  view_service_control: "tenant_admin",
});

function roleAllowsEmploymentAction(roleKey: string, action: EmploymentAuthorizedAction): boolean {
  const requiredRole = EMPLOYMENT_ACTION_ROLES[action];
  return requiredRole === "employee_or_hr_operator"
    ? roleKey === "employee" || roleKey === "hr_operator"
    : roleKey === requiredRole;
}

/**
 * Projects only the actor's exact current Employment capabilities. This snapshot is suitable for
 * advisory rendering; every action still performs its own transactional authorization.
 */
export async function inspectEmploymentActionAuthority(
  pool: Pool,
  context: OperationContext,
): Promise<readonly EmploymentAuthorizedAction[]> {
  return await withTenantTransaction(pool, context, async (transaction) => {
    const capabilityIds = HR_EMPLOYMENT_AUTHORIZED_ACTIONS.map(
      (action) => `hr.employment.${action}`,
    );
    const result = await transaction.client.query<{ capability_id: string }>(
      `SELECT capability_id FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=ANY($3::text[])
       ORDER BY capability_id`,
      [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityIds],
    );
    const current = new Set(result.rows.map(({ capability_id }) => capability_id));
    return Object.freeze(
      HR_EMPLOYMENT_AUTHORIZED_ACTIONS.filter((action) => {
        const actionKey = `hr.employment.${action}`;
        const registered = hrManifest.capabilities.some(({ id }) => id === actionKey);
        return (
          registered &&
          roleAllowsEmploymentAction(transaction.actor.roleKey, action) &&
          current.has(actionKey)
        );
      }),
    );
  });
}

async function authorizeTenantAction(
  transaction: TenantTransaction,
  action: TenantAction,
  role: "employee" | "hr_operator",
): Promise<void> {
  const actionKey = `hr.employment.${action}`;
  const capabilityCurrent = await hasCapability(transaction, actionKey, "tenant");
  const decision = evaluatePolicy(
    {
      actionKey,
      input: { capabilityCurrent, role },
      resourceKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
      transaction,
    },
    [
      {
        effect: "allow",
        id: `current_${role}_${action}`,
        matches: (input, actor) => actor.roleKey === input.role && input.capabilityCurrent,
      },
    ],
  );
  assertPolicyAllowed(decision, transaction, actionKey, HR_EMPLOYMENT_RECORD_SERVICE_KEY);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function responseSha256(record: EmploymentRecordDetailResult): string {
  return semanticSha256(record);
}

async function prepareMutation(
  transaction: TenantTransaction,
  action: MutationAction,
  idempotencyKey: string,
  semantics: unknown,
): Promise<MutationReceipt> {
  const normalizedKey = normalizeUuid(idempotencyKey, "idempotencyKey");
  const receiptId = deriveStableUuid(
    "hr.employment_record.idempotency.v1",
    transaction.context.tenantId.toLowerCase(),
    transaction.context.actorPrincipalId.toLowerCase(),
    action,
    normalizedKey,
  );
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))",
    [receiptId],
  );
  return {
    action,
    eventType: `hr.employment_record.${action}`,
    receiptId,
    semanticSha256: semanticSha256(semantics),
  };
}

const MUTATION_PAYLOAD_KEYS = [
  "action",
  "afterVersion",
  "beforeVersion",
  "billingState",
  "payloadVersion",
  "receiptId",
] as const;

function parseMutationPayload(
  value: unknown,
  receipt: MutationReceipt,
  aggregateVersion: number,
): MutationPayload {
  if (
    !isRecord(value) ||
    !exactKeys(value, MUTATION_PAYLOAD_KEYS) ||
    value.action !== receipt.action ||
    value.receiptId !== receipt.receiptId ||
    value.billingState !== HR_EMPLOYMENT_RECORD_BILLING_STATE ||
    value.payloadVersion !== 1 ||
    value.afterVersion !== aggregateVersion ||
    !Number.isSafeInteger(value.afterVersion) ||
    (value.afterVersion as number) < 1 ||
    (value.beforeVersion !== null &&
      (!Number.isSafeInteger(value.beforeVersion) || (value.beforeVersion as number) < 1)) ||
    (value.beforeVersion === null
      ? value.afterVersion !== 1
      : value.afterVersion !== (value.beforeVersion as number) + 1)
  ) {
    throw idempotencyConflict();
  }
  if ((receipt.action === "create_record") !== (value.beforeVersion === null)) {
    throw idempotencyConflict();
  }
  return value as unknown as MutationPayload;
}

async function reconstructMutationResponse(
  transaction: TenantTransaction,
  employmentRecordId: string,
  status: EmploymentRecordStatus,
  payload: MutationPayload,
): Promise<EmploymentRecordDetailResult> {
  const root = await transaction.client.query<{
    created_at: Date | string;
    row_version: number;
    worker_profile_id: string;
  }>(
    `SELECT worker_profile_id,created_at,row_version FROM hr_employment_records
     WHERE tenant_id=$1 AND employment_record_id=$2`,
    [transaction.context.tenantId, employmentRecordId],
  );
  const row = root.rows[0];
  if (
    root.rows.length !== 1 ||
    !row ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < payload.afterVersion
  ) {
    throw idempotencyConflict();
  }

  let currentVersion: EmploymentRecordVersionView | null = null;
  let history: EmploymentRecordDetailResult["history"] = { items: [], nextCursor: null };
  if (payload.afterVersion > 1) {
    const head = await transaction.client.query<VersionRow>(
      `SELECT employment_record_version_id,effective_from::text AS effective_from,
              effective_to::text AS effective_to,employment_type_code,
              organization_reference,position_reference,supersedes_version_id,
              version,version_kind,terminal_version
       FROM hr_employment_record_versions
       WHERE tenant_id=$1 AND employment_record_id=$2 AND version=$3`,
      [transaction.context.tenantId, employmentRecordId, payload.afterVersion - 1],
    );
    if (head.rows.length !== 1 || !head.rows[0]) throw idempotencyConflict();
    currentVersion = mapVersion(head.rows[0]);
    if (
      currentVersion.version !== payload.afterVersion - 1 ||
      (status === "ended") !== currentVersion.terminal
    ) {
      throw idempotencyConflict();
    }
    const historyRows = await transaction.client.query<VersionRow>(
      `SELECT employment_record_version_id,effective_from::text AS effective_from,
              effective_to::text AS effective_to,employment_type_code,
              organization_reference,position_reference,supersedes_version_id,
              version,version_kind,terminal_version
       FROM hr_employment_record_versions
       WHERE tenant_id=$1 AND employment_record_id=$2 AND version<=$3
       ORDER BY version DESC NULLS LAST,employment_record_version_id DESC NULLS LAST LIMIT 51`,
      [transaction.context.tenantId, employmentRecordId, currentVersion.version],
    );
    const hasMore = historyRows.rows.length > 50;
    const rows = historyRows.rows.slice(0, 50);
    const last = hasMore ? rows.at(-1) : undefined;
    history = {
      items: rows.map(mapVersion),
      nextCursor: last
        ? {
            employmentRecordVersionId: last.employment_record_version_id,
            version: last.version,
          }
        : null,
    };
  }
  try {
    return parseHrEmploymentRecord({
      accessScope: "tenant",
      createdAt: canonicalTimestamp(row.created_at),
      currentVersion,
      employmentRecordId,
      history,
      status,
      version: payload.afterVersion,
      workerProfileId: row.worker_profile_id,
    });
  } catch {
    throw idempotencyConflict();
  }
}

async function readMutationReplay(
  transaction: TenantTransaction,
  receipt: MutationReceipt,
): Promise<EmploymentRecordDetailResult | null> {
  const binding = await transaction.client.query<{
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT correlation_id, prior_state, new_state FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 AND event_type=$4
       AND actor_principal_id=$5
     ORDER BY occurred_at, evidence_event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      RECEIPT_SUBJECT_TYPE,
      receipt.receiptId,
      RESPONSE_BINDING_EVENT,
      transaction.context.actorPrincipalId,
    ],
  );
  if (binding.rows.length === 0) return null;
  const bound = binding.rows[0];
  if (binding.rows.length !== 1 || !bound || bound.prior_state !== receipt.semanticSha256) {
    throw idempotencyConflict();
  }
  const outbox = await transaction.client.query<{
    aggregate_id: string;
    aggregate_version: number;
    new_state: string;
    payload: unknown;
    prior_state: string | null;
  }>(
    `SELECT outbox.aggregate_id,outbox.aggregate_version,outbox.payload,
            evidence.prior_state,evidence.new_state
     FROM evidence_events evidence
     JOIN outbox_events outbox
       ON outbox.tenant_id=evidence.tenant_id
      AND outbox.event_type=evidence.event_type
      AND outbox.aggregate_type=evidence.subject_type
      AND outbox.aggregate_id=evidence.subject_id
      AND outbox.correlation_id=evidence.correlation_id
     WHERE evidence.tenant_id=$1 AND evidence.subject_type=$2
       AND evidence.event_type=$3 AND evidence.correlation_id=$4
       AND evidence.actor_principal_id=$5 AND outbox.payload->>'receiptId'=$6
     ORDER BY evidence.occurred_at,evidence.evidence_event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      SUBJECT_TYPE,
      receipt.eventType,
      bound.correlation_id,
      transaction.context.actorPrincipalId,
      receipt.receiptId,
    ],
  );
  const proof = outbox.rows[0];
  if (outbox.rows.length !== 1 || !proof) throw idempotencyConflict();
  const payload = parseMutationPayload(proof.payload, receipt, proof.aggregate_version);
  const stateValid =
    receipt.action === "create_record"
      ? proof.prior_state === null && proof.new_state === "draft"
      : receipt.action === "create_version"
        ? ["active", "draft"].includes(proof.prior_state ?? "") && proof.new_state === "active"
        : proof.prior_state === "active" && proof.new_state === "ended";
  if (
    !stateValid ||
    !UUID_PATTERN.test(proof.aggregate_id) ||
    proof.aggregate_id !== proof.aggregate_id.toLowerCase()
  ) {
    throw idempotencyConflict();
  }
  const record = await reconstructMutationResponse(
    transaction,
    proof.aggregate_id,
    proof.new_state as EmploymentRecordStatus,
    payload,
  );
  if (bound.new_state !== responseSha256(record)) {
    throw idempotencyConflict();
  }
  return record;
}

async function recordMutation(
  transaction: TenantTransaction,
  receipt: MutationReceipt,
  beforeVersion: number | null,
  priorState: EmploymentRecordStatus | null,
  record: EmploymentRecordDetailResult,
): Promise<void> {
  await recordMutationProof(transaction, {
    evidence: {
      eventType: receipt.eventType,
      newState: record.status,
      priorState,
      subjectId: record.employmentRecordId,
      subjectType: SUBJECT_TYPE,
    },
    outbox: {
      aggregateId: record.employmentRecordId,
      aggregateType: SUBJECT_TYPE,
      aggregateVersion: record.version,
      eventType: receipt.eventType,
      payload: {
        action: receipt.action,
        afterVersion: record.version,
        beforeVersion,
        billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
        payloadVersion: 1,
        receiptId: receipt.receiptId,
      },
    },
  });
  const binding = await appendEvidence(transaction, {
    eventType: RESPONSE_BINDING_EVENT,
    newState: responseSha256(record),
    priorState: receipt.semanticSha256,
    subjectId: receipt.receiptId,
    subjectType: RECEIPT_SUBJECT_TYPE,
  });
  if (binding.replayed) throw idempotencyConflict();
}

function mutationResult(
  operation: HrEmploymentRecordMutationOperation,
  record: EmploymentRecordDetailResult,
  replayed: boolean,
): EmploymentMutationResult {
  return {
    billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
    mutation: parseHrEmploymentRecordMutationResponse({
      currentVersion: record.currentVersion?.version ?? null,
      employmentRecordId: record.employmentRecordId,
      operation,
      rootVersion: record.version,
      status: record.status,
    }),
    replayed,
  };
}

function translateWriteError(error: unknown): never {
  if (error instanceof EmploymentError || error instanceof PlatformError) throw error;
  if (isPostgresCode(error, "23505")) throw employmentConflict();
  if (
    isPostgresCode(error, "40001") ||
    isPostgresCode(error, "40P01") ||
    isPostgresCode(error, "55P03")
  ) {
    throw employmentVersionConflict();
  }
  if (isPostgresCode(error, "55000")) throw employmentConflict();
  if (isPostgresCode(error, "42501")) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  throw error;
}

const employmentTransactionOptions = {
  serviceActivationKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
  serviceActivationLock: "share" as const,
};

export async function createEmploymentRecord(
  pool: Pool,
  context: OperationContext,
  input: CreateEmploymentRecordInput,
): Promise<EmploymentMutationResult> {
  const workerProfileId = normalizeUuid(input.workerProfileId, "workerProfileId");
  try {
    return await withTenantTransaction(
      pool,
      context,
      async (transaction) => {
        await requireDependencies(transaction);
        await authorizeTenantAction(transaction, "create_record", "hr_operator");
        const receipt = await prepareMutation(transaction, "create_record", input.idempotencyKey, {
          workerProfileId,
        });
        const replay = await readMutationReplay(transaction, receipt);
        if (replay) return mutationResult(receipt.action, replay, true);

        const worker = await transaction.client.query<{
          principal_id: string | null;
          workforce_status: string;
        }>(
          `SELECT principal_id, workforce_status FROM hr_worker_profiles
           WHERE tenant_id=$1 AND worker_profile_id=$2 FOR SHARE`,
          [transaction.context.tenantId, workerProfileId],
        );
        const profile = worker.rows[0];
        const eligible =
          (profile?.workforce_status === "active" && profile.principal_id !== null) ||
          (profile?.workforce_status === "draft" && profile.principal_id === null);
        if (!eligible)
          throw employmentConflict("Worker Profile is not eligible for employment facts");

        const inserted = await transaction.client.query<{ employment_record_id: string }>(
          `INSERT INTO hr_employment_records (tenant_id, worker_profile_id)
           VALUES ($1,$2) RETURNING employment_record_id`,
          [transaction.context.tenantId, workerProfileId],
        );
        const employmentRecordId = inserted.rows[0]?.employment_record_id;
        if (!employmentRecordId) throw employmentConflict();
        const row = await readRecord(transaction, employmentRecordId);
        if (!row) throw employmentConflict();
        const record = await detailFromRow(transaction, row, "tenant");
        await recordMutation(transaction, receipt, null, null, record);
        return mutationResult(receipt.action, record, false);
      },
      employmentTransactionOptions,
    );
  } catch (error) {
    return translateWriteError(error);
  }
}

async function assertEmploymentTypeAllowed(
  transaction: TenantTransaction,
  employmentTypeCode: string | null,
): Promise<void> {
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1::text,0))",
    [`hr.employment_record.settings.v1:${transaction.context.tenantId}`],
  );
  const result = await transaction.client.query<{
    settings_version: number;
    value: unknown;
    value_type: string | null;
    version: number | null;
  }>(
    `SELECT control.settings_version,
            COALESCE(setting.value, '"unspecified"'::jsonb) AS value,
            setting.value_type::text AS value_type,
            setting.version
     FROM hr_employment_record_service_control control
     LEFT JOIN tenant_settings setting
       ON setting.tenant_id=control.tenant_id AND setting.setting_key=$2
     WHERE control.tenant_id=$1 AND control.service_key='employment_record'`,
    [transaction.context.tenantId, EMPLOYMENT_TYPE_CODES_KEY],
  );
  const row = result.rows[0];
  if (
    !row ||
    typeof row.value !== "string" ||
    (row.settings_version === 1
      ? row.version !== null || row.value_type !== null
      : row.version !== row.settings_version - 1 || row.value_type !== "text")
  ) {
    throw employmentConflict("Employment Record settings are not current");
  }
  const allowed = row.value.split(",").map((code) => code.trim());
  if (
    allowed.some((code) => code.length === 0) ||
    !allowed.includes(employmentTypeCode ?? "unspecified")
  ) {
    throw employmentInputInvalid("employmentTypeCode is not enabled by tenant settings");
  }
}

export async function createEmploymentRecordVersion(
  pool: Pool,
  context: OperationContext,
  input: CreateEmploymentRecordVersionInput,
): Promise<EmploymentMutationResult> {
  const employmentRecordId = normalizeUuid(input.employmentRecordId, "employmentRecordId");
  assertPositiveVersion(input.expectedVersion, "expectedVersion");
  if (input.expectedCurrentVersion !== null) {
    assertPositiveVersion(input.expectedCurrentVersion, "expectedCurrentVersion");
  }
  const facts = normalizeFacts(input);
  try {
    return await withTenantTransaction(
      pool,
      context,
      async (transaction) => {
        await requireDependencies(transaction);
        await authorizeTenantAction(transaction, "create_version", "hr_operator");
        const receipt = await prepareMutation(transaction, "create_version", input.idempotencyKey, {
          employmentRecordId,
          expectedCurrentVersion: input.expectedCurrentVersion,
          expectedVersion: input.expectedVersion,
          ...facts,
        });
        const replay = await readMutationReplay(transaction, receipt);
        if (replay) return mutationResult(receipt.action, replay, true);
        await assertEmploymentTypeAllowed(transaction, facts.employmentTypeCode);

        const beforeRow = await readRecord(transaction, employmentRecordId, "update");
        if (!beforeRow) throw employmentNotFound();
        const before = mapRecord(beforeRow);
        if (before.version !== input.expectedVersion || before.status === "ended") {
          throw employmentVersionConflict();
        }
        const current = before.currentVersion;
        if ((current?.version ?? null) !== input.expectedCurrentVersion) {
          throw employmentVersionConflict();
        }
        if (current?.effectiveTo === null) {
          throw employmentConflict("An open-ended Employment Record can only be ended");
        }
        if (current && facts.effectiveFrom <= (current.effectiveTo as string)) {
          throw employmentConflict(
            "Employment Record successor must start after the current range",
          );
        }
        const overlaps = await transaction.client.query(
          `SELECT 1 FROM hr_employment_record_versions
           WHERE tenant_id=$1 AND employment_record_id=$2 AND version_kind='effective'
             AND daterange(effective_from, effective_to, '[]') &&
                 daterange($3::date, $4::date, '[]')
           LIMIT 1`,
          [
            transaction.context.tenantId,
            employmentRecordId,
            facts.effectiveFrom,
            facts.effectiveTo,
          ],
        );
        if (overlaps.rows[0])
          throw employmentConflict("Employment Record effective ranges overlap");

        const versionNumber = (current?.version ?? 0) + 1;
        const inserted = await transaction.client.query<{ employment_record_version_id: string }>(
          `INSERT INTO hr_employment_record_versions
             (tenant_id, employment_record_id, worker_profile_id, effective_from, effective_to,
              employment_type_code, organization_reference, position_reference,
              supersedes_version_id, version, version_kind, terminal_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'effective',false)
           RETURNING employment_record_version_id`,
          [
            transaction.context.tenantId,
            employmentRecordId,
            before.workerProfileId,
            facts.effectiveFrom,
            facts.effectiveTo,
            facts.employmentTypeCode,
            facts.organizationReference,
            facts.positionReference,
            beforeRow.current_version_id,
            versionNumber,
          ],
        );
        const headId = inserted.rows[0]?.employment_record_version_id;
        if (!headId) throw employmentConflict();
        const advanced = await transaction.client.query(
          `UPDATE hr_employment_records
           SET current_version_id=$3, status='active', row_version=row_version+1
           WHERE tenant_id=$1 AND employment_record_id=$2 AND row_version=$4
             AND current_version_id IS NOT DISTINCT FROM $5
           RETURNING row_version`,
          [
            transaction.context.tenantId,
            employmentRecordId,
            headId,
            input.expectedVersion,
            beforeRow.current_version_id,
          ],
        );
        if (!advanced.rows[0]) throw employmentVersionConflict();
        const afterRow = await readRecord(transaction, employmentRecordId);
        if (!afterRow) throw employmentConflict();
        const record = await detailFromRow(transaction, afterRow, "tenant");
        await recordMutation(transaction, receipt, before.version, before.status, record);
        return mutationResult(receipt.action, record, false);
      },
      employmentTransactionOptions,
    );
  } catch (error) {
    return translateWriteError(error);
  }
}

export async function endEmploymentRecord(
  pool: Pool,
  context: OperationContext,
  input: EndEmploymentRecordInput,
): Promise<EmploymentMutationResult> {
  const employmentRecordId = normalizeUuid(input.employmentRecordId, "employmentRecordId");
  const effectiveTo = normalizeDate(input.effectiveTo, "effectiveTo");
  assertPositiveVersion(input.expectedVersion, "expectedVersion");
  assertPositiveVersion(input.expectedCurrentVersion, "expectedCurrentVersion");
  try {
    return await withTenantTransaction(
      pool,
      context,
      async (transaction) => {
        await requireDependencies(transaction);
        await authorizeTenantAction(transaction, "end_record", "hr_operator");
        const receipt = await prepareMutation(transaction, "end_record", input.idempotencyKey, {
          effectiveTo,
          employmentRecordId,
          expectedCurrentVersion: input.expectedCurrentVersion,
          expectedVersion: input.expectedVersion,
        });
        const replay = await readMutationReplay(transaction, receipt);
        if (replay) return mutationResult(receipt.action, replay, true);

        const beforeRow = await readRecord(transaction, employmentRecordId, "update");
        if (!beforeRow) throw employmentNotFound();
        const before = mapRecord(beforeRow);
        const current = before.currentVersion;
        if (
          before.status !== "active" ||
          before.version !== input.expectedVersion ||
          !current ||
          current.version !== input.expectedCurrentVersion ||
          current.kind !== "effective"
        ) {
          throw employmentVersionConflict();
        }
        if (effectiveTo < current.effectiveFrom) {
          throw employmentInputInvalid("effectiveTo must not precede the current effectiveFrom");
        }
        const inserted = await transaction.client.query<{ employment_record_version_id: string }>(
          `INSERT INTO hr_employment_record_versions
             (tenant_id, employment_record_id, worker_profile_id, effective_from, effective_to,
              employment_type_code, organization_reference, position_reference,
              supersedes_version_id, version, version_kind, terminal_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'end',true)
           RETURNING employment_record_version_id`,
          [
            transaction.context.tenantId,
            employmentRecordId,
            before.workerProfileId,
            current.effectiveFrom,
            effectiveTo,
            current.employmentTypeCode,
            current.organizationReference,
            current.positionReference,
            current.employmentRecordVersionId,
            current.version + 1,
          ],
        );
        const headId = inserted.rows[0]?.employment_record_version_id;
        if (!headId) throw employmentConflict();
        const advanced = await transaction.client.query(
          `UPDATE hr_employment_records
           SET current_version_id=$3, status='ended', row_version=row_version+1
           WHERE tenant_id=$1 AND employment_record_id=$2 AND row_version=$4
             AND current_version_id=$5 RETURNING row_version`,
          [
            transaction.context.tenantId,
            employmentRecordId,
            headId,
            input.expectedVersion,
            current.employmentRecordVersionId,
          ],
        );
        if (!advanced.rows[0]) throw employmentVersionConflict();
        const afterRow = await readRecord(transaction, employmentRecordId);
        if (!afterRow) throw employmentConflict();
        const record = await detailFromRow(transaction, afterRow, "tenant");
        await recordMutation(transaction, receipt, before.version, before.status, record);
        return mutationResult(receipt.action, record, false);
      },
      employmentTransactionOptions,
    );
  } catch (error) {
    return translateWriteError(error);
  }
}

async function resolveAccessScope(
  transaction: TenantTransaction,
  action: "list_authorized" | "view_detail",
): Promise<{ accessScope: EmploymentAccessScope; workerProfileId: string | null }> {
  if (transaction.actor.roleKey === "hr_operator") {
    await authorizeTenantAction(transaction, action, "hr_operator");
    return { accessScope: "tenant", workerProfileId: null };
  }
  if (transaction.actor.roleKey !== "employee") {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  await authorizeTenantAction(transaction, action, "employee");
  const own = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id FROM hr_worker_profiles
     WHERE tenant_id=$1 AND principal_id=$2 AND workforce_status='active'
     ORDER BY worker_profile_id LIMIT 2 FOR SHARE`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId],
  );
  if (own.rows.length !== 1 || !own.rows[0]) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  return { accessScope: "own", workerProfileId: own.rows[0].worker_profile_id };
}

export async function listAuthorizedEmploymentRecords(
  pool: Pool,
  context: OperationContext,
  options: ListEmploymentRecordsOptions = {},
): Promise<EmploymentRecordListResult> {
  const limit = pageSize(options.pageSize);
  validateListCursor(options.cursor);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await requireDependencies(transaction);
      const authority = await resolveAccessScope(transaction, "list_authorized");
      const values: unknown[] = [transaction.context.tenantId];
      const clauses = ["record.tenant_id=$1"];
      if (authority.workerProfileId) {
        values.push(authority.workerProfileId);
        clauses.push(`record.worker_profile_id=$${values.length}`);
      }
      if (options.cursor) {
        values.push(options.cursor.createdAt, options.cursor.employmentRecordId);
        clauses.push(
          `(record.created_at, record.employment_record_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);
      const result = await transaction.client.query<RecordRow>(
        `SELECT ${RECORD_COLUMNS}
         FROM hr_employment_records record
         LEFT JOIN hr_employment_record_versions head
           ON head.tenant_id=record.tenant_id
          AND head.employment_record_id=record.employment_record_id
          AND head.employment_record_version_id=record.current_version_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY record.created_at DESC NULLS LAST,
                  record.employment_record_id DESC NULLS LAST
         LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = hasMore ? rows.at(-1) : undefined;
      return {
        accessScope: authority.accessScope,
        items: rows.map(mapRecord),
        nextCursor: last
          ? {
              createdAt: canonicalTimestamp(last.created_at),
              employmentRecordId: last.employment_record_id,
            }
          : null,
      };
    },
    employmentTransactionOptions,
  );
}

export async function getAuthorizedEmploymentRecordDetail(
  pool: Pool,
  context: OperationContext,
  options: GetEmploymentRecordDetailOptions,
): Promise<EmploymentRecordDetailResult> {
  const employmentRecordId = normalizeUuid(options.employmentRecordId, "employmentRecordId");
  const limit = pageSize(options.pageSize);
  validateHistoryCursor(options.cursor);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await requireDependencies(transaction);
      const authority = await resolveAccessScope(transaction, "view_detail");
      const row = await readRecord(transaction, employmentRecordId, "share");
      if (!row) throw employmentNotFound();
      if (
        authority.workerProfileId !== null &&
        row.worker_profile_id !== authority.workerProfileId
      ) {
        throw employmentNotFound();
      }
      return await detailFromRow(transaction, row, authority.accessScope, limit, options.cursor);
    },
    employmentTransactionOptions,
  );
}
