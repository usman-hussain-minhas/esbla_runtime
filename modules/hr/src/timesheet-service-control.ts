import { createHash } from "node:crypto";
import {
  type HrServiceConfigureBody,
  type HrServiceControl,
  type HrTimesheetSettings,
  hrTimesheetSettingsDefaults,
  parseHrServiceControl,
} from "@esbla/contracts/hr-service-control-api";
import {
  type ActivationPreflight,
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
  HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS,
  HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS,
} from "./activation-readiness.js";
import { hrManifest } from "./manifest.js";

export const HR_TIMESHEET_SERVICE_KEY = "timesheet";
export const HR_TIMESHEET_BILLING_STATE = "non_billable";

const CONTROL_SUBJECT = "hr.timesheet.service_control";
const RECEIPT_NAMESPACE = "hr.timesheet.service_control.idempotency.v1";
const INTERNAL_ACTIVATION_EVENT = "platform.service_activation.changed";
const MAX_DAILY_MINUTES_KEY = "hr.timesheet.max_daily_minutes";
const PERIOD_CADENCE_KEY = "hr.timesheet.period_cadence";
const REJECTION_NOTE_REQUIRED_KEY = "hr.timesheet.rejection_note_required";
const RETENTION_EVENT = "hr.timesheet.retention.qualified";
const RETENTION_SUBJECT = "hr.timesheet.retention_qualification";
const RETENTION_SUBJECT_ID = "ce2fb833-0dff-8e0b-a54e-29b33022ac26";
const CONTROL_ACTIONS = Object.freeze([
  "activate_service",
  "configure_service",
  "deactivate_service",
  "view_service_control",
] as const);
export const HR_TIMESHEET_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "approve",
  "configure_service",
  "create",
  "create_correction",
  "deactivate_service",
  "edit_draft",
  "list_assigned",
  "list_own",
  "reject",
  "submit",
  "view_detail",
  "view_service_control",
] as const);
const REQUIRED_TIMESHEET_CAPABILITIES =
  "admin:hr.timesheet.activate_service,tenant:hr.timesheet.approve,admin:hr.timesheet.configure_service,tenant:hr.timesheet.create,tenant:hr.timesheet.create_correction,admin:hr.timesheet.deactivate_service,tenant:hr.timesheet.edit_draft,tenant:hr.timesheet.list_assigned,tenant:hr.timesheet.list_own,tenant:hr.timesheet.reject,tenant:hr.timesheet.submit,tenant:hr.timesheet.view_detail,admin:hr.timesheet.view_service_control".split(
    ",",
  );
const REQUIRED_WORKFORCE_CAPABILITIES =
  "admin:hr.workforce.activate_service,tenant:hr.workforce.change_reporting_relationship,tenant:hr.workforce.change_status,tenant:hr.workforce.create_profile,admin:hr.workforce.configure_service,admin:hr.workforce.deactivate_service,tenant:hr.workforce.link_principal,tenant:hr.workforce.list_authorized,tenant:hr.workforce.view_authorized_detail,tenant:hr.workforce.view_own,admin:hr.workforce.view_service_control".split(
    ",",
  );
const REQUIRED_CORE_CAPABILITIES =
  "internal:platform.activation.set,internal:platform.evidence.append,internal:platform.policy.evaluate,internal:platform.presentation.layouts.read_own,internal:platform.presentation.layouts.reset_own,internal:platform.presentation.layouts.write_own,internal:platform.presentation.preferences.read_own,internal:platform.presentation.preferences.write_own,internal:platform.settings.resolve,internal:platform.studio.surface_base.draft,internal:platform.studio.surface_base.publish,internal:platform.studio.surface_base.read,internal:platform.studio.surface_base.rollback,internal:platform.studio.surface_base.validate,internal:platform.tenant_transaction.run,internal:platform.work_item.manage".split(
    ",",
  );
const REQUIRED_WORKSPACE_CAPABILITIES =
  "tenant:workspace.task.complete,tenant:workspace.task.create,tenant:workspace.task.list_assigned,tenant:workspace.task.view".split(
    ",",
  );
const TIMESHEET_REQUIRED_MIGRATIONS = [
  ...HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS,
  {
    createdAt: 1783670597328,
    hash: "bad1e166455700e4af97a12ce6fd2c88a975ed3e57c16e72ca622092cb4811df",
    id: "0004",
  },
  {
    createdAt: 1784921930943,
    hash: "d2e4a77c7d06672a5348abd39a9b06ee8c267be10efe7b21868f6b62dba4bccc",
    id: "0020",
  },
  {
    createdAt: 1784924992189,
    hash: "f6076ed481451093ccb5a996afea806f2499056517282207a2f0265e97601414",
    id: "0021",
  },
  {
    createdAt: 1784944010163,
    hash: "642ff06564f73c935ef15daa893603c021715654291f11fa5265d86b896635ed",
    id: "0022",
  },
] as const;
type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type HrTimesheetAuthorizedAction = (typeof HR_TIMESHEET_AUTHORIZED_ACTIONS)[number];
type MutationAction = Exclude<ControlAction, "view_service_control">;
export type HrTimesheetActivationMode = "non_production" | "production";
export type HrTimesheetErrorCode =
  | "TIMESHEET_APPROVER_UNAVAILABLE"
  | "TIMESHEET_CONFLICT"
  | "TIMESHEET_DEPENDENCY_INACTIVE"
  | "TIMESHEET_INPUT_INVALID"
  | "TIMESHEET_NOT_FOUND"
  | "TIMESHEET_SERVICE_CONTROL_NOT_FOUND"
  | "TIMESHEET_SERVICE_INACTIVE"
  | "TIMESHEET_VERSION_CONFLICT";
export class HrTimesheetError extends Error {
  constructor(
    readonly code: HrTimesheetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HrTimesheetError";
  }
}
export interface TimesheetServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export interface TimesheetServiceControlResult {
  readonly billingState: typeof HR_TIMESHEET_BILLING_STATE;
  readonly control: HrServiceControl;
  readonly replayed: boolean;
}
export interface TimesheetDependencyManifest {
  readonly activation: string;
  readonly capabilities: readonly {
    readonly exposure: string;
    readonly id: string;
  }[];
  readonly dependencies: readonly string[];
  readonly id: string;
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
function inputInvalid(message: string): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_INPUT_INVALID", message);
}
function controlConflict(message = "Timesheet service control is invalid"): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_CONFLICT", message);
}
function versionConflict(): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_VERSION_CONFLICT", "Timesheet version conflict");
}
function serviceInactive(): HrTimesheetError {
  return new HrTimesheetError("TIMESHEET_SERVICE_INACTIVE", "Timesheet service is inactive");
}
function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Timesheet service-control data",
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
function normalizeSettings(value: unknown): HrTimesheetSettings {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["maxDailyMinutes", "periodCadence", "rejectionNoteRequired"]) ||
    !Number.isSafeInteger(value.maxDailyMinutes) ||
    (value.maxDailyMinutes as number) < 1 ||
    (value.maxDailyMinutes as number) > 1440 ||
    value.periodCadence !== "weekly" ||
    typeof value.rejectionNoteRequired !== "boolean"
  ) {
    throw inputInvalid("Timesheet settings input is invalid");
  }
  return value as unknown as HrTimesheetSettings;
}
function validateControl(value: unknown): HrServiceControl {
  try {
    const control = parseHrServiceControl(value);
    if (
      control.serviceKey !== HR_TIMESHEET_SERVICE_KEY ||
      control.version !== control.activationVersion + control.settingsVersion - 1
    ) {
      throw controlConflict();
    }
    return control;
  } catch (error) {
    if (error instanceof HrTimesheetError) throw error;
    throw controlConflict();
  }
}
function exactCapabilities(
  manifest: TimesheetDependencyManifest,
  prefix: string,
  required: readonly string[],
): boolean {
  const actual = manifest.capabilities
    .filter(({ id }) => id.startsWith(prefix))
    .map(({ exposure, id }) => `${exposure}:${id}`)
    .sort();
  return (
    actual.length === required.length && actual.every((value, index) => value === required[index])
  );
}
async function dependencyCatalogCurrent(transaction: TenantTransaction): Promise<boolean> {
  const result = await transaction.client.query<{ current: boolean }>(
    `WITH workspace AS (
       SELECT relation.oid FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='public' AND relation.relname='workspace_tasks' AND relation.relkind='r'
         AND relation.relpersistence='p' AND relation.relrowsecurity AND relation.relforcerowsecurity
     ), evidence AS (
       SELECT relation.oid,relation.relowner FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='public' AND relation.relname='evidence_events'
     ) SELECT (SELECT count(*)=1 FROM workspace)
       AND (SELECT count(*)=1 FROM pg_catalog.pg_policy policy,workspace WHERE policy.polrelid=workspace.oid)
       AND (SELECT count(*)=1 FROM pg_catalog.pg_policy policy,workspace WHERE policy.polrelid=workspace.oid
         AND policy.polname='workspace_tasks_tenant_isolation' AND policy.polcmd='*' AND policy.polpermissive AND policy.polroles=ARRAY[0::oid]
         AND replace(pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),'public.','')='(tenant_id = esbla_current_tenant_id())'
         AND replace(pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid),'public.','')='(tenant_id = esbla_current_tenant_id())')
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_index record JOIN pg_catalog.pg_class index ON index.oid=record.indexrelid,workspace
         WHERE record.indrelid=workspace.oid AND index.relname='workspace_tasks_assignee_open_idx' AND record.indisvalid AND record.indisready AND record.indislive
         AND replace(pg_catalog.pg_get_indexdef(index.oid),'::public.','::')='CREATE INDEX workspace_tasks_assignee_open_idx ON public.workspace_tasks USING btree (tenant_id, assignee_principal_id, due_on, created_at, task_id) WHERE (status = ''open''::workspace_task_status)')
       AND (SELECT count(*)=2 FROM pg_catalog.pg_trigger trigger JOIN pg_catalog.pg_proc function ON function.oid=trigger.tgfoid,workspace
         WHERE trigger.tgrelid=workspace.oid AND NOT trigger.tgisinternal AND trigger.tgenabled='O' AND function.proname='esbla_enforce_workspace_task_state'
         AND NOT function.prosecdef AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc,'UTF8')),'hex')='645b379ea313d15e68b2d141dc330a38760fce8db84f19b7dbbf0e6a4b97c5b2'
         AND ((trigger.tgname='workspace_tasks_enforce_state' AND trigger.tgtype=31) OR (trigger.tgname='workspace_tasks_reject_truncate' AND trigger.tgtype=34)))
       AND (SELECT count(*)=2 FROM pg_catalog.pg_trigger trigger,workspace WHERE trigger.tgrelid=workspace.oid AND NOT trigger.tgisinternal)
       AND EXISTS (SELECT 1 FROM evidence JOIN pg_catalog.pg_trigger trigger ON trigger.tgrelid=evidence.oid JOIN pg_catalog.pg_proc function ON function.oid=trigger.tgfoid
         WHERE trigger.tgname='evidence_events_protect_hr_timesheet_retention' AND NOT trigger.tgisinternal AND trigger.tgenabled='O' AND trigger.tgtype=7
         AND function.proname='esbla_protect_hr_timesheet_retention_evidence' AND function.proowner=evidence.relowner AND NOT function.prosecdef
         AND function.proconfig=ARRAY['search_path=pg_catalog'] AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc,'UTF8')),'hex')='b7e37e9bb0e6ee2e7e9f724483795f4468a62af1baf99daf88697ca6f7140c6a'
         AND SESSION_USER<>pg_catalog.pg_get_userbyid(evidence.relowner) AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(COALESCE(function.proacl,pg_catalog.acldefault('f',function.proowner))) privilege
           WHERE privilege.privilege_type='EXECUTE' AND privilege.grantee<>function.proowner))
       AND (SELECT count(*)=2 FROM evidence JOIN pg_catalog.pg_trigger trigger ON trigger.tgrelid=evidence.oid JOIN pg_catalog.pg_proc function ON function.oid=trigger.tgfoid
         WHERE NOT trigger.tgisinternal AND trigger.tgenabled='O' AND function.proname='esbla_reject_evidence_mutation' AND function.proowner=evidence.relowner AND NOT function.prosecdef AND function.proconfig IS NULL
         AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc,'UTF8')),'hex')='30fa45fd4e7b290856e6776f2ca0e376335461622705a01f8b19b30683cdf53b'
         AND ((trigger.tgname='evidence_events_reject_update_delete' AND trigger.tgtype=27) OR (trigger.tgname='evidence_events_reject_truncate' AND trigger.tgtype=34)))
       AND (SELECT count(*)=3 FROM evidence JOIN pg_catalog.pg_trigger trigger ON trigger.tgrelid=evidence.oid WHERE NOT trigger.tgisinternal) AS current`,
  );
  return result.rows[0]?.current === true;
}
async function semanticReadiness(
  transaction: TenantTransaction,
  mode: HrTimesheetActivationMode,
  workspaceManifest: TimesheetDependencyManifest,
): Promise<ActivationPreflight> {
  const reasons: string[] = [];
  const hrSnapshot = hrManifest as TimesheetDependencyManifest;
  const coreSnapshot = platformCoreManifest as TimesheetDependencyManifest;
  if (
    !exactCapabilities(hrSnapshot, "hr.timesheet.", [...REQUIRED_TIMESHEET_CAPABILITIES].sort())
  ) {
    reasons.push("service_not_eligible");
  }
  if (
    !exactCapabilities(hrSnapshot, "hr.workforce.", [...REQUIRED_WORKFORCE_CAPABILITIES].sort()) ||
    coreSnapshot.id !== "platform_core" ||
    coreSnapshot.activation !== "required" ||
    coreSnapshot.dependencies.length !== 0 ||
    !exactCapabilities(coreSnapshot, "platform.", [...REQUIRED_CORE_CAPABILITIES].sort()) ||
    !hrSnapshot.dependencies.includes("platform_core") ||
    workspaceManifest.id !== "workspace" ||
    workspaceManifest.activation !== "inactive_by_default" ||
    workspaceManifest.dependencies.length !== 1 ||
    workspaceManifest.dependencies[0] !== "platform_core" ||
    !(await dependencyCatalogCurrent(transaction)) ||
    !exactCapabilities(
      workspaceManifest,
      "workspace.task.",
      [...REQUIRED_WORKSPACE_CAPABILITIES].sort(),
    )
  ) {
    reasons.push("non_soft_dependency_not_eligible");
  }
  if (mode === "production") {
    const retention = await transaction.client.query<{ current: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM evidence_events
         WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3
           AND event_type=$4 AND prior_state IS NULL AND new_state='qualified'
       ) AS current`,
      [transaction.context.tenantId, RETENTION_SUBJECT, RETENTION_SUBJECT_ID, RETENTION_EVENT],
    );
    if (retention.rows[0]?.current !== true) {
      reasons.push("qualified_retention_evidence_unavailable");
    }
  }
  return { current: reasons.length === 0, reasons };
}
async function authorizeAdmin(
  transaction: TenantTransaction,
  action: ControlAction,
): Promise<PolicyDecision> {
  const actionKey = `hr.timesheet.${action}`;
  const manifestCurrent = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "admin" && id === actionKey,
  );
  const capability = await transaction.client.query<{ current: boolean }>(
    "SELECT public.esbla_hr_timesheet_service_admin_current($1) AS current",
    [actionKey],
  );
  const input = { capabilityCurrent: manifestCurrent && capability.rows[0]?.current === true };
  const rules = [
    {
      effect: "allow" as const,
      id: `current_tenant_admin_${action}_timesheet`,
      matches: (_input: typeof input, actor: { roleKey: string }) =>
        actor.roleKey === "tenant_admin" && input.capabilityCurrent,
    },
  ];
  const decision = evaluatePolicy(
    { actionKey, input, resourceKey: HR_TIMESHEET_SERVICE_KEY, transaction },
    rules,
  );
  assertPolicyAllowed(decision, transaction, actionKey, HR_TIMESHEET_SERVICE_KEY);
  if (action === "configure_service" || action === "view_service_control") return decision;
  const platformAction = `platform.service_activation.${
    action === "activate_service" ? "activate" : "deactivate"
  }`;
  const platformDecision = evaluatePolicy(
    { actionKey: platformAction, input, resourceKey: HR_TIMESHEET_SERVICE_KEY, transaction },
    rules,
  );
  assertPolicyAllowed(platformDecision, transaction, platformAction, HR_TIMESHEET_SERVICE_KEY);
  return platformDecision;
}
const TIMESHEET_ACTION_ROLES: Readonly<Record<HrTimesheetAuthorizedAction, readonly string[]>> =
  Object.freeze({
    activate_service: Object.freeze(["tenant_admin"]),
    approve: Object.freeze(["manager"]),
    configure_service: Object.freeze(["tenant_admin"]),
    create: Object.freeze(["employee"]),
    create_correction: Object.freeze(["hr_operator"]),
    deactivate_service: Object.freeze(["tenant_admin"]),
    edit_draft: Object.freeze(["employee"]),
    list_assigned: Object.freeze(["manager"]),
    list_own: Object.freeze(["employee"]),
    reject: Object.freeze(["manager"]),
    submit: Object.freeze(["employee"]),
    view_detail: Object.freeze(["employee", "hr_operator", "manager"]),
    view_service_control: Object.freeze(["tenant_admin"]),
  });

/**
 * Projects current role and capability state for advisory rendering only. Every action still
 * performs its own transactional policy and object-authority checks.
 */
export async function inspectTimesheetActionAuthority(
  pool: Pool,
  context: OperationContext,
): Promise<readonly HrTimesheetAuthorizedAction[]> {
  return await withTenantTransaction(pool, context, async (transaction) => {
    const capabilityIds = HR_TIMESHEET_AUTHORIZED_ACTIONS.map((action) => `hr.timesheet.${action}`);
    const result = await transaction.client.query<{ capability_id: string }>(
      `SELECT capability_id FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=ANY($3::text[])
       ORDER BY capability_id`,
      [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityIds],
    );
    const current = new Set(result.rows.map(({ capability_id }) => capability_id));
    return Object.freeze(
      HR_TIMESHEET_AUTHORIZED_ACTIONS.filter((action) => {
        const capabilityId = `hr.timesheet.${action}`;
        return (
          TIMESHEET_ACTION_ROLES[action].includes(transaction.actor.roleKey) &&
          current.has(capabilityId) &&
          hrManifest.capabilities.some(({ id }) => id === capabilityId)
        );
      }),
    );
  });
}

export async function inspectTimesheetServiceControlAuthority(
  pool: Pool,
  context: OperationContext,
): Promise<readonly ControlAction[]> {
  const actions = await inspectTimesheetActionAuthority(pool, context);
  return Object.freeze(CONTROL_ACTIONS.filter((action) => actions.includes(action)));
}
async function requireActiveDependencies(transaction: TenantTransaction): Promise<void> {
  const result = await transaction.client
    .query<{ service_key: string; state: string }>(
      `SELECT service_key,state FROM service_activations
       WHERE tenant_id=$1 AND service_key=ANY($2::text[])
       ORDER BY service_key FOR SHARE NOWAIT`,
      [transaction.context.tenantId, ["workforce_profile", "workspace.task"]],
    )
    .catch((error: unknown) => {
      if (postgresCode(error, "55P03")) throw versionConflict();
      throw error;
    });
  if (
    result.rows.length !== 2 ||
    result.rows.some(({ state }) => state !== "active") ||
    result.rows.map(({ service_key }) => service_key).join(",") !==
      "workforce_profile,workspace.task"
  ) {
    throw new HrTimesheetError("TIMESHEET_DEPENDENCY_INACTIVE", "Timesheet dependency is inactive");
  }
}
function settingsFromRows(rows: readonly ControlRow[], version: number): HrTimesheetSettings {
  const selected = rows.filter((row) => row.setting_key !== null);
  if (version === 1) {
    if (rows.length !== 1 || selected.length !== 0) throw controlConflict();
    return { ...hrTimesheetSettingsDefaults };
  }
  const byKey = new Map(selected.map((row) => [String(row.setting_key), row]));
  const maxDaily = byKey.get(MAX_DAILY_MINUTES_KEY);
  const cadence = byKey.get(PERIOD_CADENCE_KEY);
  const rejection = byKey.get(REJECTION_NOTE_REQUIRED_KEY);
  if (
    rows.length !== 3 ||
    maxDaily?.setting_value_type !== "integer" ||
    !Number.isSafeInteger(maxDaily.setting_value) ||
    (maxDaily.setting_value as number) < 1 ||
    (maxDaily.setting_value as number) > 1440 ||
    maxDaily.setting_version !== version - 1 ||
    cadence?.setting_value_type !== "enum" ||
    cadence.setting_value !== "weekly" ||
    cadence.setting_version !== version - 1 ||
    rejection?.setting_value_type !== "boolean" ||
    typeof rejection.setting_value !== "boolean" ||
    rejection.setting_version !== version - 1
  ) {
    throw controlConflict("Timesheet settings are not current");
  }
  return {
    maxDailyMinutes: maxDaily.setting_value as number,
    periodCadence: "weekly",
    rejectionNoteRequired: rejection.setting_value,
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
     FROM hr_timesheet_service_control control
     JOIN service_activations activation
       ON activation.tenant_id=control.tenant_id AND activation.service_key=control.service_key
     LEFT JOIN tenant_settings setting
       ON setting.tenant_id=control.tenant_id
      AND setting.setting_key=ANY($2::text[])
     WHERE control.tenant_id=$1 AND control.service_key='timesheet'
     ORDER BY setting.setting_key LIMIT 4`,
    [
      transaction.context.tenantId,
      [MAX_DAILY_MINUTES_KEY, PERIOD_CADENCE_KEY, REJECTION_NOTE_REQUIRED_KEY],
    ],
  );
  const row = result.rows[0];
  if (!row) {
    if (activation) throw controlConflict();
    return null;
  }
  if (
    !activation ||
    activation.serviceKey !== HR_TIMESHEET_SERVICE_KEY ||
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
    serviceKey: HR_TIMESHEET_SERVICE_KEY,
    settings: settingsFromRows(result.rows, row.settings_version),
    settingsVersion: row.settings_version,
    updatedAt: timestamp(row.updated_at),
    version: row.row_version,
  });
  return { control, serviceControlId: row.service_control_id };
}
function result(control: HrServiceControl, replayed: boolean): TimesheetServiceControlResult {
  return { billingState: HR_TIMESHEET_BILLING_STATE, control, replayed };
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
  const eventType = `hr.timesheet.${action}`;
  const proof = await transaction.client.query<{
    aggregate_version: number;
    correlation_id: string;
    new_state: string;
    payload: unknown;
    prior_state: string | null;
  }>(
    `SELECT outbox.aggregate_version,outbox.payload,evidence.correlation_id,
            evidence.prior_state,evidence.new_state
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
      transaction.context.correlationId,
      transaction.context.actorPrincipalId,
      id,
    ],
  );
  if (proof.rows.length === 0) return null;
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
      "controlSha256",
      "payloadVersion",
      "receiptId",
      "semantics",
    ]) ||
    payload.action !== action ||
    payload.receiptId !== id ||
    payload.afterVersion !== row.aggregate_version ||
    payload.beforeVersion !== (row.aggregate_version === 1 ? null : row.aggregate_version - 1) ||
    payload.billingState !== HR_TIMESHEET_BILLING_STATE ||
    payload.payloadVersion !== 1 ||
    payload.semantics !== semantics ||
    row.correlation_id !== transaction.context.correlationId
  ) {
    throw idempotencyConflict();
  }
  const control = validateControl(payload.control);
  const transitionCurrent =
    action === "configure_service"
      ? row.prior_state === String(control.settingsVersion - 1) &&
        row.new_state === String(control.settingsVersion)
      : row.prior_state ===
          (action === "activate_service"
            ? control.activationVersion === 1
              ? "absent"
              : "inactive"
            : "active") &&
        row.new_state === (action === "activate_service" ? "active" : "inactive") &&
        control.activationState === row.new_state;
  if (
    control.version !== row.aggregate_version ||
    !transitionCurrent ||
    payload.controlSha256 !== sha256(control)
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
  const eventType = `hr.timesheet.${action}`;
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
        billingState: HR_TIMESHEET_BILLING_STATE,
        control: snapshot.control,
        controlSha256: sha256(snapshot.control),
        payloadVersion: 1,
        receiptId: id,
        semantics,
      },
    },
  });
}
async function lifecycle(
  transaction: TenantTransaction,
  input: TimesheetServiceLifecycleInput,
  action: "activate_service" | "deactivate_service",
  preflight?: () => Promise<ActivationPreflight>,
): Promise<TimesheetServiceControlResult> {
  const authorization = await authorizeAdmin(transaction, action);
  if (action === "deactivate_service" && transaction.lockedServiceActivation?.state !== "active") {
    const replay = await readReplay(transaction, action, action);
    if (replay) return result(replay, true);
    throw serviceInactive();
  }
  const priorState = transaction.lockedServiceActivation?.state ?? "absent";
  const targetState = action === "activate_service" ? "active" : "inactive";
  const activation = await setServiceActivation(transaction, {
    authorization,
    evidenceEventType: `evidence.hr.timesheet.service.${targetState}`,
    expectedVersion: input.expectedVersion,
    outboxEventType: INTERNAL_ACTIVATION_EVENT,
    ...(preflight ? { preflight } : {}),
    serviceKey: HR_TIMESHEET_SERVICE_KEY,
    targetState,
  });
  if (activation.replayed) {
    const replay = await readReplay(transaction, action, action);
    if (!replay) throw idempotencyConflict();
    return result(replay, true);
  }
  const snapshot = await readControl(transaction, activation);
  if (!snapshot) throw controlConflict("Timesheet service control is missing");
  await recordResult(transaction, action, action, snapshot, priorState, targetState);
  return result(snapshot.control, false);
}

async function probeActivationReplay(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: TimesheetServiceLifecycleInput,
): Promise<TimesheetServiceControlResult | null> {
  const preflightRequired = new Error("Timesheet activation readiness phase is required");
  try {
    return await withTenantTransaction(
      runtimePool,
      context,
      async (transaction) =>
        await lifecycle(transaction, input, "activate_service", async () => {
          if (runtimePool === migrationReadPool) {
            return { current: false, reasons: ["migration_reader_not_isolated"] };
          }
          throw preflightRequired;
        }),
      {
        migrationBarrier: "shared",
        serviceActivationKey: HR_TIMESHEET_SERVICE_KEY,
        serviceActivationLock: "update",
      },
    );
  } catch (error) {
    if (error === preflightRequired) return null;
    throw error;
  }
}

export async function activateTimesheetService(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: TimesheetServiceLifecycleInput,
  mode: HrTimesheetActivationMode,
  workspaceManifest: TimesheetDependencyManifest,
): Promise<TimesheetServiceControlResult> {
  if (input.expectedVersion !== null) assertVersion(input.expectedVersion, "expectedVersion");
  if (mode !== "non_production" && mode !== "production") {
    throw inputInvalid("Timesheet activation mode is invalid");
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
        await lifecycle(transaction, input, "activate_service", async () => {
          await requireActiveDependencies(transaction);
          const client = migrationClient;
          if (!client) return { current: false, reasons: ["migration_ledger_unavailable"] };
          migrationClient = null;
          return await inspectActivationReadiness(transaction, client, {
            catalog: HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS,
            migrations: TIMESHEET_REQUIRED_MIGRATIONS,
            runtimeTablePrivileges: [
              {
                delete: false,
                insert: true,
                name: "public.evidence_events",
                references: false,
                select: true,
                trigger: false,
                truncate: false,
                update: false,
              },
            ],
            semantic: await semanticReadiness(transaction, mode, workspaceManifest),
          });
        }),
      {
        migrationBarrier: "shared",
        serviceActivationKey: HR_TIMESHEET_SERVICE_KEY,
        serviceActivationLock: "update",
      },
    );
  } finally {
    migrationClient?.release();
  }
}
export async function deactivateTimesheetService(
  pool: Pool,
  context: OperationContext,
  input: TimesheetServiceLifecycleInput & { readonly expectedVersion: number },
): Promise<TimesheetServiceControlResult> {
  assertVersion(input.expectedVersion, "expectedVersion");
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => await lifecycle(transaction, input, "deactivate_service"),
    { serviceActivationKey: HR_TIMESHEET_SERVICE_KEY, serviceActivationLock: "update" },
  );
}

export async function getTimesheetServiceControl(
  pool: Pool,
  context: OperationContext,
): Promise<TimesheetServiceControlResult> {
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
        throw new HrTimesheetError(
          "TIMESHEET_SERVICE_CONTROL_NOT_FOUND",
          "Timesheet service control was not found",
        );
      }
      return result(snapshot.control, false);
    },
    { serviceActivationKey: HR_TIMESHEET_SERVICE_KEY, serviceActivationLock: "share" },
  );
}

function translateConfigureError(error: unknown): never {
  if (error instanceof HrTimesheetError || error instanceof PlatformError) throw error;
  if (postgresCode(error, "22003", "22023")) {
    throw inputInvalid("Timesheet settings input is invalid");
  }
  if (postgresCode(error, "42501")) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
  }
  if (postgresCode(error, "40001", "40P01", "55P03")) throw versionConflict();
  if (postgresCode(error, "55000")) throw controlConflict();
  throw error;
}

export async function configureTimesheetService(
  pool: Pool,
  context: OperationContext,
  input: HrServiceConfigureBody,
): Promise<TimesheetServiceControlResult> {
  assertVersion(input.expectedSettingsVersion, "expectedSettingsVersion");
  const settings = normalizeSettings(input.settings);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await authorizeAdmin(transaction, "configure_service");
      const id = receiptId(transaction, "configure_service");
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [id],
      );
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
        [`hr.timesheet.settings.v1:${transaction.context.tenantId}`],
      );
      const semantics = sha256({
        expectedSettingsVersion: input.expectedSettingsVersion,
        settings,
      });
      const replay = await readReplay(transaction, "configure_service", semantics);
      if (replay) return result(replay, true);
      if (transaction.lockedServiceActivation?.state !== "active") throw serviceInactive();
      try {
        await transaction.client.query(
          "SELECT public.esbla_configure_hr_timesheet_settings($1,$2,$3,$4)",
          [
            input.expectedSettingsVersion,
            settings.maxDailyMinutes,
            settings.periodCadence,
            settings.rejectionNoteRequired,
          ],
        );
      } catch (error) {
        translateConfigureError(error);
      }
      const activation = transaction.lockedServiceActivation
        ? { ...transaction.lockedServiceActivation, replayed: false }
        : null;
      const snapshot = await readControl(transaction, activation);
      if (!snapshot) throw controlConflict("Timesheet service control is missing");
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
    { serviceActivationKey: HR_TIMESHEET_SERVICE_KEY, serviceActivationLock: "share" },
  );
}
