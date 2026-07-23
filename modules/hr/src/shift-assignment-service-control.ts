import { createHash } from "node:crypto";
import {
  type HrServiceConfigureBody,
  type HrServiceControl,
  type HrShiftAssignmentSettings,
  hrShiftAssignmentSettingsDefaults,
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
  recordMutationProof,
  type ServiceActivationResult,
  setServiceActivation,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { inspectActivationReadiness } from "./activation.js";
import { hrManifest } from "./manifest.js";
import {
  HR_SHIFT_ASSIGNMENT_BILLING_STATE,
  HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
  HrShiftAssignmentError,
} from "./shift-assignment.js";
import {
  HR_SHIFT_ASSIGNMENT_CATALOG_REQUIREMENTS,
  HR_SHIFT_ASSIGNMENT_REQUIRED_MIGRATIONS,
  HR_SHIFT_ASSIGNMENT_RUNTIME_TABLE_PRIVILEGES,
  type HrShiftAssignmentActivationMode,
  inspectShiftAssignmentSemanticReadiness,
} from "./shift-assignment-readiness.js";

const CONTROL_SUBJECT = "hr.shift_assignment.service_control";
const RECEIPT_SUBJECT = "hr.shift_assignment.service_control.idempotency";
const RECEIPT_NAMESPACE = "hr.shift_assignment.service_control.idempotency.v1";
const INTERNAL_ACTIVATION_EVENT = "platform.service_activation.changed";
const OVERLAP_KEY = "hr.shift_assignment.overlap_allowed";
const HORIZON_KEY = "hr.shift_assignment.roster_horizon_days";
type ControlAction =
  | "activate_service"
  | "configure_service"
  | "deactivate_service"
  | "view_service_control";
type MutationAction = Exclude<ControlAction, "view_service_control">;
export interface ShiftAssignmentServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export interface ShiftAssignmentServiceControlResult {
  readonly billingState: typeof HR_SHIFT_ASSIGNMENT_BILLING_STATE;
  readonly control: HrServiceControl;
  readonly replayed: boolean;
}
interface ControlSnapshot {
  readonly control: HrServiceControl;
  readonly serviceControlId: string;
}
interface ControlRow {
  readonly activation_state: "active" | "inactive";
  readonly activation_version: number;
  readonly row_version: number;
  readonly service_control_id: string;
  readonly setting_key: string | null;
  readonly setting_value: unknown;
  readonly setting_value_type: string | null;
  readonly setting_version: number | null;
  readonly settings_version: number;
  readonly updated_at: Date | string;
}
function inputInvalid(message: string): HrShiftAssignmentError {
  return new HrShiftAssignmentError("SHIFT_INPUT_INVALID", message);
}
function controlConflict(message = "Shift Assignment service control is invalid") {
  return new HrShiftAssignmentError("SHIFT_CONFLICT", message);
}
const versionError = () => new HrShiftAssignmentError("SHIFT_VERSION_CONFLICT", "Version conflict");
function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Shift Assignment service-control data",
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function postgresCode(error: unknown, ...codes: readonly string[]): boolean {
  const code = isRecord(error) ? error.code : null;
  return typeof code === "string" && codes.includes(code);
}
function assertPositiveVersion(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw inputInvalid(`${field} must be a positive integer`);
  }
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function canonicalTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw controlConflict();
  return timestamp.toISOString();
}
function normalizeSettings(value: unknown): HrShiftAssignmentSettings {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["overlapAllowed", "rosterHorizonDays"]) ||
    value.overlapAllowed !== false ||
    !Number.isSafeInteger(value.rosterHorizonDays) ||
    Number(value.rosterHorizonDays) < 1 ||
    Number(value.rosterHorizonDays) > 31
  ) {
    throw inputInvalid("Shift Assignment settings input is invalid");
  }
  return { overlapAllowed: false, rosterHorizonDays: Number(value.rosterHorizonDays) };
}
function validateStoredControl(value: unknown): HrServiceControl {
  try {
    const control = parseHrServiceControl(value);
    if (
      control.serviceKey !== HR_SHIFT_ASSIGNMENT_SERVICE_KEY ||
      control.version !== control.activationVersion + control.settingsVersion - 1
    ) {
      throw controlConflict();
    }
    return control;
  } catch (error) {
    if (error instanceof HrShiftAssignmentError) throw error;
    throw controlConflict();
  }
}
async function authorizeAdminAction(
  transaction: TenantTransaction,
  action: ControlAction,
): Promise<PolicyDecision> {
  const actionKey = `hr.shift.${action}`;
  const manifestCurrent = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "admin" && id === actionKey,
  );
  const capability = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  const input = { capabilityCurrent: manifestCurrent && capability.rows.length === 1 };
  const rules = [
    {
      effect: "allow" as const,
      id: `current_tenant_admin_${action}_shift_assignment`,
      matches: (_input: typeof input, actor: { roleKey: string }) =>
        actor.roleKey === "tenant_admin" && input.capabilityCurrent,
    },
  ];
  const serviceDecision = evaluatePolicy(
    { actionKey, input, resourceKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY, transaction },
    rules,
  );
  assertPolicyAllowed(serviceDecision, transaction, actionKey, HR_SHIFT_ASSIGNMENT_SERVICE_KEY);
  if (action === "configure_service" || action === "view_service_control") {
    return serviceDecision;
  }
  const platformAction = `platform.service_activation.${
    action === "activate_service" ? "activate" : "deactivate"
  }`;
  const platformDecision = evaluatePolicy(
    { actionKey: platformAction, input, resourceKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY, transaction },
    rules,
  );
  assertPolicyAllowed(
    platformDecision,
    transaction,
    platformAction,
    HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
  );
  return platformDecision;
}
async function requireWorkforceActive(transaction: TenantTransaction): Promise<void> {
  const workforce = await transaction.client
    .query<{ state: string }>(
      `SELECT state FROM service_activations
       WHERE tenant_id=$1 AND service_key='workforce_profile' FOR SHARE NOWAIT`,
      [transaction.context.tenantId],
    )
    .catch((error: unknown) => {
      if (postgresCode(error, "55P03")) {
        throw versionError();
      }
      throw error;
    });
  if (workforce.rows[0]?.state !== "active") {
    throw new HrShiftAssignmentError(
      "SHIFT_DEPENDENCY_INACTIVE",
      "Shift Assignment dependency is inactive",
    );
  }
}
function settingsFromRows(rows: readonly ControlRow[], settingsVersion: number) {
  const selected = rows.filter((row) => row.setting_key !== null);
  if (settingsVersion === 1) {
    if (selected.length !== 0 || rows.length !== 1 || rows[0]?.setting_key !== null) {
      throw controlConflict();
    }
    return { ...hrShiftAssignmentSettingsDefaults };
  }
  const byKey = new Map(selected.map((row) => [String(row.setting_key), row]));
  const overlap = byKey.get(OVERLAP_KEY);
  const horizon = byKey.get(HORIZON_KEY);
  if (
    rows.length !== 2 ||
    selected.length !== 2 ||
    overlap?.setting_value_type !== "boolean" ||
    overlap.setting_value !== false ||
    overlap.setting_version !== settingsVersion - 1 ||
    horizon?.setting_value_type !== "integer" ||
    !Number.isSafeInteger(horizon.setting_value) ||
    Number(horizon.setting_value) < 1 ||
    Number(horizon.setting_value) > 31 ||
    horizon.setting_version !== settingsVersion - 1
  ) {
    throw controlConflict("Shift Assignment settings are not current");
  }
  return { overlapAllowed: false as const, rosterHorizonDays: Number(horizon.setting_value) };
}
async function readControl(
  transaction: TenantTransaction,
  expectedActivation: ServiceActivationResult | null,
): Promise<ControlSnapshot | null> {
  const result = await transaction.client.query<ControlRow>(
    `SELECT control.service_control_id,control.settings_version,control.updated_at,
            control.row_version,activation.state AS activation_state,
            activation.version AS activation_version,setting.setting_key,
            setting.value AS setting_value,setting.value_type::text AS setting_value_type,
            setting.version AS setting_version
     FROM hr_shift_assignment_service_control control
     JOIN service_activations activation
       ON activation.tenant_id=control.tenant_id AND activation.service_key=control.service_key
     LEFT JOIN tenant_settings setting
       ON setting.tenant_id=control.tenant_id
      AND setting.setting_key=ANY($2::text[])
     WHERE control.tenant_id=$1 AND control.service_key='shift_assignment'
     ORDER BY setting.setting_key LIMIT 3`,
    [transaction.context.tenantId, [OVERLAP_KEY, HORIZON_KEY]],
  );
  const row = result.rows[0];
  if (!row) {
    if (expectedActivation) throw controlConflict();
    return null;
  }
  if (
    !expectedActivation ||
    expectedActivation.serviceKey !== HR_SHIFT_ASSIGNMENT_SERVICE_KEY ||
    expectedActivation.state !== row.activation_state ||
    expectedActivation.version !== row.activation_version ||
    !Number.isSafeInteger(row.activation_version) ||
    row.activation_version < 1 ||
    !Number.isSafeInteger(row.settings_version) ||
    row.settings_version < 1 ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < 1 ||
    row.row_version !== row.activation_version + row.settings_version - 1 ||
    result.rows.some(
      (candidate) =>
        candidate.service_control_id !== row.service_control_id ||
        candidate.settings_version !== row.settings_version ||
        candidate.row_version !== row.row_version ||
        candidate.activation_state !== row.activation_state ||
        candidate.activation_version !== row.activation_version,
    )
  ) {
    throw controlConflict();
  }
  const settings = settingsFromRows(result.rows, row.settings_version);
  const control = validateStoredControl({
    activationState: row.activation_state,
    activationVersion: row.activation_version,
    serviceKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
    settings,
    settingsVersion: row.settings_version,
    updatedAt: canonicalTimestamp(row.updated_at),
    version: row.row_version,
  });
  return { control, serviceControlId: row.service_control_id };
}
function controlResult(
  control: HrServiceControl,
  replayed: boolean,
): ShiftAssignmentServiceControlResult {
  return { billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE, control, replayed };
}
function receiptId(transaction: TenantTransaction, action: MutationAction): string {
  return deriveStableUuid(
    RECEIPT_NAMESPACE,
    transaction.context.tenantId.toLowerCase(),
    transaction.context.actorPrincipalId.toLowerCase(),
    action,
    transaction.context.correlationId.toLowerCase(),
  );
}
async function readBoundReplay(
  transaction: TenantTransaction,
  action: MutationAction,
  semantics: string,
): Promise<HrServiceControl | null> {
  const id = receiptId(transaction, action);
  const eventType = `hr.shift_assignment.${action}`;
  const binding = await transaction.client.query<{
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT correlation_id,prior_state,new_state FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3
       AND event_type=$4 AND actor_principal_id=$5
     ORDER BY occurred_at,evidence_event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      RECEIPT_SUBJECT,
      id,
      `${eventType}.response_bound`,
      transaction.context.actorPrincipalId,
    ],
  );
  if (binding.rows.length === 0) return null;
  const bound = binding.rows[0];
  if (
    binding.rows.length !== 1 ||
    !bound ||
    bound.correlation_id !== transaction.context.correlationId ||
    bound.prior_state !== semantics
  ) {
    throw idempotencyConflict();
  }
  const proof = await transaction.client.query<{
    aggregate_version: number;
    new_state: string;
    payload: unknown;
    prior_state: string | null;
  }>(
    `SELECT outbox.aggregate_version,outbox.payload,evidence.prior_state,evidence.new_state
     FROM evidence_events evidence
     JOIN outbox_events outbox
       ON outbox.tenant_id=evidence.tenant_id
      AND outbox.aggregate_type=evidence.subject_type
      AND outbox.aggregate_id=evidence.subject_id
      AND outbox.event_type=evidence.event_type
      AND outbox.correlation_id=evidence.correlation_id
     WHERE evidence.tenant_id=$1 AND evidence.subject_type=$2
       AND evidence.event_type=$3 AND evidence.correlation_id=$4
       AND evidence.actor_principal_id=$5 AND outbox.payload->>'receiptId'=$6
     ORDER BY evidence.occurred_at,evidence.evidence_event_id LIMIT 2`,
    [
      transaction.context.tenantId,
      CONTROL_SUBJECT,
      eventType,
      bound.correlation_id,
      transaction.context.actorPrincipalId,
      id,
    ],
  );
  const row = proof.rows[0];
  if (proof.rows.length !== 1 || !row || !isRecord(row.payload)) {
    throw idempotencyConflict();
  }
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
    payload.action !== action ||
    payload.receiptId !== id ||
    payload.afterVersion !== row.aggregate_version ||
    payload.beforeVersion !== (row.aggregate_version === 1 ? null : row.aggregate_version - 1) ||
    payload.billingState !== HR_SHIFT_ASSIGNMENT_BILLING_STATE ||
    payload.payloadVersion !== 1
  ) {
    throw idempotencyConflict();
  }
  const control = validateStoredControl(payload.control);
  const transitionCurrent =
    action === "configure_service"
      ? row.prior_state === String(control.settingsVersion - 1) &&
        row.new_state === String(control.settingsVersion)
      : row.prior_state === (action === "activate_service" ? "inactive" : "active") &&
        row.new_state === (action === "activate_service" ? "active" : "inactive") &&
        control.activationState === row.new_state;
  if (
    control.version !== row.aggregate_version ||
    !transitionCurrent ||
    bound.new_state !== sha256(control)
  ) {
    throw idempotencyConflict();
  }
  return control;
}
async function recordControlResult(
  transaction: TenantTransaction,
  action: MutationAction,
  semantics: string,
  snapshot: ControlSnapshot,
  priorState: string,
  newState: string,
): Promise<void> {
  const id = receiptId(transaction, action);
  const eventType = `hr.shift_assignment.${action}`;
  await recordMutationProof(transaction, {
    evidence: {
      eventType,
      newState,
      priorState,
      subjectId: snapshot.serviceControlId,
      subjectType: CONTROL_SUBJECT,
    },
    outbox: {
      aggregateId: snapshot.serviceControlId,
      aggregateType: CONTROL_SUBJECT,
      aggregateVersion: snapshot.control.version,
      eventType,
      payload: {
        action,
        afterVersion: snapshot.control.version,
        beforeVersion: snapshot.control.version === 1 ? null : snapshot.control.version - 1,
        billingState: HR_SHIFT_ASSIGNMENT_BILLING_STATE,
        control: snapshot.control,
        payloadVersion: 1,
        receiptId: id,
      },
    },
  });
  const binding = await appendEvidence(transaction, {
    eventType: `${eventType}.response_bound`,
    newState: sha256(snapshot.control),
    priorState: semantics,
    subjectId: id,
    subjectType: RECEIPT_SUBJECT,
  });
  if (binding.replayed) throw idempotencyConflict();
}
async function runLifecycle(
  transaction: TenantTransaction,
  input: ShiftAssignmentServiceLifecycleInput,
  action: "activate_service" | "deactivate_service",
  preflight?: () => Promise<{ current: boolean; reasons: readonly string[] }>,
): Promise<ShiftAssignmentServiceControlResult> {
  const authorization = await authorizeAdminAction(transaction, action);
  if (action === "activate_service") await requireWorkforceActive(transaction);
  const targetState = action === "activate_service" ? "active" : "inactive";
  const activation = await setServiceActivation(transaction, {
    authorization,
    evidenceEventType: `evidence.hr.shift_assignment.service.${targetState}`,
    expectedVersion: input.expectedVersion,
    outboxEventType: INTERNAL_ACTIVATION_EVENT,
    ...(preflight ? { preflight } : {}),
    serviceKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
    targetState,
  });
  if (activation.replayed) {
    const replay = await readBoundReplay(transaction, action, action);
    if (!replay) throw idempotencyConflict();
    return controlResult(replay, true);
  }
  const snapshot = await readControl(transaction, activation);
  if (!snapshot) throw controlConflict("Shift Assignment service control is missing");
  await recordControlResult(
    transaction,
    action,
    action,
    snapshot,
    targetState === "active" ? "inactive" : "active",
    targetState,
  );
  return controlResult(snapshot.control, false);
}
async function probeActivationReplay(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: ShiftAssignmentServiceLifecycleInput,
): Promise<ShiftAssignmentServiceControlResult | null> {
  const preflightRequired = new Error("Shift Assignment activation readiness phase is required");
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
        serviceActivationKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
        serviceActivationLock: "update",
      },
    );
  } catch (error) {
    if (error === preflightRequired) return null;
    throw error;
  }
}
export async function activateShiftAssignmentService(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: ShiftAssignmentServiceLifecycleInput,
  mode: HrShiftAssignmentActivationMode,
): Promise<ShiftAssignmentServiceControlResult> {
  if (input.expectedVersion !== null)
    assertPositiveVersion(input.expectedVersion, "expectedVersion");
  if (mode !== "non_production" && mode !== "production") {
    throw inputInvalid("Shift Assignment activation mode is invalid");
  }
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
          const semantic = await inspectShiftAssignmentSemanticReadiness(client, mode);
          return await inspectActivationReadiness(transaction, client, {
            catalog: HR_SHIFT_ASSIGNMENT_CATALOG_REQUIREMENTS,
            migrations: HR_SHIFT_ASSIGNMENT_REQUIRED_MIGRATIONS,
            runtimeTablePrivileges: HR_SHIFT_ASSIGNMENT_RUNTIME_TABLE_PRIVILEGES,
            semantic,
          });
        }),
      {
        migrationBarrier: "shared",
        serviceActivationKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
        serviceActivationLock: "update",
      },
    );
  } finally {
    migrationClient?.release();
  }
}
export async function deactivateShiftAssignmentService(
  runtimePool: Pool,
  context: OperationContext,
  input: ShiftAssignmentServiceLifecycleInput & { readonly expectedVersion: number },
): Promise<ShiftAssignmentServiceControlResult> {
  assertPositiveVersion(input.expectedVersion, "expectedVersion");
  return await withTenantTransaction(
    runtimePool,
    context,
    async (transaction) => await runLifecycle(transaction, input, "deactivate_service"),
    {
      serviceActivationKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
      serviceActivationLock: "update",
    },
  );
}
export async function getShiftAssignmentServiceControl(
  runtimePool: Pool,
  context: OperationContext,
): Promise<ShiftAssignmentServiceControlResult> {
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
        throw new HrShiftAssignmentError(
          "SHIFT_SERVICE_CONTROL_NOT_FOUND",
          "Shift Assignment service control was not found",
        );
      }
      return controlResult(snapshot.control, false);
    },
    {
      serviceActivationKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
      serviceActivationLock: "share",
    },
  );
}
function translateConfigureError(error: unknown): never {
  if (error instanceof HrShiftAssignmentError || error instanceof PlatformError) throw error;
  if (postgresCode(error, "22003", "22023")) {
    throw inputInvalid("Shift Assignment settings input is invalid");
  }
  if (postgresCode(error, "42501")) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  if (postgresCode(error, "40001", "40P01", "55P03")) {
    throw versionError();
  }
  if (postgresCode(error, "55000")) throw controlConflict();
  throw error;
}
export async function configureShiftAssignmentService(
  runtimePool: Pool,
  context: OperationContext,
  input: HrServiceConfigureBody,
): Promise<ShiftAssignmentServiceControlResult> {
  assertPositiveVersion(input.expectedSettingsVersion, "expectedSettingsVersion");
  const settings = normalizeSettings(input.settings);
  return await withTenantTransaction(
    runtimePool,
    context,
    async (transaction) => {
      await authorizeAdminAction(transaction, "configure_service");
      if (
        transaction.lockedServiceActivation?.serviceKey !== HR_SHIFT_ASSIGNMENT_SERVICE_KEY ||
        transaction.lockedServiceActivation.state !== "active"
      ) {
        throw new HrShiftAssignmentError(
          "SHIFT_SERVICE_INACTIVE",
          "Shift Assignment service is inactive",
        );
      }
      const id = receiptId(transaction, "configure_service");
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [id],
      );
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [`hr.shift_assignment.settings.v1:${transaction.context.tenantId}`],
      );
      const semantics = sha256({
        expectedSettingsVersion: input.expectedSettingsVersion,
        settings,
      });
      const replay = await readBoundReplay(transaction, "configure_service", semantics);
      if (replay) return controlResult(replay, true);
      try {
        await transaction.client.query(
          "SELECT public.esbla_configure_hr_shift_assignment_settings($1,$2,$3)",
          [input.expectedSettingsVersion, settings.rosterHorizonDays, false],
        );
      } catch (error) {
        translateConfigureError(error);
      }
      const activation = transaction.lockedServiceActivation
        ? { ...transaction.lockedServiceActivation, replayed: false }
        : null;
      const snapshot = await readControl(transaction, activation);
      if (!snapshot) throw controlConflict("Shift Assignment service control is missing");
      await recordControlResult(
        transaction,
        "configure_service",
        semantics,
        snapshot,
        String(input.expectedSettingsVersion),
        String(snapshot.control.settingsVersion),
      );
      return controlResult(snapshot.control, false);
    },
    {
      serviceActivationKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
      serviceActivationLock: "share",
    },
  );
}
