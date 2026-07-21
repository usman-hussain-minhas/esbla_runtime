import { createHash } from "node:crypto";
import { type HrServiceControl, parseHrServiceControl } from "@esbla/contracts";
import {
  type ActivationPreflight,
  appendEvidence,
  assertPolicyAllowed,
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
import { hrManifest } from "./manifest.js";
import { HR_LEAVE_BILLING_STATE, HR_LEAVE_SERVICE_KEY } from "./types.js";
export interface HrLeaveServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export interface HrLeaveServiceLifecycleResult extends ServiceActivationResult {
  readonly billingState: typeof HR_LEAVE_BILLING_STATE;
}
export const HR_WORKFORCE_PROFILE_SERVICE_KEY = "workforce_profile" as const;
export const HR_WORKFORCE_PROFILE_BILLING_STATE = "non_billable" as const;
export interface HrWorkforceProfileServiceLifecycleInput {
  readonly expectedVersion: number | null;
}
export type HrWorkforceProfileActivationMode = "non_production" | "production";
export interface HrWorkforceProfileServiceControlResult {
  readonly billingState: typeof HR_WORKFORCE_PROFILE_BILLING_STATE;
  readonly control: HrServiceControl;
  readonly replayed: boolean;
}
export type HrWorkforceProfileErrorCode = "WORKFORCE_SERVICE_CONTROL_NOT_FOUND";
export class HrWorkforceProfileError extends Error {
  readonly code: HrWorkforceProfileErrorCode;

  constructor(code: HrWorkforceProfileErrorCode, message: string) {
    super(message);
    this.name = "HrWorkforceProfileError";
    this.code = code;
  }
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
const HR_LEAVE_REQUIRED_MIGRATIONS = [
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
const HR_LEAVE_CATALOG_REQUIREMENTS = {
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
const HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS = [
  ...HR_LEAVE_REQUIRED_MIGRATIONS.filter(({ id }) => id !== "0003"),
  {
    createdAt: 1784620421352,
    hash: "f6ecf5aeedb02686452a2855d96382383a1dc95e0514814c03773fb94fb92dde",
    id: "0006",
  },
  {
    createdAt: 1784622496162,
    hash: "ab19d8b130e9f7b0ced46181e07cacadbefe6fcaa9126212a432dd00c6e84b53",
    id: "0007",
  },
] as const;
const HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS = {
  tables: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.tables.filter(({ name }) => name !== "hr_leave_requests"),
    { name: "hr_workforce_profile_service_control" },
    { name: "membership_capabilities" },
  ],
  columns: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.columns.filter(({ parent }) => parent !== "hr_leave_requests"),
    ...[
      "service_activations|service_key|text|1|",
      "service_activations|state|public.service_activation_state|1|'inactive'::public.service_activation_state",
      "service_activations|version|integer|1|1",
      "hr_workforce_profile_service_control|service_control_id|uuid|1|gen_random_uuid()",
      "hr_workforce_profile_service_control|tenant_id|uuid|1|",
      "hr_workforce_profile_service_control|service_key|text|1|'workforce_profile'::text",
      "hr_workforce_profile_service_control|settings_version|integer|1|1",
      "hr_workforce_profile_service_control|updated_at|timestamp with time zone|1|now()",
      "hr_workforce_profile_service_control|row_version|integer|1|1",
      "membership_capabilities|tenant_id|uuid|1|",
      "membership_capabilities|principal_id|uuid|1|",
      "membership_capabilities|capability_id|text|1|",
    ].map((entry) => {
      const [parent, name, type, notNull, defaultExpression] = entry.split("|");
      return { defaultExpression, name, notNull: notNull === "1", parent, type };
    }),
  ],
  indexes: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.indexes.filter(({ parent }) => parent !== "hr_leave_requests"),
    {
      constraintType: "p",
      definition:
        "CREATE UNIQUE INDEX hr_workforce_profile_service_control_pkey ON public.hr_workforce_profile_service_control USING btree (service_control_id)",
      name: "hr_workforce_profile_service_control_pkey",
      parent: "hr_workforce_profile_service_control",
      predicate: "",
      primary: true,
      unique: true,
    },
    {
      constraintType: "p",
      definition:
        "CREATE UNIQUE INDEX membership_capabilities_pk ON public.membership_capabilities USING btree (tenant_id, principal_id, capability_id)",
      name: "membership_capabilities_pk",
      parent: "membership_capabilities",
      predicate: "",
      primary: true,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE UNIQUE INDEX uq_hr_workforce_profile_service_control_tenant_key ON public.hr_workforce_profile_service_control USING btree (tenant_id, service_key)",
      name: "uq_hr_workforce_profile_service_control_tenant_key",
      parent: "hr_workforce_profile_service_control",
      predicate: "",
      primary: false,
      unique: true,
    },
  ],
  policies: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.policies.filter(
      ({ parent }) => parent !== "hr_leave_requests",
    ),
    {
      name: "hr_workforce_profile_service_control_tenant_isolation",
      parent: "hr_workforce_profile_service_control",
    },
    {
      name: "membership_capabilities_tenant_isolation",
      parent: "membership_capabilities",
    },
  ],
  triggers: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.triggers.filter(
      ({ parent }) => parent !== "hr_leave_requests",
    ),
    {
      definition:
        "CREATE TRIGGER hr_workforce_profile_service_control_enforce_state BEFORE INSERT OR DELETE OR UPDATE ON public.hr_workforce_profile_service_control FOR EACH ROW EXECUTE FUNCTION public.esbla_enforce_hr_workforce_profile_service_control()",
      functionName: "esbla_enforce_hr_workforce_profile_service_control",
      name: "hr_workforce_profile_service_control_enforce_state",
      parent: "hr_workforce_profile_service_control",
    },
    {
      definition:
        "CREATE TRIGGER hr_workforce_profile_service_control_reject_truncate BEFORE TRUNCATE ON public.hr_workforce_profile_service_control FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_enforce_hr_workforce_profile_service_control()",
      functionName: "esbla_enforce_hr_workforce_profile_service_control",
      name: "hr_workforce_profile_service_control_reject_truncate",
      parent: "hr_workforce_profile_service_control",
    },
    {
      definition:
        "CREATE TRIGGER service_activations_sync_hr_workforce_profile AFTER INSERT OR UPDATE ON public.service_activations FOR EACH ROW EXECUTE FUNCTION public.esbla_sync_hr_workforce_profile_service_activation()",
      functionName: "esbla_sync_hr_workforce_profile_service_activation",
      name: "service_activations_sync_hr_workforce_profile",
      parent: "service_activations",
    },
    {
      definition:
        "CREATE TRIGGER membership_capabilities_guard_authority BEFORE INSERT OR DELETE OR UPDATE ON public.membership_capabilities FOR EACH ROW EXECUTE FUNCTION public.esbla_guard_membership_capability_authority()",
      functionName: "esbla_guard_membership_capability_authority",
      name: "membership_capabilities_guard_authority",
      parent: "membership_capabilities",
    },
    {
      definition:
        "CREATE TRIGGER membership_capabilities_reject_truncate BEFORE TRUNCATE ON public.membership_capabilities FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_guard_membership_capability_authority()",
      functionName: "esbla_guard_membership_capability_authority",
      name: "membership_capabilities_reject_truncate",
      parent: "membership_capabilities",
    },
  ],
  constraints: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.constraints.filter(
      ({ parent }) => parent !== "hr_leave_requests",
    ),
    ...[
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_pkey|p|PRIMARY KEY (service_control_id)",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_activation_fk|f|FOREIGN KEY (tenant_id, service_key) REFERENCES public.service_activations(tenant_id, service_key) ON DELETE RESTRICT",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_key_exact|c|CHECK (service_key = 'workforce_profile'::text)",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_settings_version_positive|c|CHECK (settings_version > 0)",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_row_version_positive|c|CHECK (row_version > 0)",
      "membership_capabilities|membership_capabilities_pk|p|PRIMARY KEY (tenant_id, principal_id, capability_id)",
      "membership_capabilities|membership_capabilities_membership_fk|f|FOREIGN KEY (tenant_id, principal_id) REFERENCES public.memberships(tenant_id, principal_id) ON DELETE RESTRICT",
      "membership_capabilities|membership_capabilities_id_not_blank|c|CHECK (char_length(TRIM(BOTH FROM capability_id)) > 0)",
    ].map((entry) => {
      const [parent, name, type, definition] = entry.split("|");
      return { definition, name, parent, type };
    }),
  ],
  functions: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.functions.filter(
      ({ name }) => name !== "esbla_enforce_hr_leave_state",
    ),
    {
      config: "search_path=pg_catalog, public",
      language: "plpgsql",
      name: "esbla_enforce_hr_workforce_profile_service_control",
      publicExecutable: false,
      returnType: "trigger",
      securityDefiner: false,
      sourceSha256: "c68a506da19fa24dd30e1b4ca1fe53becf4d5f90e73ca4b768594ca05ed14fd5",
      volatility: "v",
    },
    {
      config: "search_path=pg_catalog, public",
      language: "plpgsql",
      name: "esbla_sync_hr_workforce_profile_service_activation",
      publicExecutable: false,
      returnType: "trigger",
      securityDefiner: true,
      sourceSha256: "60f6a2181da37375771c83a4ed41eed10ca66c083d81df9898610744877e505b",
      volatility: "v",
    },
    {
      config: "search_path=pg_catalog, public",
      language: "plpgsql",
      name: "esbla_guard_membership_capability_authority",
      publicExecutable: false,
      returnType: "trigger",
      securityDefiner: true,
      sourceSha256: "ffc08b59c0bedd3ee08cba3106cd2f46bcec595866500b97cbc428740c2e450f",
      volatility: "v",
    },
  ],
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
  requirements: {
    readonly catalog: typeof HR_LEAVE_CATALOG_REQUIREMENTS;
    readonly migrations: readonly {
      readonly createdAt: number;
      readonly hash: string;
      readonly id: string;
    }[];
    readonly selectOnlyRuntimeTables?: readonly string[];
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

    if (requirements.selectOnlyRuntimeTables) {
      failureReason = "runtime_projection_privileges_not_current";
      const privilege = await transaction.client.query<{
        bypass_rls: boolean;
        can_delete: boolean;
        can_insert: boolean;
        can_insert_column: boolean;
        can_select: boolean;
        can_truncate: boolean;
        can_update: boolean;
        can_update_column: boolean;
        superuser: boolean;
      }>(
        `SELECT role.rolsuper AS superuser,
                role.rolbypassrls AS bypass_rls,
                pg_catalog.bool_and(
                  pg_catalog.has_table_privilege(current_user, required.name, 'SELECT')
                ) AS can_select,
                pg_catalog.bool_or(
                  pg_catalog.has_table_privilege(current_user, required.name, 'INSERT')
                ) AS can_insert,
                pg_catalog.bool_or(
                  pg_catalog.has_any_column_privilege(current_user, required.name, 'INSERT')
                ) AS can_insert_column,
                pg_catalog.bool_or(
                  pg_catalog.has_table_privilege(current_user, required.name, 'UPDATE')
                ) AS can_update,
                pg_catalog.bool_or(
                  pg_catalog.has_any_column_privilege(current_user, required.name, 'UPDATE')
                ) AS can_update_column,
                pg_catalog.bool_or(
                  pg_catalog.has_table_privilege(current_user, required.name, 'DELETE')
                ) AS can_delete,
                pg_catalog.bool_or(
                  pg_catalog.has_table_privilege(current_user, required.name, 'TRUNCATE')
                ) AS can_truncate
         FROM pg_catalog.pg_roles role,
              pg_catalog.unnest($1::text[]) AS required(name)
         WHERE role.rolname = current_user
         GROUP BY role.rolsuper, role.rolbypassrls`,
        [requirements.selectOnlyRuntimeTables],
      );
      const row = privilege.rows[0];
      if (
        !row ||
        row.superuser ||
        row.bypass_rls ||
        !row.can_select ||
        row.can_insert ||
        row.can_insert_column ||
        row.can_update ||
        row.can_update_column ||
        row.can_delete ||
        row.can_truncate
      ) {
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
         ) actual ON true

         UNION ALL
         SELECT COALESCE(actual.current, false)
         FROM requirements,
              pg_catalog.jsonb_to_recordset(value -> 'functions') AS required(
                name text, language text, "returnType" text, "sourceSha256" text,
                volatility text, config text, "securityDefiner" boolean,
                "publicExecutable" boolean
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
  deactivate: "hr.workforce_profile.deactivate_service",
} as const;
const WORKFORCE_PROFILE_RESPONSE_BINDING_EVENT =
  "hr.workforce_profile.service_control.response_bound";
const WORKFORCE_PROFILE_SERVICE_CONTROL_CAPABILITIES = [
  "hr.workforce.activate_service",
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
  readonly row_version: number;
  readonly service_control_id: string;
  readonly service_key: string;
  readonly settings_version: number;
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
  if (
    row.service_key !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
    !Number.isSafeInteger(row.activation_version) ||
    row.activation_version < 1 ||
    !Number.isSafeInteger(row.settings_version) ||
    row.settings_version < 1 ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < 1 ||
    Number.isNaN(date.getTime())
  ) {
    throw workforceControlConflict();
  }
  try {
    return {
      control: parseHrServiceControl({
        activationState: row.activation_state,
        activationVersion: row.activation_version,
        serviceKey: row.service_key,
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
            activation.version AS activation_version
     FROM hr_workforce_profile_service_control control
     JOIN service_activations activation
       ON activation.tenant_id = control.tenant_id
      AND activation.service_key = control.service_key
     WHERE control.tenant_id = $1 AND control.service_key = $2`,
    [transaction.context.tenantId, HR_WORKFORCE_PROFILE_SERVICE_KEY],
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
  action: "activate_service" | "deactivate_service" | "view_service_control",
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
  if (action === "view_service_control") return decision;

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

function workforceProfileResponseSha256(control: HrServiceControl): string {
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
): HrServiceControl {
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
    const control = parseHrServiceControl(value.serviceControl);
    if (
      control.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
      control.activationState !== expected.targetState ||
      control.version !== value.afterVersion
    ) {
      throw workforceControlConflict();
    }
    return control;
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
  const control = parseWorkforceProfileProof(row.payload, {
    action,
    actorPrincipalId: transaction.context.actorPrincipalId,
    aggregateId: row.aggregate_id,
    correlationId: transaction.context.correlationId,
    targetState,
    tenantId: transaction.context.tenantId,
  });
  if (
    control.version !== row.aggregate_version ||
    row.response_sha256 !== workforceProfileResponseSha256(control)
  ) {
    throw workforceControlConflict();
  }
  return control;
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
              selectOnlyRuntimeTables: [
                "public.hr_workforce_profile_service_control",
                "public.membership_capabilities",
              ],
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
