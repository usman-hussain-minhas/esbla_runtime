import { createHash } from "node:crypto";
import { type HrServiceControl, parseHrServiceControl } from "@esbla/contracts";
import type {
  HrServiceConfigureBody,
  HrWorkforceProfileSettings,
} from "@esbla/contracts/hr-service-control-api";
import {
  type ActivationPreflight,
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
  type SetServiceActivationInput,
  setServiceActivation,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import {
  HR_LEAVE_CATALOG_REQUIREMENTS,
  HR_LEAVE_REQUIRED_MIGRATIONS,
  HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS,
  HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS,
  HR_WORKFORCE_PROFILE_RUNTIME_TABLE_PRIVILEGES,
} from "./activation-readiness.js";
import { hrManifest } from "./manifest.js";
import { HR_LEAVE_BILLING_STATE, HR_LEAVE_SERVICE_KEY } from "./types.js";
import { HrWorkforceProfileError } from "./workforce-errors.js";
import { workforceProfileSettings } from "./workforce-settings.js";
import {
  HR_WORKFORCE_PROFILE_BILLING_STATE,
  HR_WORKFORCE_PROFILE_SERVICE_KEY,
} from "./workforce-types.js";

export interface HrLeaveServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export interface HrLeaveServiceLifecycleResult extends ServiceActivationResult {
  readonly billingState: typeof HR_LEAVE_BILLING_STATE;
}
export interface HrWorkforceProfileServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export type HrWorkforceProfileServiceConfigureInput = HrServiceConfigureBody;
export type HrWorkforceProfileActivationMode = "non_production" | "production";
export interface HrWorkforceProfileServiceControlResult {
  readonly billingState: typeof HR_WORKFORCE_PROFILE_BILLING_STATE;
  readonly control: HrServiceControl;
  readonly replayed: boolean;
}
interface DatabaseIdentity {
  readonly database_name: string;
  readonly database_oid: string;
  readonly in_recovery: boolean;
  readonly postmaster_started_at: string;
  readonly server_version_num: number;
  readonly session_replication_role: string;
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
export type ActivationCatalogRequirements = Omit<
  typeof HR_LEAVE_CATALOG_REQUIREMENTS,
  "enums" | "functions"
> & {
  readonly exactColumnParents?: readonly string[];
  readonly exactConstraintParents?: readonly string[];
  readonly exactIndexParents?: readonly string[];
  readonly exactTriggerParents?: readonly string[];
  readonly enums?: readonly {
    readonly labels: readonly string[];
    readonly name: string;
  }[];
  readonly functions: readonly ((typeof HR_LEAVE_CATALOG_REQUIREMENTS.functions)[number] & {
    readonly applicationExecutable?: boolean;
    readonly identityArguments?: string;
    readonly ownerOnlyExecutable?: boolean;
    readonly publicExecutable?: boolean;
    readonly securityDefiner?: boolean;
  })[];
};
const INTERNAL_ACTIVATION_OUTBOX_EVENT_TYPE = "internal.platform.service_activation.changed";
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
            pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
            pg_catalog.current_setting('session_replication_role') AS session_replication_role,
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
export async function inspectActivationReadiness(
  transaction: TenantTransaction,
  migrationClient: PoolClient,
  requirements: {
    readonly catalog: ActivationCatalogRequirements;
    readonly migrations: readonly {
      readonly createdAt: number;
      readonly hash: string;
      readonly id: string;
    }[];
    readonly runtimeTablePrivileges?: readonly {
      readonly delete: boolean;
      readonly insert: boolean;
      readonly name: string;
      readonly references: boolean;
      readonly select: boolean;
      readonly trigger: boolean;
      readonly truncate: boolean;
      readonly update: boolean;
    }[];
    readonly semantic?: ActivationPreflight;
  },
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

    if (requirements.runtimeTablePrivileges) {
      failureReason = "runtime_projection_privileges_not_current";
      const privilege = await transaction.client.query<{
        current: boolean;
        unsafe_role: boolean;
      }>(
        `WITH required AS (
           SELECT * FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS item(
             name text, "select" boolean, "insert" boolean, "update" boolean,
             "delete" boolean, "truncate" boolean, "references" boolean,
             "trigger" boolean
           )
         )
         SELECT (role.rolsuper OR role.rolbypassrls OR role.rolreplication
                   OR role.rolcreaterole OR role.rolcreatedb
                   OR session_user <> current_user
                   OR EXISTS (
                     SELECT 1 FROM pg_catalog.pg_auth_members membership
                     WHERE membership.member = role.oid
                   )) AS unsafe_role,
                pg_catalog.bool_and(
                  pg_catalog.has_table_privilege(
                    current_user, required.name, 'SELECT'
                  ) = required."select"
                  AND pg_catalog.has_table_privilege(
                    current_user, required.name, 'INSERT'
                  ) = required."insert"
                  AND pg_catalog.has_any_column_privilege(
                    current_user, required.name, 'INSERT'
                  ) = required."insert"
                  AND pg_catalog.has_table_privilege(
                    current_user, required.name, 'UPDATE'
                  ) = required."update"
                  AND pg_catalog.has_any_column_privilege(
                    current_user, required.name, 'UPDATE'
                  ) = required."update"
                  AND pg_catalog.has_table_privilege(
                    current_user, required.name, 'DELETE'
                  ) = required."delete"
                  AND pg_catalog.has_table_privilege(
                    current_user, required.name, 'TRUNCATE'
                  ) = required."truncate"
                  AND pg_catalog.has_table_privilege(
                    current_user, required.name, 'REFERENCES'
                  ) = required."references"
                  AND pg_catalog.has_any_column_privilege(
                    current_user, required.name, 'REFERENCES'
                  ) = required."references"
                  AND pg_catalog.has_table_privilege(
                    current_user, required.name, 'TRIGGER'
                  ) = required."trigger"
                ) AS current
         FROM pg_catalog.pg_roles role, required
         WHERE role.rolname = current_user
         GROUP BY role.oid, role.rolsuper, role.rolbypassrls, role.rolreplication,
                  role.rolcreaterole, role.rolcreatedb`,
        [JSON.stringify(requirements.runtimeTablePrivileges)],
      );
      const row = privilege.rows[0];
      const replicationRoleAuthorityUnsafe =
        runtimeIdentity.session_replication_role !== "origin" ||
        (runtimeIdentity.server_version_num >= 150000 &&
          (
            await transaction.client.query<{ allowed: boolean }>(
              `SELECT pg_catalog.has_parameter_privilege(
                        current_user, 'session_replication_role', 'SET'
                      ) OR pg_catalog.has_parameter_privilege(
                        current_user, 'session_replication_role', 'ALTER SYSTEM'
                      ) AS allowed`,
            )
          ).rows[0]?.allowed !== false);
      if (!row || row.unsafe_role || !row.current || replicationRoleAuthorityUnsafe) {
        await migrationClient.query("COMMIT");
        return { current: false, reasons: [failureReason] };
      }
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
          requirements.migrations.map(({ createdAt, hash, id }) => ({
            created_at: createdAt,
            hash,
            id,
          })),
        ),
      ],
    );
    const migrationById = new Map(migrations.rows.map((row) => [row.id, row]));
    const migrationReasons = requirements.migrations.flatMap(({ id }) => {
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
             AND relation.relowner = (
               SELECT role.oid FROM pg_catalog.pg_roles role
               WHERE role.rolname = current_user
             )
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
             AND (required.parent NOT IN (
               SELECT pg_catalog.jsonb_array_elements_text(
                 COALESCE(value -> 'exactColumnParents', '[]'::jsonb)
               )
             ) OR NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_attribute other
               WHERE other.attrelid = relation.oid AND other.attnum > 0
                 AND NOT other.attisdropped
                 AND NOT EXISTS (
                   SELECT 1 FROM pg_catalog.jsonb_to_recordset(value -> 'columns')
                     AS declared(name text, parent text)
                   WHERE declared.parent = required.parent
                     AND declared.name = other.attname
                 )
             ))
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
             AND (required.parent NOT IN (
               SELECT pg_catalog.jsonb_array_elements_text(
                 COALESCE(value -> 'exactIndexParents', '[]'::jsonb)
               )
             ) OR NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_index other_index
               JOIN pg_catalog.pg_class other_relation
                 ON other_relation.oid = other_index.indexrelid
               WHERE other_index.indrelid = parent_relation.oid
                 AND other_relation.relkind = 'i'
                 AND NOT EXISTS (
                   SELECT 1 FROM pg_catalog.jsonb_to_recordset(value -> 'indexes')
                     AS declared(name text, parent text)
                   WHERE declared.parent = required.parent
                     AND declared.name = other_relation.relname
                 )
             ))
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
               WHERE other_policy.polrelid = relation.oid
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
             AND (required.parent NOT IN (
               SELECT pg_catalog.jsonb_array_elements_text(
                 COALESCE(value -> 'exactTriggerParents', '[]'::jsonb)
               )
             ) OR NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_trigger other
               WHERE other.tgrelid = relation.oid AND NOT other.tgisinternal
                 AND NOT EXISTS (
                   SELECT 1 FROM pg_catalog.jsonb_to_recordset(value -> 'triggers')
                     AS declared(name text, parent text)
                   WHERE declared.parent = required.parent AND declared.name = other.tgname
                 )
             ))
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
             ) WHEN required.type = 'f' THEN EXISTS (
               SELECT 1
               FROM pg_catalog.pg_class index_relation
               JOIN pg_catalog.pg_namespace index_namespace
                 ON index_namespace.oid = index_relation.relnamespace
               JOIN pg_catalog.pg_index index_record
                 ON index_record.indexrelid = index_relation.oid
               WHERE index_relation.oid = constraint_record.conindid
                 AND index_namespace.nspname = 'public'
                 AND index_relation.relkind = 'i'
                 AND index_record.indisunique AND index_record.indimmediate
                 AND NOT index_record.indisexclusion
                 AND index_record.indisvalid AND index_record.indisready
                 AND index_record.indislive
             ) ELSE constraint_record.conindid = 0 END
             AND (required.parent NOT IN (
               SELECT pg_catalog.jsonb_array_elements_text(
                 COALESCE(value -> 'exactConstraintParents', '[]'::jsonb)
               )
             ) OR NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_constraint other
               WHERE other.conrelid = relation.oid
                 AND other.contype::text IN ('c', 'f', 'p', 'u', 'x')
                 AND NOT EXISTS (
                   SELECT 1 FROM pg_catalog.jsonb_to_recordset(value -> 'constraints')
                     AS declared(name text, parent text)
                   WHERE declared.parent = required.parent
                     AND declared.name = other.conname
                 )
             ))
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(
                COALESCE(value -> 'enums', '[]'::jsonb)
              ) AS required(name text, labels jsonb)
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_type type_record
             ON type_record.typnamespace = namespace.oid
           WHERE namespace.nspname = 'public' AND type_record.typname = required.name
             AND type_record.typtype = 'e'
             AND type_record.typowner = (
               SELECT role.oid FROM pg_catalog.pg_roles role
               WHERE role.rolname = current_user
             )
             AND (
               SELECT COALESCE(
                 pg_catalog.jsonb_agg(enum_record.enumlabel ORDER BY enum_record.enumsortorder),
                 '[]'::jsonb
               )
               FROM pg_catalog.pg_enum enum_record
               WHERE enum_record.enumtypid = type_record.oid
             ) = required.labels
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'functions') AS required(
                name text, language text, "returnType" text, "sourceSha256" text,
                volatility text, config text, "securityDefiner" boolean,
                "publicExecutable" boolean, "ownerOnlyExecutable" boolean,
                "identityArguments" text, "applicationExecutable" boolean
              )
         LEFT JOIN LATERAL (
           SELECT true AS current
           FROM pg_catalog.pg_namespace namespace
           JOIN pg_catalog.pg_proc procedure ON procedure.pronamespace = namespace.oid
           JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
           WHERE namespace.nspname = 'public' AND procedure.proname = required.name
             AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
                   COALESCE(required."identityArguments", '')
             AND procedure.prokind = 'f'
             AND NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_proc overload
               WHERE overload.pronamespace = procedure.pronamespace
                 AND overload.proname = procedure.proname
                 AND overload.oid <> procedure.oid
             )
             AND procedure.proowner = (
               SELECT role.oid FROM pg_catalog.pg_roles role
               WHERE role.rolname = current_user
             )
             AND language.lanname = required.language
             AND pg_catalog.format_type(procedure.prorettype, NULL) = required."returnType"
             AND procedure.provolatile::text = required.volatility
             AND procedure.prosecdef = COALESCE(required."securityDefiner", false)
             AND NOT procedure.proleakproof
             AND NOT procedure.proisstrict AND NOT procedure.proretset
             AND COALESCE(pg_catalog.array_to_string(procedure.proconfig, ','), '') = required.config
             AND (
               required."publicExecutable" IS NULL OR EXISTS (
                 SELECT 1
                 FROM pg_catalog.aclexplode(COALESCE(
                   procedure.proacl,
                   pg_catalog.acldefault('f', procedure.proowner)
                 )) privilege
               WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
               ) = required."publicExecutable"
             )
             AND (
               NOT COALESCE(required."ownerOnlyExecutable", false) OR (
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.aclexplode(COALESCE(
                     procedure.proacl,
                     pg_catalog.acldefault('f', procedure.proowner)
                   )) privilege
                   WHERE privilege.privilege_type = 'EXECUTE'
                     AND privilege.grantee = procedure.proowner
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM pg_catalog.aclexplode(COALESCE(
                     procedure.proacl,
                     pg_catalog.acldefault('f', procedure.proowner)
                   )) privilege
                   WHERE privilege.privilege_type = 'EXECUTE'
                     AND privilege.grantee <> procedure.proowner
                 )
               )
             )
             AND (
               required."applicationExecutable" IS NULL OR (
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.aclexplode(COALESCE(
                     procedure.proacl,
                     pg_catalog.acldefault('f', procedure.proowner)
                   )) privilege
                   WHERE privilege.privilege_type = 'EXECUTE'
                     AND privilege.grantee = procedure.proowner
                 )
                 AND EXISTS (
                   SELECT 1
                   FROM pg_catalog.aclexplode(COALESCE(
                     procedure.proacl,
                     pg_catalog.acldefault('f', procedure.proowner)
                   )) privilege
                   JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
                   WHERE privilege.privilege_type = 'EXECUTE'
                     AND role.rolname = 'esbla_app'
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM pg_catalog.aclexplode(COALESCE(
                     procedure.proacl,
                     pg_catalog.acldefault('f', procedure.proowner)
                   )) privilege
                   WHERE privilege.privilege_type = 'EXECUTE'
                     AND privilege.grantee <> procedure.proowner
                     AND privilege.grantee <> COALESCE((
                       SELECT role.oid FROM pg_catalog.pg_roles role
                       WHERE role.rolname = 'esbla_app'
                     ), 0)
                 )
               ) = required."applicationExecutable"
             )
             AND pg_catalog.encode(
               pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc, 'UTF8')), 'hex'
             ) = required."sourceSha256"
         ) actual ON true
       )
       SELECT COALESCE(pg_catalog.bool_and(current), false) AS current FROM checks`,
      [JSON.stringify(requirements.catalog)],
    );
    if (catalog.rows[0]?.current !== true) {
      await migrationClient.query("COMMIT");
      return { current: false, reasons: [failureReason] };
    }
    if (requirements.semantic?.current === false) {
      await migrationClient.query("COMMIT");
      return requirements.semantic;
    }
    await migrationClient.query("COMMIT");
    return { current: true, reasons: [] };
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
              return inspectActivationReadiness(transaction, client, {
                catalog: HR_LEAVE_CATALOG_REQUIREMENTS,
                migrations: HR_LEAVE_REQUIRED_MIGRATIONS,
              });
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

const WORKFORCE_PROFILE_SUBJECT_TYPE = "hr.workforce_profile.service_control";
const WORKFORCE_PROFILE_EVENT = {
  activate: "hr.workforce_profile.activate_service",
  configure: "hr.workforce_profile.configure_service",
  deactivate: "hr.workforce_profile.deactivate_service",
} as const;
const WORKFORCE_PROFILE_RESPONSE_BINDING_EVENT =
  "hr.workforce_profile.service_control.response_bound";
const WORKFORCE_PROFILE_SERVICE_CONTROL_CAPABILITIES = [
  "hr.workforce.activate_service",
  "hr.workforce.configure_service",
  "hr.workforce.deactivate_service",
  "hr.workforce.view_service_control",
] as const;
const WORKFORCE_PROFILE_CORE_CAPABILITIES = [
  "platform.evidence.append",
  "platform.policy.evaluate",
  "platform.tenant_transaction.run",
] as const;

function workforceProfileSemanticReadiness(
  activationMode: HrWorkforceProfileActivationMode,
): ActivationPreflight {
  if (activationMode === "production") {
    return { current: false, reasons: ["qualified_retention_evidence_unavailable"] };
  }
  const registered = new Set(
    hrManifest.capabilities.filter(({ exposure }) => exposure === "admin").map(({ id }) => id),
  );
  if (!WORKFORCE_PROFILE_SERVICE_CONTROL_CAPABILITIES.every((id) => registered.has(id))) {
    return { current: false, reasons: ["service_not_eligible"] };
  }
  const coreCapabilities = new Set(platformCoreManifest.capabilities.map(({ id }) => id));
  if (
    platformCoreManifest.activation !== "required" ||
    !hrManifest.dependencies.includes(platformCoreManifest.id) ||
    !WORKFORCE_PROFILE_CORE_CAPABILITIES.every((id) => coreCapabilities.has(id))
  ) {
    return { current: false, reasons: ["non_soft_dependency_not_eligible"] };
  }
  return { current: true, reasons: [] };
}

interface WorkforceProfileControlRow {
  readonly activation_state: "active" | "inactive";
  readonly activation_version: number;
  readonly employee_number_required: unknown;
  readonly employee_number_required_type: string | null;
  readonly employee_number_required_version: number | null;
  readonly manager_visibility: unknown;
  readonly manager_visibility_type: string | null;
  readonly manager_visibility_version: number | null;
  readonly row_version: number;
  readonly service_control_id: string;
  readonly service_key: string;
  readonly settings_version: number;
  readonly unlinked_worker_creation_allowed: unknown;
  readonly unlinked_worker_creation_allowed_type: string | null;
  readonly unlinked_worker_creation_allowed_version: number | null;
  readonly updated_at: Date | string;
}

interface WorkforceProfileControlSnapshot {
  readonly control: HrServiceControl;
  readonly serviceControlId: string;
}

function workforceControlConflict(): PlatformError {
  return new PlatformError(
    "ACTIVATION_CONFLICT",
    "Workforce Profile service control currentness check failed",
  );
}

function workforceControlFromRow(row: WorkforceProfileControlRow): WorkforceProfileControlSnapshot {
  const date = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  const settingRowsAbsent =
    row.employee_number_required === null &&
    row.employee_number_required_type === null &&
    row.employee_number_required_version === null &&
    row.manager_visibility === null &&
    row.manager_visibility_type === null &&
    row.manager_visibility_version === null &&
    row.unlinked_worker_creation_allowed === null &&
    row.unlinked_worker_creation_allowed_type === null &&
    row.unlinked_worker_creation_allowed_version === null;
  const settingRowsCurrent =
    row.settings_version > 1 &&
    row.employee_number_required_type === "boolean" &&
    row.employee_number_required_version === row.settings_version - 1 &&
    row.manager_visibility_type === "enum" &&
    row.manager_visibility_version === row.settings_version - 1 &&
    row.unlinked_worker_creation_allowed_type === "boolean" &&
    row.unlinked_worker_creation_allowed_version === row.settings_version - 1;
  if (
    row.service_key !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
    !Number.isSafeInteger(row.activation_version) ||
    row.activation_version < 1 ||
    !Number.isSafeInteger(row.settings_version) ||
    row.settings_version < 1 ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < 1 ||
    Number.isNaN(date.getTime()) ||
    (row.settings_version === 1 ? !settingRowsAbsent : !settingRowsCurrent)
  ) {
    throw workforceControlConflict();
  }
  try {
    return {
      control: parseHrServiceControl({
        activationState: row.activation_state,
        activationVersion: row.activation_version,
        serviceKey: row.service_key,
        settings:
          row.settings_version === 1
            ? defaultWorkforceProfileSettings()
            : {
                employeeNumberRequired: row.employee_number_required,
                managerVisibility: row.manager_visibility,
                unlinkedWorkerCreationAllowed: row.unlinked_worker_creation_allowed,
              },
        settingsVersion: row.settings_version,
        updatedAt: date.toISOString(),
        version: row.row_version,
      }),
      serviceControlId: row.service_control_id,
    };
  } catch {
    throw workforceControlConflict();
  }
}

async function readWorkforceProfileControl(
  transaction: TenantTransaction,
  expectedActivation: ServiceActivationResult | null,
): Promise<WorkforceProfileControlSnapshot | null> {
  const result = await transaction.client.query<WorkforceProfileControlRow>(
    `SELECT control.service_control_id,
            control.service_key,
            control.settings_version,
            control.updated_at,
            control.row_version,
            activation.state AS activation_state,
            activation.version AS activation_version,
            employee_number_required.value AS employee_number_required,
            employee_number_required.value_type AS employee_number_required_type,
            employee_number_required.version AS employee_number_required_version,
            manager_visibility.value AS manager_visibility,
            manager_visibility.value_type AS manager_visibility_type,
            manager_visibility.version AS manager_visibility_version,
            unlinked_worker_creation_allowed.value AS unlinked_worker_creation_allowed,
            unlinked_worker_creation_allowed.value_type AS unlinked_worker_creation_allowed_type,
            unlinked_worker_creation_allowed.version AS unlinked_worker_creation_allowed_version
     FROM hr_workforce_profile_service_control control
     JOIN service_activations activation
      ON activation.tenant_id = control.tenant_id
      AND activation.service_key = control.service_key
     LEFT JOIN tenant_settings employee_number_required
       ON employee_number_required.tenant_id = control.tenant_id
      AND employee_number_required.setting_key = $3
     LEFT JOIN tenant_settings manager_visibility
       ON manager_visibility.tenant_id = control.tenant_id
      AND manager_visibility.setting_key = $4
     LEFT JOIN tenant_settings unlinked_worker_creation_allowed
       ON unlinked_worker_creation_allowed.tenant_id = control.tenant_id
      AND unlinked_worker_creation_allowed.setting_key = $5
     WHERE control.tenant_id = $1 AND control.service_key = $2`,
    [
      transaction.context.tenantId,
      HR_WORKFORCE_PROFILE_SERVICE_KEY,
      workforceProfileSettings.employeeNumberRequired.key,
      workforceProfileSettings.managerVisibility.key,
      workforceProfileSettings.unlinkedWorkerCreationAllowed.key,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    if (expectedActivation) throw workforceControlConflict();
    const orphan = await transaction.client.query(
      `SELECT service_control_id
       FROM hr_workforce_profile_service_control
       WHERE tenant_id = $1 AND service_key = $2`,
      [transaction.context.tenantId, HR_WORKFORCE_PROFILE_SERVICE_KEY],
    );
    if (orphan.rows[0]) throw workforceControlConflict();
    return null;
  }
  const snapshot = workforceControlFromRow(row);
  if (
    !expectedActivation ||
    expectedActivation.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
    snapshot.control.activationState !== expectedActivation.state ||
    snapshot.control.activationVersion !== expectedActivation.version
  ) {
    throw workforceControlConflict();
  }
  return snapshot;
}

async function authorizeWorkforceProfile(
  transaction: TenantTransaction,
  action: "activate_service" | "configure_service" | "deactivate_service" | "view_service_control",
): Promise<PolicyDecision> {
  const input = { serviceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY };
  const actionKey = `hr.workforce.${action}`;
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "admin" && id === actionKey,
  );
  const capability = await transaction.client.query(
    `SELECT capability_id
     FROM membership_capabilities
     WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = $3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  const capabilityCurrent = registered && capability.rows.length === 1;
  const rules = [
    {
      effect: "allow" as const,
      id: `current_tenant_admin_${action}_workforce_profile`,
      matches: (_input: typeof input, actor: { roleKey: string }) =>
        actor.roleKey === "tenant_admin" && capabilityCurrent,
    },
  ];
  const decision = evaluatePolicy(
    {
      actionKey,
      input,
      resourceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
      transaction,
    },
    rules,
  );
  assertPolicyAllowed(decision, transaction, actionKey, HR_WORKFORCE_PROFILE_SERVICE_KEY);
  if (action === "configure_service" || action === "view_service_control") return decision;

  const lifecycleAction = action === "activate_service" ? "activate" : "deactivate";
  const platformActionKey = `platform.service_activation.${lifecycleAction}`;
  const platformDecision = evaluatePolicy(
    {
      actionKey: platformActionKey,
      input,
      resourceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
      transaction,
    },
    rules,
  );
  assertPolicyAllowed(
    platformDecision,
    transaction,
    platformActionKey,
    HR_WORKFORCE_PROFILE_SERVICE_KEY,
  );
  return platformDecision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultWorkforceProfileSettings(): HrWorkforceProfileSettings {
  return {
    employeeNumberRequired: workforceProfileSettings.employeeNumberRequired.defaultValue,
    managerVisibility: workforceProfileSettings.managerVisibility.defaultValue as
      | "minimized"
      | "none",
    unlinkedWorkerCreationAllowed:
      workforceProfileSettings.unlinkedWorkerCreationAllowed.defaultValue,
  };
}
function workforceProfileLegacyResponseSha256(control: HrServiceControl): string {
  return createHash("sha256")
    .update(
      [
        control.activationState,
        control.activationVersion,
        control.serviceKey,
        control.settingsVersion,
        control.updatedAt,
        control.version,
      ].join("\u001f"),
    )
    .digest("hex");
}
function workforceProfileResponseSha256(control: HrServiceControl): string {
  const settings = control.settings as HrWorkforceProfileSettings;
  return createHash("sha256")
    .update(
      JSON.stringify([
        control.activationState,
        control.activationVersion,
        control.serviceKey,
        settings.employeeNumberRequired,
        settings.managerVisibility,
        settings.unlinkedWorkerCreationAllowed,
        control.settingsVersion,
        control.updatedAt,
        control.version,
      ]),
    )
    .digest("hex");
}
function parseWorkforceProfileControlProof(value: unknown): {
  readonly control: HrServiceControl;
  readonly legacy: boolean;
} {
  if (!isRecord(value)) throw workforceControlConflict();
  const keys = Object.keys(value).sort();
  const legacyKeys = [
    "activationState",
    "activationVersion",
    "serviceKey",
    "settingsVersion",
    "updatedAt",
    "version",
  ].sort();
  const legacy =
    keys.length === legacyKeys.length && keys.every((key, index) => key === legacyKeys[index]);
  try {
    const control = parseHrServiceControl(
      legacy ? { ...value, settings: defaultWorkforceProfileSettings() } : value,
    );
    if (
      control.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
      (legacy && control.settingsVersion !== 1)
    ) {
      throw workforceControlConflict();
    }
    return { control, legacy };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw workforceControlConflict();
  }
}
function parseWorkforceProfileProof(
  value: unknown,
  expected: {
    readonly action: "activate_service" | "deactivate_service";
    readonly actorPrincipalId: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly tenantId: string;
    readonly targetState: "active" | "inactive";
  },
): { readonly control: HrServiceControl; readonly legacy: boolean } {
  if (!isRecord(value)) throw workforceControlConflict();
  const expectedKeys = [
    "action",
    "actorPrincipalId",
    "afterVersion",
    "aggregateId",
    "beforeVersion",
    "correlationId",
    "serviceControl",
    "tenantId",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    throw workforceControlConflict();
  }
  const beforeVersion = value.beforeVersion;
  if (
    value.action !== expected.action ||
    value.actorPrincipalId !== expected.actorPrincipalId ||
    value.aggregateId !== expected.aggregateId ||
    value.correlationId !== expected.correlationId ||
    value.tenantId !== expected.tenantId ||
    (beforeVersion !== null &&
      (!Number.isSafeInteger(beforeVersion) || (beforeVersion as number) < 1)) ||
    !Number.isSafeInteger(value.afterVersion) ||
    (value.afterVersion as number) < 1 ||
    (beforeVersion === null
      ? value.afterVersion !== 1
      : value.afterVersion !== (beforeVersion as number) + 1)
  ) {
    throw workforceControlConflict();
  }
  try {
    const proof = parseWorkforceProfileControlProof(value.serviceControl);
    const control = proof.control;
    if (
      control.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
      control.activationState !== expected.targetState ||
      control.version !== value.afterVersion
    ) {
      throw workforceControlConflict();
    }
    return proof;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw workforceControlConflict();
  }
}

async function readWorkforceProfileReplay(
  transaction: TenantTransaction,
  action: "activate_service" | "deactivate_service",
  targetState: "active" | "inactive",
): Promise<HrServiceControl> {
  const eventType =
    action === "activate_service"
      ? WORKFORCE_PROFILE_EVENT.activate
      : WORKFORCE_PROFILE_EVENT.deactivate;
  const replay = await transaction.client.query<{
    aggregate_id: string;
    aggregate_version: number;
    new_state: string;
    payload: unknown;
    prior_state: string | null;
    response_sha256: string;
  }>(
    `SELECT evidence.subject_id AS aggregate_id,
            evidence.prior_state,
            evidence.new_state,
            outbox.aggregate_version,
            outbox.payload,
            response_binding.new_state AS response_sha256
     FROM evidence_events evidence
     JOIN outbox_events outbox
       ON outbox.tenant_id = evidence.tenant_id
      AND outbox.aggregate_type = evidence.subject_type
      AND outbox.aggregate_id = evidence.subject_id
      AND outbox.correlation_id = evidence.correlation_id
     JOIN evidence_events response_binding
       ON response_binding.tenant_id = evidence.tenant_id
      AND response_binding.subject_type = evidence.subject_type
      AND response_binding.subject_id = evidence.subject_id
      AND response_binding.correlation_id = evidence.correlation_id
      AND response_binding.actor_principal_id = evidence.actor_principal_id
      AND response_binding.event_type = $6
     WHERE evidence.tenant_id = $1
       AND evidence.subject_type = $2
       AND evidence.event_type = $3
       AND evidence.correlation_id = $4
       AND evidence.actor_principal_id = $5
       AND outbox.event_type = $3
     ORDER BY outbox.aggregate_version
     LIMIT 2`,
    [
      transaction.context.tenantId,
      WORKFORCE_PROFILE_SUBJECT_TYPE,
      eventType,
      transaction.context.correlationId,
      transaction.context.actorPrincipalId,
      WORKFORCE_PROFILE_RESPONSE_BINDING_EVENT,
    ],
  );
  const row = replay.rows[0];
  if (
    replay.rows.length !== 1 ||
    !row ||
    row.new_state !== targetState ||
    row.prior_state !== (targetState === "active" ? "inactive" : "active")
  ) {
    throw workforceControlConflict();
  }
  const proof = parseWorkforceProfileProof(row.payload, {
    action,
    actorPrincipalId: transaction.context.actorPrincipalId,
    aggregateId: row.aggregate_id,
    correlationId: transaction.context.correlationId,
    targetState,
    tenantId: transaction.context.tenantId,
  });
  if (
    proof.control.version !== row.aggregate_version ||
    row.response_sha256 !==
      (proof.legacy
        ? workforceProfileLegacyResponseSha256(proof.control)
        : workforceProfileResponseSha256(proof.control))
  ) {
    throw workforceControlConflict();
  }
  return proof.control;
}

const WORKFORCE_PROFILE_CONFIGURE_RECEIPT_SUBJECT_TYPE =
  "hr.workforce_profile.service_control.idempotency";
const WORKFORCE_PROFILE_CONFIGURE_RESPONSE_BINDING_EVENT =
  "hr.workforce_profile.configure_service.response_bound";
function workforceProfileConfigureSemanticSha256(
  input: HrWorkforceProfileServiceConfigureInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.expectedSettingsVersion,
        input.settings.employeeNumberRequired,
        input.settings.managerVisibility,
        input.settings.unlinkedWorkerCreationAllowed,
      ]),
    )
    .digest("hex");
}
function workforceProfileSettingsSha256(
  settingsVersion: number,
  settings: HrWorkforceProfileSettings,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settingsVersion,
        settings.employeeNumberRequired,
        settings.managerVisibility,
        settings.unlinkedWorkerCreationAllowed,
      ]),
    )
    .digest("hex");
}
function workforceProfileConfigureReceiptId(transaction: TenantTransaction): string {
  return deriveStableUuid(
    "hr.workforce_profile.service_control.idempotency.v1",
    transaction.context.tenantId.toLowerCase(),
    transaction.context.actorPrincipalId.toLowerCase(),
    "configure_service",
    transaction.context.correlationId.toLowerCase(),
  );
}
function workforceProfileConfigureIdempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Workforce Profile settings data",
  );
}
function isPostgresCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
async function readWorkforceProfileConfigureReplay(
  transaction: TenantTransaction,
  input: HrWorkforceProfileServiceConfigureInput,
  receiptId: string,
  semanticSha256: string,
): Promise<HrServiceControl | null> {
  const binding = await transaction.client.query<{
    actor_principal_id: string;
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT actor_principal_id, correlation_id, prior_state, new_state
     FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3 AND event_type=$4
     ORDER BY occurred_at, evidence_event_id
     LIMIT 2`,
    [
      transaction.context.tenantId,
      WORKFORCE_PROFILE_CONFIGURE_RECEIPT_SUBJECT_TYPE,
      receiptId,
      WORKFORCE_PROFILE_CONFIGURE_RESPONSE_BINDING_EVENT,
    ],
  );
  if (binding.rows.length === 0) {
    const partial = await transaction.client.query<{
      evidence_count: number;
      outbox_count: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM evidence_events
          WHERE tenant_id=$1 AND subject_type=$2 AND event_type=$3
            AND subject_id=(SELECT service_control_id FROM hr_workforce_profile_service_control
                            WHERE tenant_id=$1 AND service_key='workforce_profile')
            AND correlation_id=$4 AND actor_principal_id=$5) AS evidence_count,
         (SELECT count(*)::integer FROM outbox_events
          WHERE tenant_id=$1 AND aggregate_type=$2 AND event_type=$3
            AND correlation_id=$4) AS outbox_count`,
      [
        transaction.context.tenantId,
        WORKFORCE_PROFILE_SUBJECT_TYPE,
        WORKFORCE_PROFILE_EVENT.configure,
        transaction.context.correlationId,
        transaction.context.actorPrincipalId,
      ],
    );
    const row = partial.rows[0];
    if ((row?.evidence_count ?? 0) !== 0 || (row?.outbox_count ?? 0) !== 0) {
      throw workforceProfileConfigureIdempotencyConflict();
    }
    return null;
  }
  const bound = binding.rows[0];
  if (
    binding.rows.length !== 1 ||
    !bound ||
    bound.actor_principal_id !== transaction.context.actorPrincipalId ||
    bound.correlation_id !== transaction.context.correlationId ||
    bound.prior_state !== semanticSha256
  ) {
    throw workforceProfileConfigureIdempotencyConflict();
  }
  const replay = await transaction.client.query<{
    aggregate_id: string;
    aggregate_version: number;
    correlation_id: string;
    payload: unknown;
  }>(
    `SELECT aggregate_id, aggregate_version, correlation_id, payload
     FROM outbox_events
     WHERE tenant_id=$1 AND event_type=$2 AND aggregate_type=$3 AND correlation_id=$4
     ORDER BY occurred_at, event_id
     LIMIT 2`,
    [
      transaction.context.tenantId,
      WORKFORCE_PROFILE_EVENT.configure,
      WORKFORCE_PROFILE_SUBJECT_TYPE,
      transaction.context.correlationId,
    ],
  );
  const row = replay.rows[0];
  if (replay.rows.length !== 1 || !row || !isRecord(row.payload)) {
    throw workforceProfileConfigureIdempotencyConflict();
  }
  const payload = row.payload;
  if (
    !exactKeys(payload, [
      "action",
      "actorPrincipalId",
      "afterSettingsSha256",
      "afterSettingsVersion",
      "aggregateId",
      "beforeSettingsSha256",
      "beforeSettingsVersion",
      "correlationId",
      "receiptId",
      "serviceControl",
      "tenantId",
    ]) ||
    payload.action !== "configure_service" ||
    payload.actorPrincipalId !== transaction.context.actorPrincipalId ||
    payload.tenantId !== transaction.context.tenantId ||
    payload.correlationId !== transaction.context.correlationId ||
    payload.receiptId !== receiptId ||
    payload.aggregateId !== row.aggregate_id ||
    typeof payload.beforeSettingsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.beforeSettingsSha256) ||
    typeof payload.afterSettingsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.afterSettingsSha256) ||
    payload.beforeSettingsVersion !== input.expectedSettingsVersion ||
    payload.afterSettingsVersion !== input.expectedSettingsVersion + 1
  ) {
    throw workforceProfileConfigureIdempotencyConflict();
  }
  try {
    const control = parseHrServiceControl(payload.serviceControl);
    const evidence = await transaction.client.query<{
      actor_principal_id: string;
      correlation_id: string;
      new_state: string;
      prior_state: string | null;
      subject_id: string;
    }>(
      `SELECT subject_id, actor_principal_id, correlation_id, prior_state, new_state
       FROM evidence_events
       WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$6 AND event_type=$3
         AND correlation_id=$4 AND actor_principal_id=$5
       ORDER BY occurred_at, evidence_event_id
       LIMIT 2`,
      [
        transaction.context.tenantId,
        WORKFORCE_PROFILE_SUBJECT_TYPE,
        WORKFORCE_PROFILE_EVENT.configure,
        transaction.context.correlationId,
        transaction.context.actorPrincipalId,
        row.aggregate_id,
      ],
    );
    const proof = evidence.rows[0];
    if (
      evidence.rows.length !== 1 ||
      !proof ||
      proof.subject_id !== row.aggregate_id ||
      proof.prior_state !== payload.beforeSettingsSha256 ||
      proof.new_state !== payload.afterSettingsSha256 ||
      control.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
      control.settingsVersion !== payload.afterSettingsVersion ||
      control.version !== row.aggregate_version ||
      (control.settings as HrWorkforceProfileSettings).employeeNumberRequired !==
        input.settings.employeeNumberRequired ||
      (control.settings as HrWorkforceProfileSettings).managerVisibility !==
        input.settings.managerVisibility ||
      (control.settings as HrWorkforceProfileSettings).unlinkedWorkerCreationAllowed !==
        input.settings.unlinkedWorkerCreationAllowed ||
      payload.afterSettingsSha256 !==
        workforceProfileSettingsSha256(
          control.settingsVersion,
          control.settings as HrWorkforceProfileSettings,
        ) ||
      bound.new_state !== workforceProfileResponseSha256(control)
    ) {
      throw workforceProfileConfigureIdempotencyConflict();
    }
    return control;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw workforceProfileConfigureIdempotencyConflict();
  }
}
export async function configureWorkforceProfileService(
  runtimePool: Pool,
  context: OperationContext,
  input: HrWorkforceProfileServiceConfigureInput,
): Promise<HrWorkforceProfileServiceControlResult> {
  if (
    !isRecord(input) ||
    !exactKeys(input, ["expectedSettingsVersion", "settings"]) ||
    !Number.isSafeInteger(input.expectedSettingsVersion) ||
    input.expectedSettingsVersion < 1 ||
    input.expectedSettingsVersion > 2_147_483_647 ||
    !isRecord(input.settings) ||
    !exactKeys(input.settings, [
      "employeeNumberRequired",
      "managerVisibility",
      "unlinkedWorkerCreationAllowed",
    ]) ||
    typeof input.settings.employeeNumberRequired !== "boolean" ||
    (input.settings.managerVisibility !== "minimized" &&
      input.settings.managerVisibility !== "none") ||
    typeof input.settings.unlinkedWorkerCreationAllowed !== "boolean"
  ) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_INPUT_INVALID",
      "Workforce Profile settings input is invalid",
    );
  }
  const normalizedContext = {
    actorPrincipalId: context.actorPrincipalId.toLowerCase(),
    correlationId: context.correlationId.toLowerCase(),
    tenantId: context.tenantId.toLowerCase(),
  };
  return await withTenantTransaction(
    runtimePool,
    normalizedContext,
    async (transaction) => {
      const activation = transaction.lockedServiceActivation;
      await authorizeWorkforceProfile(transaction, "configure_service");
      if (
        activation?.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
        activation.state !== "active"
      ) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_SERVICE_INACTIVE",
          "Workforce Profile service is inactive",
        );
      }
      const receiptId = workforceProfileConfigureReceiptId(transaction);
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))",
        [receiptId],
      );
      await transaction.client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))",
        [`hr.workforce_profile.settings.v1:${transaction.context.tenantId}`],
      );
      const semanticSha256 = workforceProfileConfigureSemanticSha256(input);
      const replay = await readWorkforceProfileConfigureReplay(
        transaction,
        input,
        receiptId,
        semanticSha256,
      );
      if (replay) {
        return {
          billingState: HR_WORKFORCE_PROFILE_BILLING_STATE,
          control: replay,
          replayed: true,
        };
      }

      try {
        await transaction.client.query(
          `SELECT public.esbla_configure_hr_workforce_profile_settings($1, $2, $3, $4)`,
          [
            input.expectedSettingsVersion,
            input.settings.employeeNumberRequired,
            input.settings.managerVisibility,
            input.settings.unlinkedWorkerCreationAllowed,
          ],
        );
      } catch (error) {
        if (isPostgresCode(error, "22023") || isPostgresCode(error, "22003")) {
          throw new HrWorkforceProfileError(
            "WORKFORCE_INPUT_INVALID",
            "Workforce Profile settings input is invalid",
          );
        }
        if (isPostgresCode(error, "42501")) {
          throw new PlatformError(
            "POLICY_DENIED",
            "The actor is not authorized for this Workforce Profile action",
          );
        }
        if (isPostgresCode(error, "55000")) {
          throw workforceControlConflict();
        }
        if (
          isPostgresCode(error, "40001") ||
          isPostgresCode(error, "40P01") ||
          isPostgresCode(error, "55P03")
        ) {
          throw workforceControlConflict();
        }
        throw error;
      }
      const created = await readWorkforceProfileConfigureReplay(
        transaction,
        input,
        receiptId,
        semanticSha256,
      );
      if (!created) throw workforceControlConflict();
      return {
        billingState: HR_WORKFORCE_PROFILE_BILLING_STATE,
        control: created,
        replayed: false,
      };
    },
    {
      serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
      serviceActivationLock: "share",
    },
  );
}

async function runWorkforceProfileLifecycle(
  transaction: TenantTransaction,
  input: HrWorkforceProfileServiceLifecycleInput,
  action: "activate_service" | "deactivate_service",
  targetState: "active" | "inactive",
  preflight?: () => Promise<ActivationPreflight>,
): Promise<HrWorkforceProfileServiceControlResult> {
  const authorization = await authorizeWorkforceProfile(transaction, action);
  const expectedActivation = transaction.lockedServiceActivation
    ? { ...transaction.lockedServiceActivation, replayed: false }
    : null;
  const before = await readWorkforceProfileControl(transaction, expectedActivation);
  const result = await setServiceActivation(transaction, {
    authorization,
    evidenceEventType:
      action === "activate_service"
        ? "evidence.hr.workforce_profile.service.activated"
        : "evidence.hr.workforce_profile.service.deactivated",
    expectedVersion: input.expectedVersion,
    outboxEventType: INTERNAL_ACTIVATION_OUTBOX_EVENT_TYPE,
    ...(preflight ? { preflight } : {}),
    serviceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
    targetState,
  });
  if (result.replayed) {
    return {
      billingState: HR_WORKFORCE_PROFILE_BILLING_STATE,
      control: await readWorkforceProfileReplay(transaction, action, targetState),
      replayed: true,
    };
  }

  const after = await readWorkforceProfileControl(transaction, result);
  if (!after || after.control.version !== (before?.control.version ?? 0) + 1) {
    throw workforceControlConflict();
  }
  const eventType =
    action === "activate_service"
      ? WORKFORCE_PROFILE_EVENT.activate
      : WORKFORCE_PROFILE_EVENT.deactivate;
  const payload = {
    action,
    actorPrincipalId: transaction.context.actorPrincipalId,
    afterVersion: after.control.version,
    aggregateId: after.serviceControlId,
    beforeVersion: before?.control.version ?? null,
    correlationId: transaction.context.correlationId,
    serviceControl: after.control,
    tenantId: transaction.context.tenantId,
  };
  await recordMutationProof(transaction, {
    evidence: {
      eventType,
      newState: targetState,
      priorState: before?.control.activationState ?? "inactive",
      subjectId: after.serviceControlId,
      subjectType: WORKFORCE_PROFILE_SUBJECT_TYPE,
    },
    outbox: {
      aggregateId: after.serviceControlId,
      aggregateType: WORKFORCE_PROFILE_SUBJECT_TYPE,
      aggregateVersion: after.control.version,
      eventType,
      payload,
    },
  });
  await appendEvidence(transaction, {
    eventType: WORKFORCE_PROFILE_RESPONSE_BINDING_EVENT,
    newState: workforceProfileResponseSha256(after.control),
    priorState: null,
    subjectId: after.serviceControlId,
    subjectType: WORKFORCE_PROFILE_SUBJECT_TYPE,
  });
  return {
    billingState: HR_WORKFORCE_PROFILE_BILLING_STATE,
    control: after.control,
    replayed: false,
  };
}

export async function getWorkforceProfileServiceControl(
  runtimePool: Pool,
  context: OperationContext,
): Promise<HrWorkforceProfileServiceControlResult> {
  return await withTenantTransaction(
    runtimePool,
    context,
    async (transaction) => {
      await authorizeWorkforceProfile(transaction, "view_service_control");
      const expectedActivation = transaction.lockedServiceActivation
        ? { ...transaction.lockedServiceActivation, replayed: false }
        : null;
      const control = await readWorkforceProfileControl(transaction, expectedActivation);
      if (!control) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_SERVICE_CONTROL_NOT_FOUND",
          "Workforce Profile service control was not found",
        );
      }
      return {
        billingState: HR_WORKFORCE_PROFILE_BILLING_STATE,
        control: control.control,
        replayed: false,
      };
    },
    {
      serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
      serviceActivationLock: "share",
    },
  );
}

async function probeWorkforceProfileActivationReplay(
  runtimePool: Pool,
  migrationReadPool: Pool,
  context: OperationContext,
  input: HrWorkforceProfileServiceLifecycleInput,
): Promise<HrWorkforceProfileServiceControlResult | null> {
  const preflightRequired = new Error("Workforce Profile activation readiness phase is required");
  try {
    return await withTenantTransaction(
      runtimePool,
      context,
      async (transaction) =>
        await runWorkforceProfileLifecycle(
          transaction,
          input,
          "activate_service",
          "active",
          async () => {
            if (runtimePool === migrationReadPool) {
              return { current: false, reasons: ["migration_reader_not_isolated"] };
            }
            throw preflightRequired;
          },
        ),
      {
        migrationBarrier: "shared",
        serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
        serviceActivationLock: "update",
      },
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
  input: HrWorkforceProfileServiceLifecycleInput,
  activationMode: HrWorkforceProfileActivationMode,
): Promise<HrWorkforceProfileServiceControlResult> {
  const replay = await probeWorkforceProfileActivationReplay(
    runtimePool,
    migrationReadPool,
    context,
    input,
  );
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
        await runWorkforceProfileLifecycle(
          transaction,
          input,
          "activate_service",
          "active",
          async () => {
            const client = migrationClient;
            if (!client) return { current: false, reasons: ["migration_ledger_unavailable"] };
            migrationClient = null;
            return inspectActivationReadiness(transaction, client, {
              catalog: HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS,
              migrations: HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS,
              runtimeTablePrivileges: HR_WORKFORCE_PROFILE_RUNTIME_TABLE_PRIVILEGES,
              semantic: workforceProfileSemanticReadiness(activationMode),
            });
          },
        ),
      {
        migrationBarrier: "shared",
        serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
        serviceActivationLock: "update",
      },
    );
  } finally {
    migrationClient?.release();
  }
}

export async function deactivateWorkforceProfileService(
  runtimePool: Pool,
  context: OperationContext,
  input: HrWorkforceProfileServiceLifecycleInput,
): Promise<HrWorkforceProfileServiceControlResult> {
  return await withTenantTransaction(
    runtimePool,
    context,
    async (transaction) =>
      await runWorkforceProfileLifecycle(transaction, input, "deactivate_service", "inactive"),
    {
      serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
      serviceActivationLock: "update",
    },
  );
}
