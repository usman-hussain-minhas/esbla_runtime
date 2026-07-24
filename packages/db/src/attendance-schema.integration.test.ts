import type { Pool, PoolClient, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  actor: "16000000-0000-4000-8000-000000000001",
  correlation: "56000000-0000-4000-8000-000000000001",
  hrActor: "16000000-0000-4000-8000-000000000003",
  hrMembership: "26000000-0000-4000-8000-000000000003",
  membership: "26000000-0000-4000-8000-000000000001",
  otherActor: "16000000-0000-4000-8000-000000000002",
  otherMembership: "26000000-0000-4000-8000-000000000002",
  otherTenant: "08000000-0000-4000-8000-000000000002",
  tenant: "08000000-0000-4000-8000-000000000001",
} as const;

let applicationRole = "";
let migrationPool: Pool;
let pool: Pool;
let workerProfileId = "";

type CorrectionRow = {
  actor_principal_id: string;
  attendance_correction_id: string;
  correction_version: number;
};

async function tenantTransaction<T>(
  source: Pool,
  tenantId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await source.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id',$1,true)", [actorId]);
    await client.query("SELECT set_config('app.correlation_id',$1,true)", [ids.correlation]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function databaseError(
  operation: () => Promise<unknown>,
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  await expect(operation()).rejects.toMatchObject(expected);
}

async function appendCorrection(
  client: PoolClient,
  observationId: string,
  version: number,
  predecessor: string | null,
  reason: string,
): Promise<QueryResult<CorrectionRow>> {
  return client.query(
    `INSERT INTO hr_attendance_corrections
       (tenant_id,attendance_observation_id,corrected_observed_at,
        corrected_observation_kind,reason,correction_version,
        supersedes_attendance_correction_id)
     VALUES ($1,$2,'2027-01-10T08:05:00Z','presence_start',$3,$4,$5)
     RETURNING attendance_correction_id::text,actor_principal_id::text,correction_version`,
    [ids.tenant, observationId, reason, version, predecessor],
  );
}

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL harness environment is required");
  }

  migrationPool = createDatabasePool(migrationUrl, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  pool = createDatabasePool(runtimeUrl, { max: 4 });
  await migrationPool.query(`GRANT SELECT, UPDATE ON service_activations TO ${applicationRole}`);
  await migrationPool.query(`GRANT SELECT, UPDATE ON hr_worker_profiles TO ${applicationRole}`);

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Attendance Tenant'),($2,'Other Attendance Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Attendance Administrator'),($2,'Other Attendance Actor'),
            ($3,'Attendance HR Operator')`,
    [ids.actor, ids.otherActor, ids.hrActor],
  );
  await tenantTransaction(migrationPool, ids.tenant, ids.actor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'tenant_admin')`,
      [ids.membership, ids.tenant, ids.actor],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'hr.attendance.configure_service')`,
      [ids.tenant, ids.actor],
    );
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'hr_operator')`,
      [ids.hrMembership, ids.tenant, ids.hrActor],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'hr.attendance.record_manual'),
              ($1,$2,'hr.attendance.correct')`,
      [ids.tenant, ids.hrActor],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),($1,'attendance','active',1)`,
      [ids.tenant],
    );
    const worker = await client.query<{ worker_profile_id: string }>(
      `INSERT INTO hr_worker_profiles (tenant_id)
       VALUES ($1) RETURNING worker_profile_id::text`,
      [ids.tenant],
    );
    workerProfileId = worker.rows[0]?.worker_profile_id ?? "";
    await client.query(
      `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId, ids.hrActor],
    );
    await client.query(
      `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId],
    );
  });
  await tenantTransaction(migrationPool, ids.otherTenant, ids.otherActor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'hr_operator')`,
      [ids.otherMembership, ids.otherTenant, ids.otherActor],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),($1,'attendance','active',1)`,
      [ids.otherTenant],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'hr.attendance.record_manual')`,
      [ids.otherTenant, ids.otherActor],
    );
  });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("Attendance persistence kernel", () => {
  it("installs exact tenant-owned storage, indexes, forced RLS, and least privilege", async () => {
    const tables = await migrationPool.query<{ force_rls: boolean; name: string; rls: boolean }>(
      `SELECT relname AS name,relrowsecurity AS rls,relforcerowsecurity AS force_rls
       FROM pg_catalog.pg_class
       WHERE oid = ANY(ARRAY[
         'public.hr_attendance_corrections'::regclass,
         'public.hr_attendance_observations'::regclass,
         'public.hr_attendance_service_control'::regclass
       ]) ORDER BY relname`,
    );
    expect(tables.rows).toEqual([
      { force_rls: true, name: "hr_attendance_corrections", rls: true },
      { force_rls: true, name: "hr_attendance_observations", rls: true },
      { force_rls: true, name: "hr_attendance_service_control", rls: true },
    ]);

    const enums = await migrationPool.query<{ definition: string }>(
      `SELECT typname || ':' || string_agg(enumlabel,',' ORDER BY enumsortorder) definition
       FROM pg_catalog.pg_type JOIN pg_catalog.pg_enum ON enumtypid=pg_type.oid
       WHERE typname=ANY($1::text[]) GROUP BY typname ORDER BY typname`,
      [["hr_attendance_observation_kind", "hr_attendance_source_kind"]],
    );
    expect(enums.rows.map(({ definition }) => definition)).toEqual([
      "hr_attendance_observation_kind:presence_start,presence_end",
      "hr_attendance_source_kind:manual,synthetic",
    ]);

    const indexes = await migrationPool.query<{ definition: string; name: string }>(
      `SELECT indexname name,indexdef definition FROM pg_catalog.pg_indexes
       WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
      [
        [
          "idx_hr_attendance_corrections_tenant_observation_version",
          "idx_hr_attendance_observations_tenant_worker_observed",
          "uq_hr_attendance_corrections_tenant_observation_version",
          "uq_hr_attendance_corrections_tenant_successor",
          "uq_hr_attendance_service_control_tenant_key",
        ],
      ],
    );
    expect(indexes.rows.map(({ definition }) => definition)).toEqual([
      "CREATE INDEX idx_hr_attendance_corrections_tenant_observation_version ON public.hr_attendance_corrections USING btree (tenant_id, attendance_observation_id, correction_version DESC NULLS LAST, attendance_correction_id DESC NULLS LAST)",
      "CREATE INDEX idx_hr_attendance_observations_tenant_worker_observed ON public.hr_attendance_observations USING btree (tenant_id, worker_profile_id, observed_at DESC NULLS LAST, attendance_observation_id DESC NULLS LAST)",
      "CREATE UNIQUE INDEX uq_hr_attendance_corrections_tenant_observation_version ON public.hr_attendance_corrections USING btree (tenant_id, attendance_observation_id, correction_version)",
      "CREATE UNIQUE INDEX uq_hr_attendance_corrections_tenant_successor ON public.hr_attendance_corrections USING btree (tenant_id, supersedes_attendance_correction_id) WHERE (supersedes_attendance_correction_id IS NOT NULL)",
      "CREATE UNIQUE INDEX uq_hr_attendance_service_control_tenant_key ON public.hr_attendance_service_control USING btree (tenant_id, service_key)",
    ]);

    const privileges = await migrationPool.query<{
      delete: boolean;
      insert: boolean;
      name: string;
      select: boolean;
      truncate: boolean;
      update: boolean;
    }>(
      `SELECT table_name name,
              has_table_privilege($1,table_name,'SELECT') "select",
              has_table_privilege($1,table_name,'INSERT') "insert",
              has_table_privilege($1,table_name,'UPDATE') "update",
              has_table_privilege($1,table_name,'DELETE') "delete",
              has_table_privilege($1,table_name,'TRUNCATE') "truncate"
       FROM unnest($2::text[]) table_name ORDER BY table_name`,
      [
        applicationRole,
        [
          "hr_attendance_corrections",
          "hr_attendance_observations",
          "hr_attendance_service_control",
        ],
      ],
    );
    expect(
      privileges.rows.map(({ name, select, insert, update, delete: remove, truncate }) =>
        [name, select, insert, update, remove, truncate].join(":"),
      ),
    ).toEqual([
      "hr_attendance_corrections:true:true:false:false:false",
      "hr_attendance_observations:true:true:false:false:false",
      "hr_attendance_service_control:true:false:false:false:false",
    ]);
    const functionAcl = await migrationPool.query(
      `SELECT has_function_privilege('public',
                'public.esbla_configure_hr_attendance_settings(integer,text,boolean)','EXECUTE')
                AS public_execute,
              has_function_privilege($1,
                'public.esbla_configure_hr_attendance_settings(integer,text,boolean)','EXECUTE')
                AS app_execute`,
      [applicationRole],
    );
    expect(functionAcl.rows).toEqual([{ app_execute: true, public_execute: false }]);
  });

  it("keeps source observations immutable and appends one exact correction chain", async () => {
    const created = await tenantTransaction(pool, ids.tenant, ids.hrActor, async (client) => {
      const observation = await client.query<{
        actor_principal_id: string;
        attendance_observation_id: string;
        correlation_id: string;
        row_version: number;
      }>(
        `INSERT INTO hr_attendance_observations
           (tenant_id,worker_profile_id,observed_at,observation_kind,source_kind)
         VALUES ($1,$2,'2027-01-10T08:00:00Z','presence_start','manual')
         RETURNING attendance_observation_id::text,actor_principal_id::text,
                   correlation_id::text,row_version`,
        [ids.tenant, workerProfileId],
      );
      const observationId = observation.rows[0]?.attendance_observation_id ?? "";
      const correction = await appendCorrection(client, observationId, 1, null, "Clock corrected");
      return { correction: correction.rows[0], observation: observation.rows[0] };
    });
    expect(created.observation).toMatchObject({
      actor_principal_id: ids.hrActor,
      correlation_id: ids.correlation,
      row_version: 1,
    });
    expect(created.correction).toMatchObject({
      actor_principal_id: ids.hrActor,
      correction_version: 1,
    });
    const observationId = created.observation?.attendance_observation_id ?? "";
    const firstCorrectionId = created.correction?.attendance_correction_id ?? "";
    const second = await tenantTransaction(pool, ids.tenant, ids.hrActor, (client) =>
      appendCorrection(client, observationId, 2, firstCorrectionId, "Exact successor"),
    );
    const secondCorrectionId = second.rows[0]?.attendance_correction_id ?? "";
    const race = await Promise.allSettled([
      tenantTransaction(pool, ids.tenant, ids.hrActor, (client) =>
        appendCorrection(client, observationId, 3, secondCorrectionId, "Race A"),
      ),
      tenantTransaction(pool, ids.tenant, ids.hrActor, (client) =>
        appendCorrection(client, observationId, 3, secondCorrectionId, "Race B"),
      ),
    ]);
    expect(race.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);

    await databaseError(
      () =>
        tenantTransaction(migrationPool, ids.tenant, ids.hrActor, (client) =>
          client.query(
            `UPDATE hr_attendance_observations SET observed_at='2027-01-10T09:00:00Z'
             WHERE tenant_id=$1 AND attendance_observation_id=$2`,
            [ids.tenant, observationId],
          ),
        ),
      { code: "55000", message: "attendance observations are immutable" },
    );
    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.hrActor, (client) =>
          appendCorrection(client, observationId, 4, firstCorrectionId, "Wrong head"),
        ),
      { code: "55000", message: "attendance correction predecessor is invalid" },
    );
    await databaseError(
      () =>
        tenantTransaction(migrationPool, ids.tenant, ids.hrActor, (client) =>
          client.query("UPDATE hr_attendance_corrections SET reason='Changed' WHERE tenant_id=$1", [
            ids.tenant,
          ]),
        ),
      { code: "55000", message: "attendance corrections are immutable" },
    );
    await databaseError(() => migrationPool.query("TRUNCATE hr_attendance_corrections"), {
      code: "55000",
      message: "attendance corrections cannot be truncated",
    });
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        "UPDATE memberships SET role_key='employee' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenant, ids.hrActor],
      ),
    );
    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.hrActor, (client) =>
          client.query(
            `INSERT INTO hr_attendance_observations
               (tenant_id,worker_profile_id,observed_at,observation_kind,source_kind)
             VALUES ($1,$2,'2027-01-10T10:00:00Z','presence_end','manual')`,
            [ids.tenant, workerProfileId],
          ),
        ),
      { code: "42501", message: "attendance observation authority is denied" },
    );
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        "UPDATE memberships SET role_key='hr_operator' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenant, ids.hrActor],
      ),
    );
    const chain = await tenantTransaction(pool, ids.tenant, ids.hrActor, (client) =>
      client.query(
        `SELECT correction_version,supersedes_attendance_correction_id::text predecessor
         FROM hr_attendance_corrections WHERE attendance_observation_id=$1
         ORDER BY correction_version`,
        [observationId],
      ),
    );
    expect(chain.rows).toHaveLength(3);
    expect(chain.rows[1]).toEqual({ correction_version: 2, predecessor: firstCorrectionId });
  });

  it("fails closed across tenants and while inactive without changing history", async () => {
    const hidden = await tenantTransaction(pool, ids.otherTenant, ids.otherActor, (client) =>
      client.query("SELECT attendance_observation_id FROM hr_attendance_observations"),
    );
    expect(hidden.rows).toEqual([]);
    await databaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherActor, (client) =>
          client.query(
            `INSERT INTO hr_attendance_observations
               (tenant_id,worker_profile_id,observed_at,observation_kind,source_kind)
             VALUES ($1,$2,'2027-01-11T07:00:00Z','presence_start','manual')`,
            [ids.tenant, workerProfileId],
          ),
        ),
      { code: "42501", message: "attendance observation authority is denied" },
    );

    await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE service_activations
         SET state='inactive',version=2
         WHERE tenant_id=$1 AND service_key='attendance'`,
        [ids.tenant],
      ),
    );
    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.hrActor, (client) =>
          client.query(
            `INSERT INTO hr_attendance_observations
               (tenant_id,worker_profile_id,observed_at,observation_kind,source_kind)
             VALUES ($1,$2,'2027-01-11T08:00:00Z','presence_start','manual')`,
            [ids.tenant, workerProfileId],
          ),
        ),
      { code: "55000", message: "attendance service is inactive" },
    );
    await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE service_activations
         SET state='active',version=3
         WHERE tenant_id=$1 AND service_key='attendance'`,
        [ids.tenant],
      ),
    );
  });

  it("synchronizes service control and enforces exact settings policy floors", async () => {
    const initial = await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT settings_version,row_version
         FROM hr_attendance_service_control
         WHERE tenant_id=$1 AND service_key='attendance'`,
        [ids.tenant],
      ),
    );
    expect(initial.rows).toEqual([{ row_version: 3, settings_version: 1 }]);

    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query("SELECT public.esbla_configure_hr_attendance_settings(1,'gps',true)"),
        ),
      { code: "22023" },
    );
    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            "SELECT public.esbla_configure_hr_attendance_settings(1,'presence_start',false)",
          ),
        ),
      { code: "22023" },
    );
    await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query("SELECT public.esbla_configure_hr_attendance_settings(1,'presence_start',true)"),
    );
    const stored = await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT setting_key,value_type,value,version
         FROM tenant_settings
         WHERE tenant_id=$1 AND setting_key LIKE 'hr.attendance.%'
         ORDER BY setting_key`,
        [ids.tenant],
      ),
    );
    expect(stored.rows.map((row) => Object.values(row).join(":"))).toEqual([
      "hr.attendance.correction_note_required:boolean:true:1",
      "hr.attendance.manual_observation_kinds:text:presence_start:1",
    ]);
    const control = await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT settings_version,row_version FROM hr_attendance_service_control
         WHERE tenant_id=$1 AND service_key='attendance'`,
        [ids.tenant],
      ),
    );
    expect(control.rows).toEqual([{ row_version: 4, settings_version: 2 }]);
    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            "SELECT public.esbla_configure_hr_attendance_settings(1,'presence_end',true)",
          ),
        ),
      { code: "40001", message: "attendance settings version conflict" },
    );
    const unchanged = await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT settings_version,row_version FROM hr_attendance_service_control
         WHERE tenant_id=$1 AND service_key='attendance'`,
        [ids.tenant],
      ),
    );
    expect(unchanged.rows).toEqual(control.rows);
  });
});
