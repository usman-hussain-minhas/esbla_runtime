import {
  type ActivationPreflight,
  evaluatePolicy,
  type OperationContext,
  PlatformError,
  type ServiceActivationResult,
  setServiceActivation,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { HrWorkforceProfileError } from "./workforce-profile-errors.js";
import { assertWorkforceIdempotency, authorizeTenantAdmin } from "./workforce-profile-internal.js";
import {
  HR_WORKFORCE_PROFILE_BILLING_STATE,
  HR_WORKFORCE_PROFILE_SERVICE_KEY,
  type WorkforceProfileServiceLifecycleInput,
  type WorkforceProfileServiceLifecycleResult,
} from "./workforce-profile-types.js";

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
  readonly failed_checks: readonly string[] | null;
}

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
  {
    createdAt: 1784613324040,
    hash: "a84b6112667f837d63b1f0998a44440713812646917a4231fb0c1ffa505586b1",
    id: "0006",
  },
] as const;

const CATALOG_REQUIREMENTS = {
  columns: [
    ["hr_worker_profiles", "worker_profile_id", "uuid", true],
    ["hr_worker_profiles", "tenant_id", "uuid", true],
    ["hr_worker_profiles", "principal_id", "uuid", false],
    ["hr_worker_profiles", "employee_number", "character varying(64)", false],
    ["hr_worker_profiles", "workforce_status", "public.hr_workforce_status", true],
    ["hr_worker_profiles", "created_at", "timestamp with time zone", true],
    ["hr_worker_profiles", "updated_at", "timestamp with time zone", true],
    ["hr_worker_profiles", "current_reporting_relationship_id", "uuid", false],
    ["hr_worker_profiles", "row_version", "integer", true],
    ["hr_workforce_status_history", "workforce_status_history_id", "uuid", true],
    ["hr_workforce_status_history", "tenant_id", "uuid", true],
    ["hr_workforce_status_history", "worker_profile_id", "uuid", true],
    ["hr_workforce_status_history", "previous_status", "public.hr_workforce_status", false],
    ["hr_workforce_status_history", "new_status", "public.hr_workforce_status", true],
    ["hr_workforce_status_history", "effective_at", "timestamp with time zone", true],
    ["hr_workforce_status_history", "actor_principal_id", "uuid", true],
    ["hr_workforce_status_history", "correlation_id", "uuid", true],
    ["hr_workforce_profile_service_control", "service_control_id", "uuid", true],
    ["hr_workforce_profile_service_control", "tenant_id", "uuid", true],
    ["hr_workforce_profile_service_control", "service_key", "text", true],
    [
      "hr_workforce_profile_service_control",
      "activation_state",
      "public.service_activation_state",
      true,
    ],
    ["hr_workforce_profile_service_control", "activation_version", "integer", true],
    ["hr_workforce_profile_service_control", "settings_version", "integer", true],
    ["hr_workforce_profile_service_control", "updated_at", "timestamp with time zone", true],
    ["hr_workforce_profile_service_control", "row_version", "integer", true],
  ].map(([parent, name, type, notNull]) => ({ name, notNull, parent, type })),
  constraints: [
    ["hr_worker_profiles", "hr_worker_profiles_tenant_worker_profile_uq", "u"],
    ["hr_worker_profiles", "hr_worker_profiles_tenant_id_tenants_tenant_id_fk", "f"],
    ["hr_worker_profiles", "hr_worker_profiles_principal_same_tenant_fk", "f"],
    ["hr_worker_profiles", "hr_worker_profiles_employee_number_valid", "c"],
    ["hr_worker_profiles", "hr_worker_profiles_active_principal_link_required", "c"],
    ["hr_worker_profiles", "hr_worker_profiles_relationship_head_reserved", "c"],
    ["hr_worker_profiles", "hr_worker_profiles_row_version_positive", "c"],
    [
      "hr_workforce_status_history",
      "hr_workforce_status_history_tenant_id_tenants_tenant_id_fk",
      "f",
    ],
    ["hr_workforce_status_history", "hr_workforce_status_history_worker_same_tenant_fk", "f"],
    ["hr_workforce_status_history", "hr_workforce_status_history_actor_same_tenant_fk", "f"],
    ["hr_workforce_status_history", "hr_workforce_status_history_transition_changes_status", "c"],
    [
      "hr_workforce_profile_service_control",
      "uq_hr_workforce_profile_service_control_tenant_key",
      "u",
    ],
    [
      "hr_workforce_profile_service_control",
      "hr_workforce_profile_service_control_activation_fk",
      "f",
    ],
    ["hr_workforce_profile_service_control", "hr_wfp_service_control_tenant_fk", "f"],
    ["hr_workforce_profile_service_control", "hr_workforce_profile_service_control_key_exact", "c"],
    [
      "hr_workforce_profile_service_control",
      "hr_wfp_service_control_activation_version_positive",
      "c",
    ],
    [
      "hr_workforce_profile_service_control",
      "hr_workforce_profile_service_control_settings_version_positive",
      "c",
    ],
    [
      "hr_workforce_profile_service_control",
      "hr_workforce_profile_service_control_row_version_positive",
      "c",
    ],
  ].map(([parent, name, type]) => ({ name, parent, type })),
  functions: [
    [
      "esbla_enforce_hr_worker_profile_state",
      "84ab7036387488420b312e98980ef9ec9f76d4c23e6e5998bdbd5afcffdfed13",
    ],
    [
      "esbla_enforce_hr_workforce_status_history",
      "365e3b2c49e393e8febff91dd39b6bb728aa947439af64b9448bab36ebc3ea6c",
    ],
    [
      "esbla_enforce_hr_workforce_profile_service_control",
      "0f383a9376abeb9b6ae3a80aa978879dd7d9bdcabd470aafdb98a491ad07ce91",
    ],
    [
      "esbla_sync_hr_workforce_profile_service_activation",
      "98c2103d3aaabc1577c1de424d46465aef57cd232408debbfefa30367c77b9b2",
    ],
  ].map(([name, sourceSha256]) => ({ name, sourceSha256 })),
  indexes: [
    ["hr_worker_profiles", "uq_hr_worker_profiles_tenant_principal_current", true],
    ["hr_worker_profiles", "idx_hr_worker_profiles_tenant_status_cursor", false],
    [
      "hr_workforce_status_history",
      "idx_hr_workforce_status_history_tenant_worker_effective",
      false,
    ],
  ].map(([parent, name, unique]) => ({ name, parent, unique })),
  policies: [
    ["hr_worker_profiles", "hr_worker_profiles_tenant_isolation"],
    ["hr_workforce_status_history", "hr_workforce_status_history_tenant_isolation"],
    [
      "hr_workforce_profile_service_control",
      "hr_workforce_profile_service_control_tenant_isolation",
    ],
  ].map(([parent, name]) => ({ name, parent })),
  tables: [
    ["hr_worker_profiles", 9],
    ["hr_workforce_status_history", 8],
    ["hr_workforce_profile_service_control", 8],
  ].map(([name, columnCount]) => ({ columnCount, name })),
  triggers: [
    [
      "hr_worker_profiles",
      "hr_worker_profiles_enforce_state",
      "esbla_enforce_hr_worker_profile_state",
    ],
    [
      "hr_worker_profiles",
      "hr_worker_profiles_reject_truncate",
      "esbla_enforce_hr_worker_profile_state",
    ],
    [
      "hr_workforce_status_history",
      "hr_workforce_status_history_enforce_append_only",
      "esbla_enforce_hr_workforce_status_history",
    ],
    [
      "hr_workforce_status_history",
      "hr_workforce_status_history_reject_truncate",
      "esbla_enforce_hr_workforce_status_history",
    ],
    [
      "hr_workforce_profile_service_control",
      "hr_workforce_profile_service_control_enforce_state",
      "esbla_enforce_hr_workforce_profile_service_control",
    ],
    [
      "hr_workforce_profile_service_control",
      "hr_workforce_profile_service_control_reject_truncate",
      "esbla_enforce_hr_workforce_profile_service_control",
    ],
    [
      "service_activations",
      "service_activations_sync_hr_workforce_profile",
      "esbla_sync_hr_workforce_profile_service_activation",
    ],
  ].map(([parent, name, functionName]) => ({ functionName, name, parent })),
} as const;

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

    failureReason = "workforce_profile_catalog_not_current";
    const catalog = await migrationClient.query<CatalogCheck>(
      `WITH requirements AS (SELECT $1::jsonb AS value), checks AS (
         SELECT 'table:' || required.name AS id, COALESCE(actual.current, false) AS current
         FROM requirements,
              jsonb_to_recordset(value -> 'tables')
                AS required(name text, "columnCount" integer)
         LEFT JOIN LATERAL (
           SELECT relation.relrowsecurity AND relation.relforcerowsecurity
             AND (SELECT count(*) FROM pg_attribute attribute
                  WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0
                    AND NOT attribute.attisdropped) = required."columnCount" AS current
           FROM pg_namespace namespace
           JOIN pg_class relation ON relation.relnamespace = namespace.oid
           WHERE namespace.nspname = 'public' AND relation.relname = required.name
             AND relation.relkind = 'r' AND relation.relpersistence = 'p'
         ) actual ON true

         UNION ALL
         SELECT 'column:' || required.parent || '.' || required.name,
                COALESCE(actual.current, false)
         FROM requirements,
              jsonb_to_recordset(value -> 'columns') AS required(
                name text, parent text, type text, "notNull" boolean
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_namespace namespace
           JOIN pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND relation.relkind = 'r' AND attribute.attname = required.name
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
             AND format_type(attribute.atttypid, attribute.atttypmod) = required.type
             AND attribute.attnotnull = required."notNull"
         ) actual ON true

         UNION ALL
         SELECT 'index:' || required.name, COALESCE(actual.current, false)
         FROM requirements,
              jsonb_to_recordset(value -> 'indexes') AS required(
                name text, parent text, "unique" boolean
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_namespace index_namespace
           JOIN pg_class index_relation ON index_relation.relnamespace = index_namespace.oid
           JOIN pg_index index_record ON index_record.indexrelid = index_relation.oid
           JOIN pg_class parent_relation ON parent_relation.oid = index_record.indrelid
           JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent_relation.relnamespace
           WHERE index_namespace.nspname = 'public' AND index_relation.relname = required.name
             AND index_relation.relkind = 'i' AND parent_namespace.nspname = 'public'
             AND parent_relation.relname = required.parent AND parent_relation.relkind = 'r'
             AND index_record.indisunique = required."unique"
             AND NOT index_record.indisprimary AND index_record.indisvalid
             AND index_record.indisready AND index_record.indislive
         ) actual ON true

         UNION ALL
         SELECT 'policy:' || required.name, COALESCE(actual.current, false)
         FROM requirements,
              jsonb_to_recordset(value -> 'policies') AS required(name text, parent text)
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_namespace namespace
           JOIN pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_policy policy ON policy.polrelid = relation.oid
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND relation.relrowsecurity AND relation.relforcerowsecurity
             AND policy.polname = required.name AND policy.polcmd = '*'
             AND policy.polpermissive AND policy.polroles = ARRAY[0::oid]
             AND pg_get_expr(policy.polqual, policy.polrelid) =
               '(tenant_id = public.esbla_current_tenant_id())'
             AND pg_get_expr(policy.polwithcheck, policy.polrelid) =
               '(tenant_id = public.esbla_current_tenant_id())'
             AND NOT EXISTS (
               SELECT 1 FROM pg_policy other
               WHERE other.polrelid = relation.oid AND other.polpermissive
                 AND other.polname <> required.name
             )
         ) actual ON true

         UNION ALL
         SELECT 'trigger:' || required.name, COALESCE(actual.current, false)
         FROM requirements,
              jsonb_to_recordset(value -> 'triggers') AS required(
                name text, parent text, "functionName" text
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_namespace namespace
           JOIN pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_trigger trigger_record ON trigger_record.tgrelid = relation.oid
           JOIN pg_proc procedure ON procedure.oid = trigger_record.tgfoid
           JOIN pg_namespace procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND trigger_record.tgname = required.name AND NOT trigger_record.tgisinternal
             AND trigger_record.tgenabled = 'O' AND procedure_namespace.nspname = 'public'
             AND procedure.proname = required."functionName" AND procedure.pronargs = 0
         ) actual ON true

         UNION ALL
         SELECT 'constraint:' || required.name, COALESCE(actual.current, false)
         FROM requirements,
              jsonb_to_recordset(value -> 'constraints') AS required(
                name text, parent text, type text
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_namespace namespace
           JOIN pg_class relation ON relation.relnamespace = namespace.oid
           JOIN pg_constraint constraint_record ON constraint_record.conrelid = relation.oid
           WHERE namespace.nspname = 'public' AND relation.relname = required.parent
             AND constraint_record.conname = required.name
             AND constraint_record.contype::text = required.type
             AND constraint_record.convalidated AND NOT constraint_record.condeferrable
             AND NOT constraint_record.condeferred
         ) actual ON true

         UNION ALL
         SELECT 'function:' || required.name, COALESCE(actual.current, false)
         FROM requirements,
              jsonb_to_recordset(value -> 'functions') AS required(
                name text, "sourceSha256" text
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_namespace namespace
           JOIN pg_proc procedure ON procedure.pronamespace = namespace.oid
           JOIN pg_language language ON language.oid = procedure.prolang
           WHERE namespace.nspname = 'public' AND procedure.proname = required.name
             AND procedure.pronargs = 0 AND procedure.prokind = 'f'
             AND language.lanname = 'plpgsql' AND format_type(procedure.prorettype, NULL) = 'trigger'
             AND procedure.provolatile = 'v' AND NOT procedure.prosecdef
             AND COALESCE(array_to_string(procedure.proconfig, ','), '') =
               'search_path=pg_catalog, public'
             AND encode(sha256(convert_to(procedure.prosrc, 'UTF8')), 'hex') =
               required."sourceSha256"
         ) actual ON true
       )
       SELECT COALESCE(bool_and(current), false) AS current,
              array_agg(id ORDER BY id) FILTER (WHERE NOT current) AS failed_checks
       FROM checks`,
      [JSON.stringify(CATALOG_REQUIREMENTS)],
    );
    await migrationClient.query("COMMIT");
    const catalogCheck = catalog.rows[0];
    return catalogCheck?.current === true
      ? { current: true, reasons: [] }
      : {
          current: false,
          reasons:
            catalogCheck?.failed_checks && catalogCheck.failed_checks.length > 0
              ? catalogCheck.failed_checks
              : [failureReason],
        };
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

function lifecycleResult(result: ServiceActivationResult): WorkforceProfileServiceLifecycleResult {
  return {
    billingState: HR_WORKFORCE_PROFILE_BILLING_STATE,
    replayed: result.replayed,
    serviceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
    state: result.state,
    version: result.version,
  };
}

function assertLifecycleInput(
  context: OperationContext,
  input: WorkforceProfileServiceLifecycleInput,
): void {
  assertWorkforceIdempotency(context.correlationId, input.idempotencyKey);
  if (
    input.expectedVersion !== null &&
    (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
  ) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_INPUT_INVALID",
      "Expected activation version must be null or a positive integer",
    );
  }
}

function lifecycleAuthorization(transaction: TenantTransaction, action: "activate" | "deactivate") {
  authorizeTenantAdmin(
    transaction,
    `hr.workforce.${action}_service`,
    HR_WORKFORCE_PROFILE_SERVICE_KEY,
  );
  return evaluatePolicy(
    {
      actionKey: `platform.service_activation.${action}`,
      input: { serviceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY },
      resourceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
      transaction,
    },
    [
      {
        effect: "allow",
        id: `current_tenant_admin_${action}_workforce_profile_service`,
        matches: (_input, actor) => actor.roleKey === "tenant_admin",
      },
    ],
  );
}

function activationOptions() {
  return {
    migrationBarrier: "shared" as const,
    serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
    serviceActivationLock: "update" as const,
  };
}

async function setActivation(
  transaction: TenantTransaction,
  input: WorkforceProfileServiceLifecycleInput,
  preflight: () => Promise<ActivationPreflight>,
) {
  return await setServiceActivation(transaction, {
    authorization: lifecycleAuthorization(transaction, "activate"),
    evidenceEventType: "hr.workforce_profile.activate_service",
    expectedVersion: input.expectedVersion,
    outboxEventType: "hr.workforce_profile.activate_service",
    preflight,
    serviceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
    targetState: "active",
  });
}

async function probeActivationReplay(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: WorkforceProfileServiceLifecycleInput,
): Promise<ServiceActivationResult | null> {
  const preflightRequired = new Error("Workforce activation readiness phase is required");
  try {
    return await withTenantTransaction(
      runtimePool,
      context,
      async (transaction) =>
        setActivation(transaction, input, async () => {
          if (runtimePool === migrationReadPool) {
            return { current: false, reasons: ["migration_reader_not_isolated"] };
          }
          throw preflightRequired;
        }),
      activationOptions(),
    );
  } catch (error) {
    if (error === preflightRequired) return null;
    throw error;
  }
}

export async function activateWorkforceProfileService(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: WorkforceProfileServiceLifecycleInput,
): Promise<WorkforceProfileServiceLifecycleResult> {
  assertLifecycleInput(context, input);
  if (runtimePool === migrationReadPool) {
    throw new PlatformError(
      "ACTIVATION_DEPENDENCY_BLOCKED",
      "Service activation dependencies are not current",
      { reasons: ["migration_reader_not_isolated"] },
    );
  }
  const replay = await probeActivationReplay(runtimePool, migrationReadPool, context, input);
  if (replay) return lifecycleResult(replay);

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
        lifecycleResult(
          await setActivation(transaction, input, async () => {
            const client = migrationClient;
            if (!client) {
              return { current: false, reasons: ["migration_ledger_unavailable"] };
            }
            migrationClient = null;
            return inspectActivationReadiness(transaction, client);
          }),
        ),
      activationOptions(),
    );
  } finally {
    migrationClient?.release();
  }
}

export async function deactivateWorkforceProfileService(
  pool: Pool,
  context: OperationContext,
  input: WorkforceProfileServiceLifecycleInput,
): Promise<WorkforceProfileServiceLifecycleResult> {
  assertLifecycleInput(context, input);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) =>
      lifecycleResult(
        await setServiceActivation(transaction, {
          authorization: lifecycleAuthorization(transaction, "deactivate"),
          evidenceEventType: "hr.workforce_profile.deactivate_service",
          expectedVersion: input.expectedVersion,
          outboxEventType: "hr.workforce_profile.deactivate_service",
          serviceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
          targetState: "inactive",
        }),
      ),
    activationOptions(),
  );
}
