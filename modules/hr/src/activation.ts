import {
  type ActivationPreflight,
  assertPolicyAllowed,
  evaluatePolicy,
  type OperationContext,
  type PolicyDecision,
  type ServiceActivationResult,
  type SetServiceActivationInput,
  setServiceActivation,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { HR_LEAVE_BILLING_STATE, HR_LEAVE_SERVICE_KEY } from "./types.js";
export interface HrLeaveServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export interface HrLeaveServiceLifecycleResult extends ServiceActivationResult {
  readonly billingState: typeof HR_LEAVE_BILLING_STATE;
}
interface DatabaseIdentity {
  readonly database_name: string;
  readonly database_oid: string;
  readonly in_recovery: boolean;
  readonly postmaster_started_at: string;
  readonly system_identifier: string;
}
interface MigrationCheck {
  readonly id: string;
  readonly matching_count: number;
  readonly total_count: number;
}
interface CatalogCheck {
  readonly current: boolean;
}
const INTERNAL_ACTIVATION_OUTBOX_EVENT_TYPE = "internal.platform.service_activation.changed";
const REQUIRED_MIGRATIONS = [
  {
    createdAt: 1783638680530,
    hash: "6f86a6c35887bfc5977b3a6dd9637e8cd0b04f12d37bb8cab507a11976cbdf8e",
    id: "0000",
  },
  {
    createdAt: 1783638694169,
    hash: "1f2899c1bec70c438c6e009c1924d35a3cef7bdf5001899090de4d12ea6d424b",
    id: "0001",
  },
  {
    createdAt: 1783641088151,
    hash: "a45fc3118e84d06d64eebf1e52d688812bf83c8122d5f688df8e54c13320ea79",
    id: "0002",
  },
  {
    createdAt: 1783642209842,
    hash: "c5aa04bb6f8b75ac7dd878bd809042cf0bbc9465a9bf67a816637164fd140acf",
    id: "0003",
  },
  {
    createdAt: 1784276307910,
    hash: "9e360ba35e62b22ddb9b993a9af007ecec92777c4623e805c439fceeee17197f",
    id: "0005",
  },
] as const;
const CATALOG_REQUIREMENTS = {
  tables: (
    "tenants,principals,memberships,service_activations,tenant_settings," +
    "work_items,evidence_events,outbox_events,hr_leave_requests"
  )
    .split(",")
    .map((name) => ({ name })),
  columns: [
    "memberships|status|text|1|'active'::text",
    "evidence_events|subject_type|text|1|",
    "evidence_events|correlation_id|uuid|1|",
    "outbox_events|aggregate_type|text|1|",
    "outbox_events|correlation_id|uuid|1|",
    "work_items|work_type|text|1|",
    "work_items|subject_type|text|1|",
    "hr_leave_requests|decision_note|text|0|",
    "hr_leave_requests|version|integer|1|1",
  ].map((row) => {
    const [parent, name, type, notNull, defaultExpression] = row.split("|");
    return { defaultExpression, name, notNull: notNull === "1", parent, type };
  }),
  indexes: [
    "memberships_tenant_principal_uq|memberships|tenant_id, principal_id||u",
    "service_activations_pk|service_activations|tenant_id, service_key||p",
    "work_items_tenant_work_subject_uq|work_items|tenant_id, work_type, subject_type, subject_id||u",
    "work_items_tenant_assignee_status_created_idx|work_items|tenant_id, assignee_principal_id, status, created_at||",
    "evidence_events_idempotency_uq|evidence_events|tenant_id, subject_type, subject_id, event_type, correlation_id||u",
    "evidence_events_tenant_subject_occurred_idx|evidence_events|tenant_id, subject_type, subject_id, occurred_at, evidence_event_id||",
    "outbox_events_idempotency_uq|outbox_events|tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version||u",
    "hr_leave_requests_tenant_employee_idempotency_uq|hr_leave_requests|tenant_id, employee_principal_id, idempotency_key||u",
    "hr_leave_requests_assigned_open_idx|hr_leave_requests|tenant_id, approver_principal_id, submitted_at, leave_request_id|(status = 'submitted'::public.hr_leave_request_status)|",
    "hr_leave_requests_employee_history_idx|hr_leave_requests|tenant_id, employee_principal_id, submitted_at DESC NULLS LAST, leave_request_id DESC NULLS LAST||",
  ].map((row) => {
    const [name, parent, columns, predicate, constraintType] = row.split("|");
    const unique = constraintType !== "";
    return {
      constraintType,
      definition: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON public.${parent} USING btree (${columns})${predicate ? ` WHERE ${predicate}` : ""}`,
      name,
      parent,
      predicate,
      primary: constraintType === "p",
      unique,
    };
  }),
  policies: [
    "memberships|memberships_tenant_isolation",
    "service_activations|service_activations_tenant_isolation",
    "tenant_settings|tenant_settings_tenant_isolation",
    "work_items|work_items_tenant_isolation",
    "evidence_events|evidence_events_tenant_isolation",
    "outbox_events|outbox_events_tenant_isolation",
    "hr_leave_requests|hr_leave_requests_tenant_isolation",
  ].map((row) => {
    const [parent, name] = row.split("|");
    return { name, parent };
  }),
  triggers: [
    "evidence_events|evidence_events_reject_update_delete|BEFORE DELETE OR UPDATE|ROW|esbla_reject_evidence_mutation",
    "evidence_events|evidence_events_reject_truncate|BEFORE TRUNCATE|STATEMENT|esbla_reject_evidence_mutation",
    "hr_leave_requests|hr_leave_requests_enforce_state|BEFORE INSERT OR DELETE OR UPDATE|ROW|esbla_enforce_hr_leave_state",
    "hr_leave_requests|hr_leave_requests_reject_truncate|BEFORE TRUNCATE|STATEMENT|esbla_enforce_hr_leave_state",
  ].map((row) => {
    const [parent, name, action, level, functionName] = row.split("|");
    return {
      definition: `CREATE TRIGGER ${name} ${action} ON public.${parent} FOR EACH ${level} EXECUTE FUNCTION public.${functionName}()`,
      functionName,
      name,
      parent,
    };
  }),
  constraints: [
    "memberships|memberships_status_valid|c|CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text]))",
    "work_items|work_items_tenant_work_subject_uq|u|UNIQUE (tenant_id, work_type, subject_type, subject_id)",
    "evidence_events|evidence_events_idempotency_uq|u|UNIQUE (tenant_id, subject_type, subject_id, event_type, correlation_id)",
    "outbox_events|outbox_events_idempotency_uq|u|UNIQUE (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version)",
    "hr_leave_requests|hr_leave_requests_tenant_employee_idempotency_uq|u|UNIQUE (tenant_id, employee_principal_id, idempotency_key)",
    "hr_leave_requests|hr_leave_requests_decision_consistent|c|CHECK (status = 'submitted'::public.hr_leave_request_status AND decided_at IS NULL AND decision_note IS NULL OR (status = ANY (ARRAY['approved'::public.hr_leave_request_status, 'rejected'::public.hr_leave_request_status])) AND decided_at IS NOT NULL)",
  ].map((row) => {
    const [parent, name, type, definition] = row.split("|");
    return { definition, name, parent, type };
  }),
  functions: [
    "esbla_current_tenant_id|sql|uuid|s|search_path=pg_catalog|72cc22b496ef68e600155e2487691eaa80d6c1f94207242933f1b7cdcb4e4c89",
    "esbla_reject_evidence_mutation|plpgsql|trigger|v||30fa45fd4e7b290856e6776f2ca0e376335461622705a01f8b19b30683cdf53b",
    "esbla_enforce_hr_leave_state|plpgsql|trigger|v||a383d1d6ec766115a6a4742b2fd4ee92c07e42dc9fe5a95d2adabafa5a504e7f",
  ].map((row) => {
    const [name, language, returnType, volatility, config, sourceSha256] = row.split("|");
    return { config, language, name, returnType, sourceSha256, volatility };
  }),
};
async function readDatabaseIdentity(client: PoolClient): Promise<DatabaseIdentity | null> {
  const permission = await client.query<{ allowed: boolean }>(
    "SELECT pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_control_system()', 'EXECUTE') AS allowed",
  );
  if (permission.rows[0]?.allowed !== true) return null;
  const identity = await client.query<DatabaseIdentity>(
    `SELECT control.system_identifier::text AS system_identifier,
            pg_catalog.current_database() AS database_name,
            database.oid::text AS database_oid,
            pg_catalog.pg_is_in_recovery() AS in_recovery,
            EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time())::text
              AS postmaster_started_at
     FROM pg_catalog.pg_control_system() control
     JOIN pg_catalog.pg_database database
       ON database.datname = pg_catalog.current_database()`,
  );
  return identity.rows[0] ?? null;
}
function sameDatabase(left: DatabaseIdentity, right: DatabaseIdentity): boolean {
  return (
    left.system_identifier === right.system_identifier &&
    left.database_name === right.database_name &&
    left.database_oid === right.database_oid &&
    left.postmaster_started_at === right.postmaster_started_at
  );
}
async function inspectActivationReadiness(
  transaction: TenantTransaction,
  migrationClient: PoolClient,
): Promise<ActivationPreflight> {
  let discardClient = false;
  let failureReason = "migration_ledger_unavailable";
  try {
    await migrationClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await migrationClient.query("SET LOCAL search_path TO pg_catalog");

    failureReason = "database_identity_unavailable";
    const runtimeIdentity = await readDatabaseIdentity(transaction.client);
    const migrationIdentity = await readDatabaseIdentity(migrationClient);
    if (!runtimeIdentity || !migrationIdentity) {
      await migrationClient.query("COMMIT");
      return { current: false, reasons: [failureReason] };
    }
    if (!sameDatabase(runtimeIdentity, migrationIdentity)) {
      await migrationClient.query("COMMIT");
      return { current: false, reasons: ["database_identity_mismatch"] };
    }
    if (runtimeIdentity.in_recovery || migrationIdentity.in_recovery) {
      await migrationClient.query("COMMIT");
      return { current: false, reasons: ["database_not_writable"] };
    }

    failureReason = "migration_ledger_unavailable";
    const migrations = await migrationClient.query<MigrationCheck>(
      `WITH required AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS item(id text, created_at bigint, hash text)
       )
       SELECT required.id,
              count(applied.id)::integer AS total_count,
              count(applied.id) FILTER (WHERE applied.hash = required.hash)::integer
                AS matching_count
       FROM required
       LEFT JOIN drizzle.__drizzle_migrations applied
         ON applied.created_at = required.created_at
       GROUP BY required.id
       ORDER BY required.id`,
      [
        JSON.stringify(
          REQUIRED_MIGRATIONS.map(({ createdAt, hash, id }) => ({
            created_at: createdAt,
            hash,
            id,
          })),
        ),
      ],
    );
    const migrationById = new Map(migrations.rows.map((row) => [row.id, row]));
    const migrationReasons = REQUIRED_MIGRATIONS.flatMap(({ id }) => {
      const row = migrationById.get(id);
      return row?.total_count === 1 && row.matching_count === 1
        ? []
        : [`migration_${id}_not_current`];
    });
    if (migrationReasons.length > 0) {
      await migrationClient.query("COMMIT");
      return { current: false, reasons: migrationReasons };
    }

    failureReason = "schema_dependencies_not_current";
    const catalog = await migrationClient.query<CatalogCheck>(
      `WITH requirements AS (
         SELECT $1::jsonb AS value
       ), checks AS (
         SELECT COALESCE(actual.current, false) AS current
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'tables') AS required(name text)
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
           WHERE namespace.nspname = 'public' AND relation.relname = required.name
             AND relation.relkind = 'r' AND relation.relpersistence = 'p'
             AND NOT relation.relispartition
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'columns') AS required(
                name text, parent text, type text, "notNull" boolean,
                "defaultExpression" text
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
           LEFT JOIN pg_catalog.pg_attrdef default_record
             ON default_record.adrelid = relation.oid
            AND default_record.adnum = attribute.attnum
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND relation.relkind = 'r' AND relation.relpersistence = 'p'
             AND attribute.attname = required.name AND attribute.attnum > 0
             AND NOT attribute.attisdropped
             AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = required.type
             AND attribute.attnotnull = required."notNull"
             AND attribute.attidentity = '' AND attribute.attgenerated = ''
             AND COALESCE(
               pg_catalog.pg_get_expr(default_record.adbin, default_record.adrelid), ''
             ) = required."defaultExpression"
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'indexes') AS required(
                name text, parent text, definition text, predicate text,
                "constraintType" text, "primary" boolean, "unique" boolean
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace index_namespace
           JOIN pg_catalog.pg_class index_relation
             ON index_relation.relnamespace = index_namespace.oid
           JOIN pg_catalog.pg_index index_record
             ON index_record.indexrelid = index_relation.oid
           JOIN pg_catalog.pg_class parent_relation
             ON parent_relation.oid = index_record.indrelid
           JOIN pg_catalog.pg_namespace parent_namespace
             ON parent_namespace.oid = parent_relation.relnamespace
           WHERE index_namespace.nspname = 'public'
             AND index_relation.relname = required.name AND index_relation.relkind = 'i'
             AND parent_namespace.nspname = 'public'
             AND parent_relation.relname = required.parent AND parent_relation.relkind = 'r'
             AND index_record.indisunique = required."unique"
             AND index_record.indisprimary = required."primary"
             AND index_record.indisvalid AND index_record.indisready AND index_record.indislive
             AND index_record.indimmediate AND NOT index_record.indisexclusion
             AND pg_catalog.pg_get_indexdef(index_relation.oid) = required.definition
             AND COALESCE(
               pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid), ''
             ) = required.predicate
             AND CASE WHEN required."constraintType" = '' THEN NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_constraint constraint_record
               WHERE constraint_record.conindid = index_relation.oid
             ) ELSE EXISTS (
               SELECT 1 FROM pg_catalog.pg_constraint constraint_record
               WHERE constraint_record.conindid = index_relation.oid
                 AND constraint_record.conrelid = parent_relation.oid
                 AND constraint_record.conname = required.name
                 AND constraint_record.contype::text = required."constraintType"
                 AND constraint_record.convalidated
                 AND NOT constraint_record.condeferrable
                 AND NOT constraint_record.condeferred
             ) END
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'policies')
                AS required(name text, parent text)
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_catalog.pg_policy policy ON policy.polrelid = relation.oid
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND relation.relkind = 'r' AND relation.relrowsecurity
             AND relation.relforcerowsecurity AND policy.polname = required.name
             AND policy.polcmd = '*' AND policy.polpermissive
             AND policy.polroles = ARRAY[0::oid]
             AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) =
               '(tenant_id = public.esbla_current_tenant_id())'
             AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) =
               '(tenant_id = public.esbla_current_tenant_id())'
             AND NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_policy other_policy
               WHERE other_policy.polrelid = relation.oid AND other_policy.polpermissive
                 AND other_policy.polname <> required.name
             )
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'triggers') AS required(
                name text, parent text, definition text, "functionName" text
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_catalog.pg_trigger trigger_record ON trigger_record.tgrelid = relation.oid
           JOIN pg_catalog.pg_proc procedure ON procedure.oid = trigger_record.tgfoid
           JOIN pg_catalog.pg_namespace procedure_namespace
             ON procedure_namespace.oid = procedure.pronamespace
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND relation.relkind = 'r' AND trigger_record.tgname = required.name
             AND NOT trigger_record.tgisinternal AND trigger_record.tgenabled = 'O'
             AND procedure_namespace.nspname = 'public'
             AND procedure.proname = required."functionName" AND procedure.pronargs = 0
             AND pg_catalog.pg_get_triggerdef(trigger_record.oid, true) = required.definition
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'constraints') AS required(
                name text, parent text, definition text, type text
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_catalog.pg_constraint constraint_record
             ON constraint_record.conrelid = relation.oid
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND relation.relkind = 'r' AND constraint_record.conname = required.name
             AND constraint_record.contype::text = required.type
             AND constraint_record.convalidated AND NOT constraint_record.condeferrable
             AND NOT constraint_record.condeferred
             AND pg_catalog.pg_get_constraintdef(constraint_record.oid, true) = required.definition
             AND CASE WHEN required.type IN ('p', 'u') THEN EXISTS (
               SELECT 1
               FROM pg_catalog.pg_class index_relation
               JOIN pg_catalog.pg_namespace index_namespace
                 ON index_namespace.oid = index_relation.relnamespace
               WHERE index_relation.oid = constraint_record.conindid
                 AND index_namespace.nspname = 'public'
                 AND index_relation.relname = required.name AND index_relation.relkind = 'i'
             ) ELSE constraint_record.conindid = 0 END
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'functions') AS required(
                name text, language text, "returnType" text, "sourceSha256" text,
                volatility text, config text
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_proc procedure ON procedure.pronamespace = namespace.oid
           JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
           WHERE namespace.nspname = 'public' AND procedure.proname = required.name
             AND procedure.pronargs = 0 AND procedure.prokind = 'f'
             AND language.lanname = required.language
             AND pg_catalog.format_type(procedure.prorettype, NULL) = required."returnType"
             AND procedure.provolatile::text = required.volatility
             AND NOT procedure.prosecdef AND NOT procedure.proleakproof
             AND NOT procedure.proisstrict AND NOT procedure.proretset
             AND COALESCE(pg_catalog.array_to_string(procedure.proconfig, ','), '') = required.config
             AND pg_catalog.encode(
               pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc, 'UTF8')), 'hex'
             ) = required."sourceSha256"
         ) actual ON true
       )
       SELECT COALESCE(pg_catalog.bool_and(current), false) AS current FROM checks`,
      [JSON.stringify(CATALOG_REQUIREMENTS)],
    );
    await migrationClient.query("COMMIT");
    return catalog.rows[0]?.current === true
      ? { current: true, reasons: [] }
      : { current: false, reasons: [failureReason] };
  } catch {
    try {
      await migrationClient.query("ROLLBACK");
    } catch {
      discardClient = true;
    }
    return { current: false, reasons: [failureReason] };
  } finally {
    migrationClient.release(discardClient ? true : undefined);
  }
}

function authorizeLifecycle(
  transaction: TenantTransaction,
  action: "activate" | "deactivate",
): PolicyDecision {
  const input = { serviceKey: HR_LEAVE_SERVICE_KEY };
  const rules = [
    {
      effect: "allow" as const,
      id: `current_tenant_admin_${action}_hr_leave_service`,
      matches: (_input: typeof input, actor: { roleKey: string }) =>
        actor.roleKey === "tenant_admin",
    },
  ];
  const hrActionKey = `hr.leave.${action}`;
  assertPolicyAllowed(
    evaluatePolicy(
      {
        actionKey: hrActionKey,
        input,
        resourceKey: HR_LEAVE_SERVICE_KEY,
        transaction,
      },
      rules,
    ),
    transaction,
    hrActionKey,
    HR_LEAVE_SERVICE_KEY,
  );
  const platformActionKey = `platform.service_activation.${action}`;
  const platformDecision = evaluatePolicy(
    {
      actionKey: platformActionKey,
      input,
      resourceKey: HR_LEAVE_SERVICE_KEY,
      transaction,
    },
    rules,
  );
  assertPolicyAllowed(platformDecision, transaction, platformActionKey, HR_LEAVE_SERVICE_KEY);
  return platformDecision;
}
function withBilling(result: ServiceActivationResult): HrLeaveServiceLifecycleResult {
  return { ...result, billingState: HR_LEAVE_BILLING_STATE };
}
function activationInput(
  transaction: TenantTransaction,
  input: HrLeaveServiceLifecycleInput,
  preflight: () => Promise<ActivationPreflight>,
): SetServiceActivationInput {
  return {
    authorization: authorizeLifecycle(transaction, "activate"),
    evidenceEventType: "evidence.hr.leave_service.activated",
    expectedVersion: input.expectedVersion,
    outboxEventType: INTERNAL_ACTIVATION_OUTBOX_EVENT_TYPE,
    preflight,
    serviceKey: HR_LEAVE_SERVICE_KEY,
    targetState: "active",
  };
}
async function probeActivationReplay(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: HrLeaveServiceLifecycleInput,
): Promise<ServiceActivationResult | null> {
  const preflightRequired = new Error("Activation readiness phase is required");
  try {
    return await withTenantTransaction(
      runtimePool,
      context,
      async (transaction) =>
        setServiceActivation(
          transaction,
          activationInput(transaction, input, async () => {
            if (runtimePool === migrationReadPool) {
              return { current: false, reasons: ["migration_reader_not_isolated"] };
            }
            throw preflightRequired;
          }),
        ),
      { migrationBarrier: "shared" },
    );
  } catch (error) {
    if (error === preflightRequired) return null;
    throw error;
  }
}
export async function activateHrLeaveService(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: HrLeaveServiceLifecycleInput,
): Promise<HrLeaveServiceLifecycleResult> {
  const replay = await probeActivationReplay(runtimePool, migrationReadPool, context, input);
  if (replay) return withBilling(replay);

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
        withBilling(
          await setServiceActivation(
            transaction,
            activationInput(transaction, input, async () => {
              const client = migrationClient;
              if (!client) return { current: false, reasons: ["migration_ledger_unavailable"] };
              migrationClient = null;
              return inspectActivationReadiness(transaction, client);
            }),
          ),
        ),
      { migrationBarrier: "shared" },
    );
  } finally {
    migrationClient?.release();
  }
}
export async function deactivateHrLeaveService(
  runtimePool: Pool,
  context: OperationContext,
  input: HrLeaveServiceLifecycleInput,
): Promise<HrLeaveServiceLifecycleResult> {
  return await withTenantTransaction(runtimePool, context, async (transaction) =>
    withBilling(
      await setServiceActivation(transaction, {
        authorization: authorizeLifecycle(transaction, "deactivate"),
        evidenceEventType: "evidence.hr.leave_service.deactivated",
        expectedVersion: input.expectedVersion,
        outboxEventType: INTERNAL_ACTIVATION_OUTBOX_EVENT_TYPE,
        serviceKey: HR_LEAVE_SERVICE_KEY,
        targetState: "inactive",
      }),
    ),
  );
}
