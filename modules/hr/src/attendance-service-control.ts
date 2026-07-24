import { createHash } from "node:crypto";
import {
  type HrAttendanceSettings,
  type HrServiceConfigureBody,
  type HrServiceControl,
  hrAttendanceSettingsDefaults,
  parseHrServiceControl,
} from "@esbla/contracts/hr-service-control-api";
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
import type { Pool } from "pg";
import {
  HR_ATTENDANCE_BILLING_STATE,
  HR_ATTENDANCE_SERVICE_KEY,
  HrAttendanceError,
} from "./attendance.js";
import { hrManifest } from "./manifest.js";

const CONTROL_SUBJECT = "hr.attendance.service_control";
const RECEIPT_SUBJECT = "hr.attendance.service_control.idempotency";
const RECEIPT_NAMESPACE = "hr.attendance.service_control.idempotency.v1";
const INTERNAL_ACTIVATION_EVENT = "platform.service_activation.changed";
const CORRECTION_KEY = "hr.attendance.correction_note_required";
const MANUAL_KEY = "hr.attendance.manual_observation_kinds";
type ControlAction =
  | "activate_service"
  | "configure_service"
  | "deactivate_service"
  | "view_service_control";
type MutationAction = Exclude<ControlAction, "view_service_control">;
export type HrAttendanceActivationMode = "non_production" | "production";
export interface AttendanceServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export interface AttendanceServiceControlResult {
  readonly billingState: typeof HR_ATTENDANCE_BILLING_STATE;
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

function inputInvalid(message: string): HrAttendanceError {
  return new HrAttendanceError("ATTENDANCE_INPUT_INVALID", message);
}
function controlConflict(message = "Attendance service control is invalid"): HrAttendanceError {
  return new HrAttendanceError("ATTENDANCE_CONFLICT", message);
}
function versionConflict(): HrAttendanceError {
  return new HrAttendanceError("ATTENDANCE_VERSION_CONFLICT", "Attendance version conflict");
}
function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Attendance service-control data",
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function postgresCode(error: unknown, ...codes: readonly string[]): boolean {
  return isRecord(error) && typeof error.code === "string" && codes.includes(error.code);
}
function assertVersion(value: number, field: string): void {
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
function timestamp(value: Date | string): string {
  const selected = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(selected.valueOf())) throw controlConflict();
  return selected.toISOString();
}
function normalizeSettings(value: unknown): HrAttendanceSettings {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["correctionNoteRequired", "manualObservationKinds"]) ||
    value.correctionNoteRequired !== true ||
    typeof value.manualObservationKinds !== "string" ||
    !["", "presence_start", "presence_end", "presence_start,presence_end"].includes(
      value.manualObservationKinds,
    )
  ) {
    throw inputInvalid("Attendance settings input is invalid");
  }
  return {
    correctionNoteRequired: true,
    manualObservationKinds:
      value.manualObservationKinds as HrAttendanceSettings["manualObservationKinds"],
  };
}
function validateControl(value: unknown): HrServiceControl {
  try {
    const control = parseHrServiceControl(value);
    if (
      control.serviceKey !== HR_ATTENDANCE_SERVICE_KEY ||
      control.version !== control.activationVersion + control.settingsVersion - 1
    ) {
      throw controlConflict();
    }
    return control;
  } catch (error) {
    if (error instanceof HrAttendanceError) throw error;
    throw controlConflict();
  }
}
async function authorizeAdmin(
  transaction: TenantTransaction,
  action: ControlAction,
): Promise<PolicyDecision> {
  const actionKey = `hr.attendance.${action}`;
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
      id: `current_tenant_admin_${action}_attendance`,
      matches: (_input: typeof input, actor: { roleKey: string }) =>
        actor.roleKey === "tenant_admin" && input.capabilityCurrent,
    },
  ];
  const decision = evaluatePolicy(
    { actionKey, input, resourceKey: HR_ATTENDANCE_SERVICE_KEY, transaction },
    rules,
  );
  assertPolicyAllowed(decision, transaction, actionKey, HR_ATTENDANCE_SERVICE_KEY);
  if (action === "configure_service" || action === "view_service_control") return decision;
  const platformAction = `platform.service_activation.${
    action === "activate_service" ? "activate" : "deactivate"
  }`;
  const platformDecision = evaluatePolicy(
    { actionKey: platformAction, input, resourceKey: HR_ATTENDANCE_SERVICE_KEY, transaction },
    rules,
  );
  assertPolicyAllowed(platformDecision, transaction, platformAction, HR_ATTENDANCE_SERVICE_KEY);
  return platformDecision;
}
async function requireWorkforceActive(transaction: TenantTransaction): Promise<void> {
  const result = await transaction.client
    .query<{ state: string }>(
      `SELECT state FROM service_activations
       WHERE tenant_id=$1 AND service_key='workforce_profile' FOR SHARE NOWAIT`,
      [transaction.context.tenantId],
    )
    .catch((error: unknown) => {
      if (postgresCode(error, "55P03")) throw versionConflict();
      throw error;
    });
  if (result.rows[0]?.state !== "active") {
    throw new HrAttendanceError(
      "ATTENDANCE_DEPENDENCY_INACTIVE",
      "Attendance dependency is inactive",
    );
  }
}
function settingsFromRows(rows: readonly ControlRow[], version: number): HrAttendanceSettings {
  const selected = rows.filter((row) => row.setting_key !== null);
  if (version === 1) {
    if (rows.length !== 1 || selected.length !== 0) throw controlConflict();
    return { ...hrAttendanceSettingsDefaults };
  }
  const byKey = new Map(selected.map((row) => [String(row.setting_key), row]));
  const correction = byKey.get(CORRECTION_KEY);
  const manual = byKey.get(MANUAL_KEY);
  if (
    rows.length !== 2 ||
    correction?.setting_value_type !== "boolean" ||
    correction.setting_value !== true ||
    correction.setting_version !== version - 1 ||
    manual?.setting_value_type !== "text" ||
    !["", "presence_start", "presence_end", "presence_start,presence_end"].includes(
      String(manual.setting_value),
    ) ||
    manual.setting_version !== version - 1
  ) {
    throw controlConflict("Attendance settings are not current");
  }
  return {
    correctionNoteRequired: true,
    manualObservationKinds: manual.setting_value as HrAttendanceSettings["manualObservationKinds"],
  };
}
async function readControl(
  transaction: TenantTransaction,
  activation: ServiceActivationResult | null,
): Promise<ControlSnapshot | null> {
  const result = await transaction.client.query<ControlRow>(
    `SELECT control.service_control_id,control.settings_version,control.updated_at,
            control.row_version,activation.state AS activation_state,
            activation.version AS activation_version,setting.setting_key,
            setting.value AS setting_value,setting.value_type::text AS setting_value_type,
            setting.version AS setting_version
     FROM hr_attendance_service_control control
     JOIN service_activations activation
       ON activation.tenant_id=control.tenant_id AND activation.service_key=control.service_key
     LEFT JOIN tenant_settings setting
       ON setting.tenant_id=control.tenant_id
      AND setting.setting_key=ANY($2::text[])
     WHERE control.tenant_id=$1 AND control.service_key='attendance'
     ORDER BY setting.setting_key LIMIT 3`,
    [transaction.context.tenantId, [CORRECTION_KEY, MANUAL_KEY]],
  );
  const row = result.rows[0];
  if (!row) {
    if (activation) throw controlConflict();
    return null;
  }
  if (
    !activation ||
    activation.serviceKey !== HR_ATTENDANCE_SERVICE_KEY ||
    activation.state !== row.activation_state ||
    activation.version !== row.activation_version ||
    row.row_version !== row.activation_version + row.settings_version - 1 ||
    result.rows.some(
      (candidate) =>
        candidate.service_control_id !== row.service_control_id ||
        candidate.row_version !== row.row_version ||
        candidate.settings_version !== row.settings_version ||
        candidate.activation_state !== row.activation_state ||
        candidate.activation_version !== row.activation_version,
    )
  ) {
    throw controlConflict();
  }
  const control = validateControl({
    activationState: row.activation_state,
    activationVersion: row.activation_version,
    serviceKey: HR_ATTENDANCE_SERVICE_KEY,
    settings: settingsFromRows(result.rows, row.settings_version),
    settingsVersion: row.settings_version,
    updatedAt: timestamp(row.updated_at),
    version: row.row_version,
  });
  return { control, serviceControlId: row.service_control_id };
}
function result(control: HrServiceControl, replayed: boolean): AttendanceServiceControlResult {
  return { billingState: HR_ATTENDANCE_BILLING_STATE, control, replayed };
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
async function readReplay(
  transaction: TenantTransaction,
  action: MutationAction,
  semantics: string,
): Promise<HrServiceControl | null> {
  const id = receiptId(transaction, action);
  const eventType = `hr.attendance.${action}`;
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
     FROM evidence_events evidence JOIN outbox_events outbox
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
  if (proof.rows.length !== 1 || !row || !isRecord(row.payload)) throw idempotencyConflict();
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
    payload.billingState !== HR_ATTENDANCE_BILLING_STATE ||
    payload.payloadVersion !== 1
  ) {
    throw idempotencyConflict();
  }
  const control = validateControl(payload.control);
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
async function recordResult(
  transaction: TenantTransaction,
  action: MutationAction,
  semantics: string,
  snapshot: ControlSnapshot,
  priorState: string,
  newState: string,
): Promise<void> {
  const id = receiptId(transaction, action);
  const eventType = `hr.attendance.${action}`;
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
        billingState: HR_ATTENDANCE_BILLING_STATE,
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
async function lifecycle(
  transaction: TenantTransaction,
  input: AttendanceServiceLifecycleInput,
  action: "activate_service" | "deactivate_service",
  mode: HrAttendanceActivationMode,
): Promise<AttendanceServiceControlResult> {
  const authorization = await authorizeAdmin(transaction, action);
  if (action === "deactivate_service" && transaction.lockedServiceActivation?.state !== "active") {
    throw new HrAttendanceError("ATTENDANCE_SERVICE_INACTIVE", "Attendance service is inactive");
  }
  if (action === "activate_service") await requireWorkforceActive(transaction);
  const targetState = action === "activate_service" ? "active" : "inactive";
  const activation = await setServiceActivation(transaction, {
    authorization,
    evidenceEventType: `evidence.hr.attendance.service.${targetState}`,
    expectedVersion: input.expectedVersion,
    outboxEventType: INTERNAL_ACTIVATION_EVENT,
    ...(action === "activate_service"
      ? {
          preflight: async () =>
            mode === "production"
              ? { current: false, reasons: ["qualified_retention_evidence_required"] }
              : { current: true, reasons: [] },
        }
      : {}),
    serviceKey: HR_ATTENDANCE_SERVICE_KEY,
    targetState,
  });
  if (activation.replayed) {
    const replay = await readReplay(transaction, action, action);
    if (!replay) throw idempotencyConflict();
    return result(replay, true);
  }
  const snapshot = await readControl(transaction, activation);
  if (!snapshot) throw controlConflict("Attendance service control is missing");
  await recordResult(
    transaction,
    action,
    action,
    snapshot,
    targetState === "active" ? "inactive" : "active",
    targetState,
  );
  return result(snapshot.control, false);
}
export async function activateAttendanceService(
  pool: Pool,
  context: OperationContext,
  input: AttendanceServiceLifecycleInput,
  mode: HrAttendanceActivationMode,
): Promise<AttendanceServiceControlResult> {
  if (input.expectedVersion !== null) assertVersion(input.expectedVersion, "expectedVersion");
  if (mode !== "non_production" && mode !== "production") {
    throw inputInvalid("Attendance activation mode is invalid");
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => await lifecycle(transaction, input, "activate_service", mode),
    { serviceActivationKey: HR_ATTENDANCE_SERVICE_KEY, serviceActivationLock: "update" },
  );
}
export async function deactivateAttendanceService(
  pool: Pool,
  context: OperationContext,
  input: AttendanceServiceLifecycleInput & { readonly expectedVersion: number },
): Promise<AttendanceServiceControlResult> {
  assertVersion(input.expectedVersion, "expectedVersion");
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) =>
      await lifecycle(transaction, input, "deactivate_service", "non_production"),
    { serviceActivationKey: HR_ATTENDANCE_SERVICE_KEY, serviceActivationLock: "update" },
  );
}
export async function getAttendanceServiceControl(
  pool: Pool,
  context: OperationContext,
): Promise<AttendanceServiceControlResult> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await authorizeAdmin(transaction, "view_service_control");
      const activation = transaction.lockedServiceActivation
        ? { ...transaction.lockedServiceActivation, replayed: false }
        : null;
      const snapshot = await readControl(transaction, activation);
      if (!snapshot) {
        throw new HrAttendanceError(
          "ATTENDANCE_SERVICE_CONTROL_NOT_FOUND",
          "Attendance service control was not found",
        );
      }
      return result(snapshot.control, false);
    },
    { serviceActivationKey: HR_ATTENDANCE_SERVICE_KEY, serviceActivationLock: "share" },
  );
}
function translateConfigureError(error: unknown): never {
  if (error instanceof HrAttendanceError || error instanceof PlatformError) throw error;
  if (postgresCode(error, "22003", "22023")) {
    throw inputInvalid("Attendance settings input is invalid");
  }
  if (postgresCode(error, "42501")) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  if (postgresCode(error, "40001", "40P01", "55P03")) throw versionConflict();
  if (postgresCode(error, "55000")) throw controlConflict();
  throw error;
}
export async function configureAttendanceService(
  pool: Pool,
  context: OperationContext,
  input: HrServiceConfigureBody,
): Promise<AttendanceServiceControlResult> {
  assertVersion(input.expectedSettingsVersion, "expectedSettingsVersion");
  const settings = normalizeSettings(input.settings);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await authorizeAdmin(transaction, "configure_service");
      if (transaction.lockedServiceActivation?.state !== "active") {
        throw new HrAttendanceError(
          "ATTENDANCE_SERVICE_INACTIVE",
          "Attendance service is inactive",
        );
      }
      const id = receiptId(transaction, "configure_service");
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [id],
      );
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [`hr.attendance.settings.v1:${transaction.context.tenantId}`],
      );
      const semantics = sha256({
        expectedSettingsVersion: input.expectedSettingsVersion,
        settings,
      });
      const replay = await readReplay(transaction, "configure_service", semantics);
      if (replay) return result(replay, true);
      try {
        await transaction.client.query(
          "SELECT public.esbla_configure_hr_attendance_settings($1,$2,$3)",
          [input.expectedSettingsVersion, settings.manualObservationKinds, true],
        );
      } catch (error) {
        translateConfigureError(error);
      }
      const activation = transaction.lockedServiceActivation
        ? { ...transaction.lockedServiceActivation, replayed: false }
        : null;
      const snapshot = await readControl(transaction, activation);
      if (!snapshot) throw controlConflict("Attendance service control is missing");
      await recordResult(
        transaction,
        "configure_service",
        semantics,
        snapshot,
        String(input.expectedSettingsVersion),
        String(snapshot.control.settingsVersion),
      );
      return result(snapshot.control, false);
    },
    { serviceActivationKey: HR_ATTENDANCE_SERVICE_KEY, serviceActivationLock: "share" },
  );
}
