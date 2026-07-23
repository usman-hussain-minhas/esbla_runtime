import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  actor: "15000000-0000-4000-8000-000000000001",
  correlation: "55000000-0000-4000-8000-000000000001",
  membership: "25000000-0000-4000-8000-000000000001",
  otherActor: "15000000-0000-4000-8000-000000000002",
  otherMembership: "25000000-0000-4000-8000-000000000002",
  otherTenant: "07000000-0000-4000-8000-000000000002",
  tenant: "07000000-0000-4000-8000-000000000001",
} as const;

let applicationRole = "";
let migrationPool: Pool;
let pool: Pool;
let workerProfileId = "";

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

async function createRoster(
  client: PoolClient,
  version: number,
): Promise<{ rosterVersionId: string }> {
  const result = await client.query<{ roster_version_id: string }>(
    `INSERT INTO hr_shift_roster_versions
       (tenant_id,period_start,period_end,version)
     VALUES ($1,'2026-11-01','2026-11-14',$2)
     RETURNING roster_version_id::text`,
    [ids.tenant, version],
  );
  const rosterVersionId = result.rows[0]?.roster_version_id;
  if (!rosterVersionId) throw new Error("Shift roster identifier was unavailable");
  return { rosterVersionId };
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
     VALUES ($1,'Shift Tenant'),($2,'Other Shift Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Shift Administrator'),($2,'Other Shift Operator')`,
    [ids.actor, ids.otherActor],
  );
  await tenantTransaction(migrationPool, ids.tenant, ids.actor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'tenant_admin')`,
      [ids.membership, ids.tenant, ids.actor],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'hr.shift.configure_service')`,
      [ids.tenant, ids.actor],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),($1,'shift_assignment','active',1)`,
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
      [ids.tenant, workerProfileId, ids.actor],
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
       VALUES ($1,'workforce_profile','active',1),($1,'shift_assignment','active',1)`,
      [ids.otherTenant],
    );
  });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("Shift Assignment persistence kernel", () => {
  it("installs exact tenant-owned storage, query indexes, forced RLS, and least privilege", async () => {
    const tables = await migrationPool.query<{ force_rls: boolean; name: string; rls: boolean }>(
      `SELECT relname AS name,relrowsecurity AS rls,relforcerowsecurity AS force_rls
       FROM pg_catalog.pg_class
       WHERE oid = ANY(ARRAY[
         'public.hr_shift_assignment_service_control'::regclass,
         'public.hr_shift_assignments'::regclass,
         'public.hr_shift_roster_versions'::regclass
       ]) ORDER BY relname`,
    );
    expect(tables.rows).toEqual([
      { force_rls: true, name: "hr_shift_assignment_service_control", rls: true },
      { force_rls: true, name: "hr_shift_assignments", rls: true },
      { force_rls: true, name: "hr_shift_roster_versions", rls: true },
    ]);

    const enums = await migrationPool.query<{ definition: string }>(
      `SELECT typname || ':' || string_agg(enumlabel,',' ORDER BY enumsortorder) definition
       FROM pg_catalog.pg_type JOIN pg_catalog.pg_enum ON enumtypid=pg_type.oid
       WHERE typname=ANY($1::text[]) GROUP BY typname ORDER BY typname`,
      [["hr_shift_assignment_status", "hr_shift_roster_status"]],
    );
    expect(enums.rows.map(({ definition }) => definition)).toEqual([
      "hr_shift_assignment_status:active,cancelled",
      "hr_shift_roster_status:draft,published,superseded",
    ]);

    const indexes = await migrationPool.query<{ name: string }>(
      `SELECT indexname name FROM pg_catalog.pg_indexes
       WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
      [
        [
          "idx_hr_shift_assignments_tenant_roster_status_start",
          "idx_hr_shift_assignments_tenant_worker_overlap",
          "idx_hr_shift_assignments_tenant_worker_start",
          "uq_hr_shift_assignment_service_control_tenant_key",
          "uq_hr_shift_roster_versions_tenant_period_version",
          "uq_hr_shift_rosters_tenant_period_published",
          "uq_hr_shift_rosters_tenant_period_successor",
        ],
      ],
    );
    expect(indexes.rows.map(({ name }) => name)).toEqual([
      "idx_hr_shift_assignments_tenant_roster_status_start",
      "idx_hr_shift_assignments_tenant_worker_overlap",
      "idx_hr_shift_assignments_tenant_worker_start",
      "uq_hr_shift_assignment_service_control_tenant_key",
      "uq_hr_shift_roster_versions_tenant_period_version",
      "uq_hr_shift_rosters_tenant_period_published",
      "uq_hr_shift_rosters_tenant_period_successor",
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
        ["hr_shift_assignment_service_control", "hr_shift_assignments", "hr_shift_roster_versions"],
      ],
    );
    expect(privileges.rows).toEqual([
      {
        delete: false,
        insert: false,
        name: "hr_shift_assignment_service_control",
        select: true,
        truncate: false,
        update: false,
      },
      {
        delete: false,
        insert: true,
        name: "hr_shift_assignments",
        select: true,
        truncate: false,
        update: true,
      },
      {
        delete: false,
        insert: true,
        name: "hr_shift_roster_versions",
        select: true,
        truncate: false,
        update: true,
      },
    ]);

    const controlTriggers = await migrationPool.query<{ name: string }>(
      `SELECT tgname AS name
       FROM pg_catalog.pg_trigger
       WHERE tgrelid='public.hr_shift_assignment_service_control'::regclass
         AND NOT tgisinternal
       ORDER BY tgname`,
    );
    expect(controlTriggers.rows.map(({ name }) => name)).toEqual([
      "hr_shift_assignment_service_control_enforce_state",
      "hr_shift_assignment_service_control_reject_truncate",
    ]);
  });

  it("preserves roster publication, validated supersession, and terminal assignment state", async () => {
    const result = await tenantTransaction(pool, ids.tenant, ids.actor, async (client) => {
      const first = await createRoster(client, 1);
      const firstAssignment = await client.query<{ shift_assignment_id: string }>(
        `INSERT INTO hr_shift_assignments
           (tenant_id,roster_version_id,worker_profile_id,starts_at,ends_at,iana_timezone)
         VALUES ($1,$2,$3,'2026-11-02T04:00:00Z','2026-11-02T12:00:00Z','Asia/Karachi')
         RETURNING shift_assignment_id::text`,
        [ids.tenant, first.rosterVersionId, workerProfileId],
      );
      await client.query(
        `UPDATE hr_shift_roster_versions
         SET status='published',published_at='2026-10-20T00:00:00Z',row_version=2
         WHERE tenant_id=$1 AND roster_version_id=$2`,
        [ids.tenant, first.rosterVersionId],
      );

      const second = await createRoster(client, 2);
      await client.query(
        `UPDATE hr_shift_roster_versions SET status='superseded',row_version=3
         WHERE tenant_id=$1 AND roster_version_id=$2`,
        [ids.tenant, first.rosterVersionId],
      );
      await client.query(
        `UPDATE hr_shift_roster_versions
         SET status='published',supersedes_roster_version_id=$3,
             published_at='2026-10-27T00:00:00Z',row_version=2
         WHERE tenant_id=$1 AND roster_version_id=$2`,
        [ids.tenant, second.rosterVersionId, first.rosterVersionId],
      );

      const assignmentId = firstAssignment.rows[0]?.shift_assignment_id ?? "";
      await client.query(
        `UPDATE hr_shift_assignments SET status='cancelled',row_version=2
         WHERE tenant_id=$1 AND shift_assignment_id=$2`,
        [ids.tenant, assignmentId],
      );
      return { assignmentId, first: first.rosterVersionId, second: second.rosterVersionId };
    });

    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `UPDATE hr_shift_assignments SET status='active',row_version=3
             WHERE tenant_id=$1 AND shift_assignment_id=$2`,
            [ids.tenant, result.assignmentId],
          ),
        ),
      { code: "55000", message: "cancelled shift assignments are immutable" },
    );
    await databaseError(
      () =>
        tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
          client.query(
            `DELETE FROM hr_shift_roster_versions
             WHERE tenant_id=$1 AND roster_version_id=$2`,
            [ids.tenant, result.first],
          ),
        ),
      { code: "55000", message: "shift roster versions cannot be deleted" },
    );
    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, async (client) => {
          const third = await createRoster(client, 3);
          await client.query(
            `UPDATE hr_shift_roster_versions SET status='superseded',row_version=3
             WHERE tenant_id=$1 AND roster_version_id=$2`,
            [ids.tenant, result.second],
          );
          await client.query(
            `UPDATE hr_shift_roster_versions
             SET status='published',supersedes_roster_version_id=$3,
                 published_at='2026-10-28T00:00:00Z',row_version=2
             WHERE tenant_id=$1 AND roster_version_id=$2`,
            [ids.tenant, third.rosterVersionId, result.first],
          );
        }),
      { code: "55000", message: "shift roster predecessor is invalid" },
    );
  });

  it("fails closed across tenants and on invalid temporal or roster ownership data", async () => {
    const created = await tenantTransaction(pool, ids.tenant, ids.actor, async (client) => {
      const roster = await client.query<{ roster_version_id: string }>(
        `INSERT INTO hr_shift_roster_versions
           (tenant_id,period_start,period_end,version)
         VALUES ($1,'2026-12-01','2026-12-14',1) RETURNING roster_version_id::text`,
        [ids.tenant],
      );
      return roster.rows[0]?.roster_version_id ?? "";
    });
    await databaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherActor, (client) =>
          client.query(
            `INSERT INTO hr_shift_assignments
               (tenant_id,roster_version_id,worker_profile_id,starts_at,ends_at,iana_timezone)
             VALUES ($1,$2,$3,'2026-12-02T04:00:00Z','2026-12-02T12:00:00Z','UTC')`,
            [ids.otherTenant, created, workerProfileId],
          ),
        ),
      { code: "55000", message: "shift assignment requires a draft roster" },
    );
    const hidden = await tenantTransaction(pool, ids.otherTenant, ids.otherActor, (client) =>
      client.query("SELECT roster_version_id FROM hr_shift_roster_versions"),
    );
    expect(hidden.rows).toEqual([]);

    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_shift_assignments
               (tenant_id,roster_version_id,worker_profile_id,starts_at,ends_at,iana_timezone)
             VALUES ($1,$2,$3,'2026-12-02T12:00:00Z','2026-12-02T04:00:00Z','UTC')`,
            [ids.tenant, created, workerProfileId],
          ),
        ),
      { code: "23514", constraint: "hr_shift_assignments_time_range_valid" },
    );
  });

  it("synchronizes activation and permits only exact guarded Shift settings", async () => {
    const initial = await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT settings_version,row_version
         FROM hr_shift_assignment_service_control
         WHERE tenant_id=$1 AND service_key='shift_assignment'`,
        [ids.tenant],
      ),
    );
    expect(initial.rows).toEqual([{ row_version: 1, settings_version: 1 }]);

    const maintenanceClient = await migrationPool.connect();
    try {
      await maintenanceClient.query("BEGIN");
      await maintenanceClient.query("SELECT set_config('app.tenant_id',$1,true)", [ids.tenant]);
      await maintenanceClient.query("SELECT set_config('app.actor_principal_id',$1,true)", [
        ids.actor,
      ]);
      await expect(
        maintenanceClient.query(
          `DELETE FROM hr_shift_assignment_service_control
           WHERE tenant_id=$1 AND service_key='shift_assignment'`,
          [ids.tenant],
        ),
      ).rejects.toMatchObject({
        code: "55000",
        message: "shift assignment service control cannot be deleted",
      });
    } finally {
      await maintenanceClient.query("ROLLBACK");
      maintenanceClient.release();
    }

    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query("SELECT public.esbla_configure_hr_shift_assignment_settings(1,14,true)"),
        ),
      { code: "22023" },
    );
    await databaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherActor, (client) =>
          client.query("SELECT public.esbla_configure_hr_shift_assignment_settings(1,14,false)"),
        ),
      { code: "42501" },
    );

    const configured = await tenantTransaction(pool, ids.tenant, ids.actor, async (client) => {
      await client.query("SELECT public.esbla_configure_hr_shift_assignment_settings(1,21,false)");
      return await client.query(
        `SELECT control.settings_version,control.row_version,
                jsonb_object_agg(setting.setting_key,setting.value ORDER BY setting.setting_key)
                  AS settings
         FROM hr_shift_assignment_service_control control
         JOIN tenant_settings setting ON setting.tenant_id=control.tenant_id
         WHERE control.tenant_id=$1 AND control.service_key='shift_assignment'
           AND setting.setting_key IN (
             'hr.shift_assignment.overlap_allowed',
             'hr.shift_assignment.roster_horizon_days'
           )
         GROUP BY control.settings_version,control.row_version`,
        [ids.tenant],
      );
    });
    expect(configured.rows).toEqual([
      {
        row_version: 2,
        settings: {
          "hr.shift_assignment.overlap_allowed": false,
          "hr.shift_assignment.roster_horizon_days": 21,
        },
        settings_version: 2,
      },
    ]);
    await databaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query("SELECT public.esbla_configure_hr_shift_assignment_settings(1,7,false)"),
        ),
      { code: "40001" },
    );
  });
});
