import { createHash } from "node:crypto";
import {
  type HrEmploymentRecordSettings,
  type HrServiceConfigureBody,
  type HrServiceControl,
  parseHrServiceControl,
} from "@esbla/contracts";
import {
  appendEvidence,
  assertPolicyAllowed,
  deriveStableUuid,
  evaluatePolicy,
  type OperationContext,
  PlatformError,
  type PolicyDecision,
  platformCoreManifest,
  recordMutationProof,
  type ServiceActivationResult,
  setServiceActivation,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { inspectActivationReadiness } from "./activation.js";
import {
  HR_EMPLOYMENT_RECORD_CATALOG_REQUIREMENTS,
  HR_EMPLOYMENT_RECORD_REQUIRED_MIGRATIONS,
  HR_EMPLOYMENT_RECORD_RUNTIME_TABLE_PRIVILEGES,
} from "./activation-readiness.js";
import {
  EmploymentError,
  HR_EMPLOYMENT_RECORD_BILLING_STATE,
  HR_EMPLOYMENT_RECORD_SERVICE_KEY,
} from "./employment.js";
import { hrManifest } from "./manifest.js";

const CONTROL_SUBJECT_TYPE = "hr.employment_record.service_control";
const CONTROL_RECEIPT_SUBJECT_TYPE = "hr.employment_record.service_control.idempotency";
const CONFIGURE_BINDING_EVENT = "hr.employment_record.configure_service.response_bound";
const INTERNAL_ACTIVATION_EVENT = "platform.service_activation.changed";
const EMPLOYMENT_TYPE_CODES_KEY = "hr.employment_record.employment_type_codes";
const OVERLAP_ALLOWED_KEY = "hr.employment_record.effective_range_overlap_allowed";

export type EmploymentActivationMode = "non_production" | "production";

export interface EmploymentServiceLifecycleInput {
  readonly expectedVersion: number | null;
}

export interface EmploymentServiceControlResult {
  readonly billingState: typeof HR_EMPLOYMENT_RECORD_BILLING_STATE;
  readonly control: HrServiceControl;
  readonly replayed: boolean;
}

interface ControlSnapshot {
  readonly control: HrServiceControl;
  readonly serviceControlId: string;
}

function inputInvalid(message: string): EmploymentError {
  return new EmploymentError("EMPLOYMENT_INPUT_INVALID", message);
}

function controlConflict(message = "Employment Record service control is invalid") {
  return new EmploymentError("EMPLOYMENT_CONFLICT", message);
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

function assertPositiveVersion(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw inputInvalid(`${field} must be a positive integer`);
  }
}

function canonicalTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw controlConflict();
  return date.toISOString();
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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeSettings(settings: HrEmploymentRecordSettings): HrEmploymentRecordSettings {
  if (
    !isRecord(settings) ||
    !exactKeys(settings, ["effectiveRangeOverlapAllowed", "employmentTypeCodes"]) ||
    settings.effectiveRangeOverlapAllowed !== false ||
    typeof settings.employmentTypeCodes !== "string"
  ) {
    throw inputInvalid("Employment Record settings input is invalid");
  }
  const codes = settings.employmentTypeCodes.split(",").map((code) => code.trim());
  if (codes.length < 1 || codes.some((code) => code.length === 0)) {
    throw inputInvalid("Employment Record settings input is invalid");
  }
  return { effectiveRangeOverlapAllowed: false, employmentTypeCodes: codes.join(",") };
}

async function requireWorkforceDependency(transaction: TenantTransaction): Promise<void> {
  const workforce = await transaction.client.query<{ state: string }>(
    `SELECT state FROM service_activations
     WHERE tenant_id=$1 AND service_key='workforce_profile' FOR SHARE`,
    [transaction.context.tenantId],
  );
  if (workforce.rows[0]?.state !== "active") {
    throw new EmploymentError(
      "EMPLOYMENT_DEPENDENCY_INACTIVE",
      "Employment Record dependency is inactive",
    );
  }
}

async function authorizeAdminAction(
  transaction: TenantTransaction,
  action: "activate_service" | "configure_service" | "deactivate_service" | "view_service_control",
): Promise<PolicyDecision> {
  const actionKey = `hr.employment.${action}`;
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "admin" && id === actionKey,
  );
  const capability = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  const input = { capabilityCurrent: registered && capability.rows.length === 1 };
  const rules = [
    {
      effect: "allow" as const,
      id: `current_tenant_admin_${action}`,
      matches: (_input: typeof input, actor: { roleKey: string }) =>
        actor.roleKey === "tenant_admin" && input.capabilityCurrent,
    },
  ];
  const decision = evaluatePolicy(
    { actionKey, input, resourceKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY, transaction },
    rules,
  );
  assertPolicyAllowed(decision, transaction, actionKey, HR_EMPLOYMENT_RECORD_SERVICE_KEY);
  if (action === "configure_service" || action === "view_service_control") return decision;
  const platformActionKey = `platform.service_activation.${
    action === "activate_service" ? "activate" : "deactivate"
  }`;
  const platformDecision = evaluatePolicy(
    {
      actionKey: platformActionKey,
      input,
      resourceKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
      transaction,
    },
    rules,
  );
  assertPolicyAllowed(
    platformDecision,
    transaction,
    platformActionKey,
    HR_EMPLOYMENT_RECORD_SERVICE_KEY,
  );
  return platformDecision;
}

async function readControl(
  transaction: TenantTransaction,
  expectedActivation: ServiceActivationResult | null,
): Promise<ControlSnapshot | null> {
  const result = await transaction.client.query<{
    activation_state: "active" | "inactive";
    activation_version: number;
    employment_type_codes: unknown;
    employment_type_codes_type: string | null;
    employment_type_codes_version: number | null;
    overlap_allowed: unknown;
    overlap_allowed_type: string | null;
    overlap_allowed_version: number | null;
    row_version: number;
    service_control_id: string;
    settings_version: number;
    updated_at: Date | string;
  }>(
    `SELECT control.service_control_id, control.settings_version, control.updated_at,
            control.row_version, activation.state AS activation_state,
            activation.version AS activation_version,
            COALESCE(codes.value, '"unspecified"'::jsonb) AS employment_type_codes,
            codes.value_type::text AS employment_type_codes_type,
            codes.version AS employment_type_codes_version,
            COALESCE(overlap.value, 'false'::jsonb) AS overlap_allowed,
            overlap.value_type::text AS overlap_allowed_type,
            overlap.version AS overlap_allowed_version
     FROM hr_employment_record_service_control control
     JOIN service_activations activation
       ON activation.tenant_id=control.tenant_id AND activation.service_key=control.service_key
     LEFT JOIN tenant_settings codes
       ON codes.tenant_id=control.tenant_id AND codes.setting_key=$2
     LEFT JOIN tenant_settings overlap
       ON overlap.tenant_id=control.tenant_id AND overlap.setting_key=$3
     WHERE control.tenant_id=$1 AND control.service_key='employment_record'`,
    [transaction.context.tenantId, EMPLOYMENT_TYPE_CODES_KEY, OVERLAP_ALLOWED_KEY],
  );
  const row = result.rows[0];
  if (!row) {
    if (expectedActivation) throw controlConflict();
    return null;
  }
  const settingsCurrent =
    row.settings_version === 1
      ? row.employment_type_codes_version === null &&
        row.employment_type_codes_type === null &&
        row.overlap_allowed_version === null &&
        row.overlap_allowed_type === null
      : row.employment_type_codes_version === row.settings_version - 1 &&
        row.employment_type_codes_type === "text" &&
        row.overlap_allowed_version === row.settings_version - 1 &&
        row.overlap_allowed_type === "boolean";
  if (
    !settingsCurrent ||
    typeof row.employment_type_codes !== "string" ||
    row.overlap_allowed !== false ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < 1 ||
    !Number.isSafeInteger(row.activation_version) ||
    row.activation_version < 1 ||
    !Number.isSafeInteger(row.settings_version) ||
    row.settings_version < 1 ||
    !expectedActivation ||
    expectedActivation.serviceKey !== HR_EMPLOYMENT_RECORD_SERVICE_KEY ||
    expectedActivation.state !== row.activation_state ||
    expectedActivation.version !== row.activation_version
  ) {
    throw controlConflict();
  }
  return {
    control: {
      activationState: row.activation_state,
      activationVersion: row.activation_version,
      serviceKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
      settings: normalizeSettings({
        effectiveRangeOverlapAllowed: false,
        employmentTypeCodes: row.employment_type_codes,
      }),
      settingsVersion: row.settings_version,
      updatedAt: canonicalTimestamp(row.updated_at),
      version: row.row_version,
    },
    serviceControlId: row.service_control_id,
  };
}

function lifecycleReceiptId(
  transaction: TenantTransaction,
  action: "activate_service" | "deactivate_service",
): string {
  return deriveStableUuid(
    "hr.employment_record.service_control.idempotency.v1",
    transaction.context.tenantId.toLowerCase(),
    transaction.context.actorPrincipalId.toLowerCase(),
    action,
    transaction.context.correlationId.toLowerCase(),
  );
}

async function readLifecycleReplay(
  transaction: TenantTransaction,
  action: "activate_service" | "deactivate_service",
): Promise<HrServiceControl> {
  const receiptId = lifecycleReceiptId(transaction, action);
  const bindingEvent = `hr.employment_record.${action}.response_bound`;
  const binding = await transaction.client.query<{
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT correlation_id,prior_state,new_state FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 AND event_type=$4
       AND actor_principal_id=$5 ORDER BY occurred_at,evidence_event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      CONTROL_RECEIPT_SUBJECT_TYPE,
      receiptId,
      bindingEvent,
      transaction.context.actorPrincipalId,
    ],
  );
  const bound = binding.rows[0];
  if (
    binding.rows.length !== 1 ||
    !bound ||
    bound.prior_state !== action ||
    bound.correlation_id !== transaction.context.correlationId
  ) {
    throw idempotencyConflict();
  }
  const result = await transaction.client.query<{ aggregate_version: number; payload: unknown }>(
    `SELECT aggregate_version,payload FROM outbox_events
     WHERE tenant_id=$1 AND aggregate_type=$2 AND event_type=$3 AND correlation_id=$4
       AND payload->>'receiptId'=$5
     ORDER BY occurred_at,event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      CONTROL_SUBJECT_TYPE,
      `hr.employment_record.${action}`,
      bound.correlation_id,
      receiptId,
    ],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || !isRecord(row.payload)) throw idempotencyConflict();
  if (
    !exactKeys(row.payload, [
      "action",
      "afterVersion",
      "beforeVersion",
      "billingState",
      "control",
      "payloadVersion",
      "receiptId",
    ]) ||
    row.payload.action !== action ||
    row.payload.receiptId !== receiptId ||
    row.payload.afterVersion !== row.aggregate_version ||
    row.payload.beforeVersion !==
      (row.aggregate_version === 1 ? null : row.aggregate_version - 1) ||
    row.payload.billingState !== HR_EMPLOYMENT_RECORD_BILLING_STATE ||
    row.payload.payloadVersion !== 1 ||
    !isRecord(row.payload.control)
  ) {
    throw idempotencyConflict();
  }
  try {
    const control = parseHrServiceControl(row.payload.control);
    if (control.version !== row.aggregate_version || bound.new_state !== sha256(control)) {
      throw idempotencyConflict();
    }
    return control;
  } catch {
    throw idempotencyConflict();
  }
}

async function runLifecycle(
  transaction: TenantTransaction,
  input: EmploymentServiceLifecycleInput,
  action: "activate_service" | "deactivate_service",
  preflight?: () => Promise<{ current: boolean; reasons: readonly string[] }>,
): Promise<EmploymentServiceControlResult> {
  const authorization = await authorizeAdminAction(transaction, action);
  if (action === "activate_service") await requireWorkforceDependency(transaction);
  const targetState = action === "activate_service" ? "active" : "inactive";
  const result = await setServiceActivation(transaction, {
    authorization,
    evidenceEventType: `evidence.hr.employment_record.service.${targetState}`,
    expectedVersion: input.expectedVersion,
    outboxEventType: INTERNAL_ACTIVATION_EVENT,
    ...(preflight ? { preflight } : {}),
    serviceKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
    targetState,
  });
  if (result.replayed) {
    return {
      billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
      control: await readLifecycleReplay(transaction, action),
      replayed: true,
    };
  }
  const snapshot = await readControl(transaction, result);
  if (!snapshot) throw controlConflict("Employment Record service control is missing");
  const receiptId = lifecycleReceiptId(transaction, action);
  await recordMutationProof(transaction, {
    evidence: {
      eventType: `hr.employment_record.${action}`,
      newState: result.state,
      priorState: result.state === "active" ? "inactive" : "active",
      subjectId: snapshot.serviceControlId,
      subjectType: CONTROL_SUBJECT_TYPE,
    },
    outbox: {
      aggregateId: snapshot.serviceControlId,
      aggregateType: CONTROL_SUBJECT_TYPE,
      aggregateVersion: snapshot.control.version,
      eventType: `hr.employment_record.${action}`,
      payload: {
        action,
        afterVersion: snapshot.control.version,
        beforeVersion: snapshot.control.version === 1 ? null : snapshot.control.version - 1,
        billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
        control: snapshot.control,
        payloadVersion: 1,
        receiptId,
      },
    },
  });
  const binding = await appendEvidence(transaction, {
    eventType: `hr.employment_record.${action}.response_bound`,
    newState: sha256(snapshot.control),
    priorState: action,
    subjectId: receiptId,
    subjectType: CONTROL_RECEIPT_SUBJECT_TYPE,
  });
  if (binding.replayed) throw idempotencyConflict();
  return {
    billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
    control: snapshot.control,
    replayed: false,
  };
}

function semanticReadiness(mode: EmploymentActivationMode) {
  if (mode === "production") {
    return { current: false, reasons: ["qualified_retention_evidence_unavailable"] };
  }
  const required = [
    "hr.employment.activate_service",
    "hr.employment.configure_service",
    "hr.employment.deactivate_service",
    "hr.employment.view_service_control",
  ];
  const registered = new Set<string>(
    hrManifest.capabilities.filter(({ exposure }) => exposure === "admin").map(({ id }) => id),
  );
  if (!required.every((id) => registered.has(id))) {
    return { current: false, reasons: ["service_not_eligible"] };
  }
  const requiredCore = [
    "platform.evidence.append",
    "platform.policy.evaluate",
    "platform.tenant_transaction.run",
  ];
  const core = new Set<string>(platformCoreManifest.capabilities.map(({ id }) => id));
  if (
    platformCoreManifest.activation !== "required" ||
    !hrManifest.dependencies.includes(platformCoreManifest.id) ||
    !requiredCore.every((id) => core.has(id))
  ) {
    return { current: false, reasons: ["non_soft_dependency_not_eligible"] };
  }
  return { current: true, reasons: [] };
}

async function probeActivationReplay(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: EmploymentServiceLifecycleInput,
): Promise<EmploymentServiceControlResult | null> {
  const preflightRequired = new Error("Employment Record activation readiness phase is required");
  try {
    return await withTenantTransaction(
      runtimePool,
      context,
      async (transaction) =>
        await runLifecycle(transaction, input, "activate_service", async () => {
          if (runtimePool === migrationReadPool) {
            return { current: false, reasons: ["migration_reader_not_isolated"] };
          }
          throw preflightRequired;
        }),
      {
        migrationBarrier: "shared",
        serviceActivationKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
        serviceActivationLock: "update",
      },
    );
  } catch (error) {
    if (error === preflightRequired) return null;
    throw error;
  }
}

export async function activateEmploymentRecordService(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: EmploymentServiceLifecycleInput,
  mode: EmploymentActivationMode,
): Promise<EmploymentServiceControlResult> {
  if (input.expectedVersion !== null)
    assertPositiveVersion(input.expectedVersion, "expectedVersion");
  const replay = await probeActivationReplay(runtimePool, migrationReadPool, context, input);
  if (replay) return replay;
  let migrationClient: PoolClient | null;
  try {
    migrationClient = await migrationReadPool.connect();
  } catch {
    migrationClient = null;
  }
  try {
    return await withTenantTransaction(
      runtimePool,
      context,
      async (transaction) =>
        await runLifecycle(transaction, input, "activate_service", async () => {
          const client = migrationClient;
          if (!client) return { current: false, reasons: ["migration_ledger_unavailable"] };
          migrationClient = null;
          return await inspectActivationReadiness(transaction, client, {
            catalog: HR_EMPLOYMENT_RECORD_CATALOG_REQUIREMENTS,
            migrations: HR_EMPLOYMENT_RECORD_REQUIRED_MIGRATIONS,
            runtimeTablePrivileges: HR_EMPLOYMENT_RECORD_RUNTIME_TABLE_PRIVILEGES,
            semantic: semanticReadiness(mode),
          });
        }),
      {
        migrationBarrier: "shared",
        serviceActivationKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
        serviceActivationLock: "update",
      },
    );
  } finally {
    migrationClient?.release();
  }
}

export async function deactivateEmploymentRecordService(
  runtimePool: Pool,
  context: OperationContext,
  input: EmploymentServiceLifecycleInput & { readonly expectedVersion: number },
): Promise<EmploymentServiceControlResult> {
  assertPositiveVersion(input.expectedVersion, "expectedVersion");
  return await withTenantTransaction(
    runtimePool,
    context,
    async (transaction) => await runLifecycle(transaction, input, "deactivate_service"),
    {
      serviceActivationKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
      serviceActivationLock: "update",
    },
  );
}

export async function getEmploymentRecordServiceControl(
  runtimePool: Pool,
  context: OperationContext,
): Promise<EmploymentServiceControlResult> {
  return await withTenantTransaction(
    runtimePool,
    context,
    async (transaction) => {
      await authorizeAdminAction(transaction, "view_service_control");
      const activation = transaction.lockedServiceActivation
        ? { ...transaction.lockedServiceActivation, replayed: false }
        : null;
      const snapshot = await readControl(transaction, activation);
      if (!snapshot) {
        throw new EmploymentError(
          "EMPLOYMENT_SERVICE_CONTROL_NOT_FOUND",
          "Employment Record service control was not found",
        );
      }
      return {
        billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
        control: snapshot.control,
        replayed: false,
      };
    },
    {
      serviceActivationKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
      serviceActivationLock: "share",
    },
  );
}

function configureReceiptId(transaction: TenantTransaction): string {
  return deriveStableUuid(
    "hr.employment_record.service_control.idempotency.v1",
    transaction.context.tenantId.toLowerCase(),
    transaction.context.actorPrincipalId.toLowerCase(),
    "configure_service",
    transaction.context.correlationId.toLowerCase(),
  );
}

async function readConfigureReplay(
  transaction: TenantTransaction,
  receiptId: string,
  semantics: string,
): Promise<HrServiceControl | null> {
  const binding = await transaction.client.query<{
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT correlation_id,prior_state,new_state FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 AND event_type=$4
       AND actor_principal_id=$5 ORDER BY occurred_at,evidence_event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      CONTROL_RECEIPT_SUBJECT_TYPE,
      receiptId,
      CONFIGURE_BINDING_EVENT,
      transaction.context.actorPrincipalId,
    ],
  );
  if (binding.rows.length === 0) return null;
  const bound = binding.rows[0];
  if (binding.rows.length !== 1 || !bound || bound.prior_state !== semantics) {
    throw idempotencyConflict();
  }
  const outbox = await transaction.client.query<{ aggregate_version: number; payload: unknown }>(
    `SELECT aggregate_version,payload FROM outbox_events
     WHERE tenant_id=$1 AND aggregate_type=$2
       AND event_type='hr.employment_record.configure_service' AND correlation_id=$3
     ORDER BY occurred_at,event_id LIMIT 2`,
    [transaction.context.tenantId, CONTROL_SUBJECT_TYPE, bound.correlation_id],
  );
  const row = outbox.rows[0];
  if (outbox.rows.length !== 1 || !row || !isRecord(row.payload)) throw idempotencyConflict();
  const payload = row.payload;
  if (
    !exactKeys(payload, [
      "action",
      "afterVersion",
      "beforeVersion",
      "billingState",
      "control",
      "payloadVersion",
      "receiptId",
    ]) ||
    payload.action !== "configure_service" ||
    payload.receiptId !== receiptId ||
    payload.afterVersion !== row.aggregate_version ||
    payload.beforeVersion !== (row.aggregate_version === 1 ? null : row.aggregate_version - 1) ||
    payload.billingState !== HR_EMPLOYMENT_RECORD_BILLING_STATE ||
    payload.payloadVersion !== 1 ||
    !isRecord(payload.control)
  ) {
    throw idempotencyConflict();
  }
  try {
    const control = parseHrServiceControl(payload.control);
    if (control.version !== row.aggregate_version || bound.new_state !== sha256(control)) {
      throw idempotencyConflict();
    }
    return control;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw idempotencyConflict();
  }
}

export async function configureEmploymentRecordService(
  runtimePool: Pool,
  context: OperationContext,
  input: HrServiceConfigureBody,
): Promise<EmploymentServiceControlResult> {
  assertPositiveVersion(input.expectedSettingsVersion, "expectedSettingsVersion");
  const settings = normalizeSettings(input.settings as HrEmploymentRecordSettings);
  return await withTenantTransaction(
    runtimePool,
    context,
    async (transaction) => {
      await authorizeAdminAction(transaction, "configure_service");
      if (
        transaction.lockedServiceActivation?.serviceKey !== HR_EMPLOYMENT_RECORD_SERVICE_KEY ||
        transaction.lockedServiceActivation.state !== "active"
      ) {
        throw new EmploymentError(
          "EMPLOYMENT_SERVICE_INACTIVE",
          "Employment Record service is inactive",
        );
      }
      const receiptId = configureReceiptId(transaction);
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [receiptId],
      );
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [`hr.employment_record.settings.v1:${transaction.context.tenantId}`],
      );
      const semantics = sha256({
        expectedSettingsVersion: input.expectedSettingsVersion,
        settings,
      });
      const replay = await readConfigureReplay(transaction, receiptId, semantics);
      if (replay) {
        return {
          billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
          control: replay,
          replayed: true,
        };
      }
      try {
        await transaction.client.query(
          "SELECT public.esbla_configure_hr_employment_record_settings($1,$2,$3)",
          [input.expectedSettingsVersion, settings.employmentTypeCodes, false],
        );
      } catch (error) {
        if (isPostgresCode(error, "22023") || isPostgresCode(error, "22003")) {
          throw inputInvalid("Employment Record settings input is invalid");
        }
        if (isPostgresCode(error, "42501")) {
          throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
        }
        if (
          isPostgresCode(error, "40001") ||
          isPostgresCode(error, "40P01") ||
          isPostgresCode(error, "55P03")
        ) {
          throw controlConflict("Employment Record service control currentness check failed");
        }
        if (isPostgresCode(error, "55000")) throw controlConflict();
        throw error;
      }
      const activation = transaction.lockedServiceActivation
        ? { ...transaction.lockedServiceActivation, replayed: false }
        : null;
      const snapshot = await readControl(transaction, activation);
      if (!snapshot) throw controlConflict("Employment Record service control is missing");
      await recordMutationProof(transaction, {
        evidence: {
          eventType: "hr.employment_record.configure_service",
          newState: String(snapshot.control.settingsVersion),
          priorState: String(input.expectedSettingsVersion),
          subjectId: snapshot.serviceControlId,
          subjectType: CONTROL_SUBJECT_TYPE,
        },
        outbox: {
          aggregateId: snapshot.serviceControlId,
          aggregateType: CONTROL_SUBJECT_TYPE,
          aggregateVersion: snapshot.control.version,
          eventType: "hr.employment_record.configure_service",
          payload: {
            action: "configure_service",
            afterVersion: snapshot.control.version,
            beforeVersion: snapshot.control.version === 1 ? null : snapshot.control.version - 1,
            billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
            control: snapshot.control,
            payloadVersion: 1,
            receiptId,
          },
        },
      });
      const binding = await appendEvidence(transaction, {
        eventType: CONFIGURE_BINDING_EVENT,
        newState: sha256(snapshot.control),
        priorState: semantics,
        subjectId: receiptId,
        subjectType: CONTROL_RECEIPT_SUBJECT_TYPE,
      });
      if (binding.replayed) throw idempotencyConflict();
      return {
        billingState: HR_EMPLOYMENT_RECORD_BILLING_STATE,
        control: snapshot.control,
        replayed: false,
      };
    },
    {
      serviceActivationKey: HR_EMPLOYMENT_RECORD_SERVICE_KEY,
      serviceActivationLock: "share",
    },
  );
}
