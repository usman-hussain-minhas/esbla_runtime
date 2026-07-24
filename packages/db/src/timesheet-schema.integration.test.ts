import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  actor: "19000000-0000-4000-8000-000000000001",
  correlation: "59000000-0000-4000-8000-000000000001",
  manager: "19000000-0000-4000-8000-000000000002",
  managerMembership: "29000000-0000-4000-8000-000000000002",
  membership: "29000000-0000-4000-8000-000000000001",
  otherActor: "19000000-0000-4000-8000-000000000003",
  otherMembership: "29000000-0000-4000-8000-000000000003",
  otherTenant: "09000000-0000-4000-8000-000000000002",
  tenant: "09000000-0000-4000-8000-000000000001",
} as const;

let applicationRole = "";
let migrationPool: Pool;
let pool: Pool;
let managerProfileId = "";
let otherWorkerProfileId = "";
let workerProfileId = "";

async function transaction<T>(
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

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  await expect(operation()).rejects.toMatchObject(expected);
}

async function createActiveProfile(client: PoolClient, tenantId: string, principalId: string) {
  const created = await client.query<{ worker_profile_id: string }>(
    `INSERT INTO hr_worker_profiles (tenant_id)
     VALUES ($1) RETURNING worker_profile_id::text`,
    [tenantId],
  );
  const workerProfileId = created.rows[0]?.worker_profile_id ?? "";
  await client.query(
    `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, workerProfileId, principalId],
  );
  await client.query(
    `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, workerProfileId],
  );
  return workerProfileId;
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

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Timesheet Tenant'),($2,'Other Timesheet Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Timesheet Worker'),($2,'Timesheet Manager'),($3,'Other Worker')`,
    [ids.actor, ids.manager, ids.otherActor],
  );
  await transaction(migrationPool, ids.tenant, ids.actor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'employee'),($4,$2,$5,'manager')`,
      [ids.membership, ids.tenant, ids.actor, ids.managerMembership, ids.manager],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),($1,'timesheet','active',1)`,
      [ids.tenant],
    );
    workerProfileId = await createActiveProfile(client, ids.tenant, ids.actor);
    managerProfileId = await createActiveProfile(client, ids.tenant, ids.manager);
  });
  await transaction(migrationPool, ids.otherTenant, ids.otherActor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'employee')`,
      [ids.otherMembership, ids.otherTenant, ids.otherActor],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),($1,'timesheet','active',1)`,
      [ids.otherTenant],
    );
    otherWorkerProfileId = await createActiveProfile(client, ids.otherTenant, ids.otherActor);
  });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("Timesheet persistence kernel", () => {
  it("installs the exact tenant-owned schema, indexes, RLS, deferred head link, and least privilege", async () => {
    const tables = await migrationPool.query<{ force_rls: boolean; name: string; rls: boolean }>(
      `SELECT relname name,relrowsecurity rls,relforcerowsecurity force_rls
       FROM pg_catalog.pg_class
       WHERE oid=ANY(ARRAY[
         'public.hr_timesheet_approvals'::regclass,
         'public.hr_timesheet_entries'::regclass,
         'public.hr_timesheet_service_control'::regclass,
         'public.hr_timesheet_versions'::regclass,
         'public.hr_timesheets'::regclass
       ]) ORDER BY relname`,
    );
    expect(tables.rows).toEqual([
      { force_rls: true, name: "hr_timesheet_approvals", rls: true },
      { force_rls: true, name: "hr_timesheet_entries", rls: true },
      { force_rls: true, name: "hr_timesheet_service_control", rls: true },
      { force_rls: true, name: "hr_timesheet_versions", rls: true },
      { force_rls: true, name: "hr_timesheets", rls: true },
    ]);

    const enums = await migrationPool.query<{ definition: string }>(
      `SELECT typname || ':' || string_agg(enumlabel,',' ORDER BY enumsortorder) definition
       FROM pg_catalog.pg_type JOIN pg_catalog.pg_enum ON enumtypid=pg_type.oid
       WHERE typname=ANY($1::text[]) GROUP BY typname ORDER BY typname`,
      [["hr_timesheet_decision", "hr_timesheet_status"]],
    );
    expect(enums.rows.map(({ definition }) => definition)).toEqual([
      "hr_timesheet_decision:approved,rejected",
      "hr_timesheet_status:draft,submitted,approved,rejected",
    ]);

    const indexes = await migrationPool.query<{ name: string }>(
      `SELECT indexname name FROM pg_catalog.pg_indexes
       WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
      [
        [
          "idx_hr_timesheet_entries_tenant_version_date",
          "idx_hr_timesheet_versions_tenant_approver_submitted",
          "idx_hr_timesheet_versions_tenant_timesheet_cursor",
          "idx_hr_timesheets_tenant_worker_period_cursor",
          "uq_hr_timesheet_approvals_tenant_version",
          "uq_hr_timesheet_service_control_tenant_key",
          "uq_hr_timesheet_versions_composite_identity",
          "uq_hr_timesheet_versions_tenant_number",
          "uq_hr_timesheet_versions_tenant_successor",
          "uq_hr_timesheets_tenant_worker_period",
        ],
      ],
    );
    expect(indexes.rows.map(({ name }) => name)).toHaveLength(10);

    const currentHead = await migrationPool.query<{
      deferrable: boolean;
      initially_deferred: boolean;
    }>(
      `SELECT condeferrable deferrable,condeferred initially_deferred
       FROM pg_catalog.pg_constraint
       WHERE conname='hr_timesheets_current_version_same_root_fk'`,
    );
    expect(currentHead.rows).toEqual([{ deferrable: true, initially_deferred: true }]);

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
          "hr_timesheet_approvals",
          "hr_timesheet_entries",
          "hr_timesheet_service_control",
          "hr_timesheet_versions",
          "hr_timesheets",
        ],
      ],
    );
    expect(
      privileges.rows.map(({ name, select, insert, update, delete: remove, truncate }) =>
        [name, select, insert, update, remove, truncate].join(":"),
      ),
    ).toEqual([
      "hr_timesheet_approvals:true:true:false:false:false",
      "hr_timesheet_entries:true:true:true:true:false",
      "hr_timesheet_service_control:true:false:false:false:false",
      "hr_timesheet_versions:true:true:true:false:false",
      "hr_timesheets:true:true:true:false:false",
    ]);
  });

  it("creates a stable root and exact first head atomically with no intermediate committed state", async () => {
    const timesheetId = "39000000-0000-4000-8000-000000000001";
    const versionId = "49000000-0000-4000-8000-000000000001";
    await transaction(pool, ids.tenant, ids.actor, async (client) => {
      await client.query(
        `INSERT INTO hr_timesheets
           (timesheet_id,tenant_id,worker_profile_id,period_start,period_end,current_version_id)
         VALUES ($1,$2,$3,'2027-01-04','2027-01-10',$4)`,
        [timesheetId, ids.tenant, workerProfileId, versionId],
      );
      await client.query(
        `INSERT INTO hr_timesheet_versions
           (timesheet_version_id,tenant_id,timesheet_id,version)
         VALUES ($1,$2,$3,1)`,
        [versionId, ids.tenant, timesheetId],
      );
    });
    const stored = await transaction(pool, ids.tenant, ids.actor, async (client) =>
      client.query(
        `SELECT root.current_version_id::text,version.status,version.version
         FROM hr_timesheets root JOIN hr_timesheet_versions version
           ON version.tenant_id=root.tenant_id
          AND version.timesheet_id=root.timesheet_id
          AND version.timesheet_version_id=root.current_version_id
         WHERE root.tenant_id=$1 AND root.timesheet_id=$2`,
        [ids.tenant, timesheetId],
      ),
    );
    expect(stored.rows).toEqual([{ current_version_id: versionId, status: "draft", version: 1 }]);

    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_timesheets
               (tenant_id,worker_profile_id,period_start,period_end,current_version_id)
             VALUES ($1,$2,'2027-02-01','2027-02-07',$3)`,
            [ids.tenant, workerProfileId, "49000000-0000-4000-8000-000000000099"],
          ),
        ),
      { code: "23503", constraint: "hr_timesheets_current_version_same_root_fk" },
    );
  });

  it("enforces same-tenant roots, periods, successor uniqueness, entry bounds, and RLS", async () => {
    const root = "39000000-0000-4000-8000-000000000002";
    const version = "49000000-0000-4000-8000-000000000002";
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_timesheets
               (timesheet_id,tenant_id,worker_profile_id,period_start,period_end,current_version_id)
             VALUES ($1,$2,$3,'2027-01-10','2027-01-01',$4)`,
            [root, ids.tenant, workerProfileId, version],
          ),
        ),
      { code: "23514", constraint: "hr_timesheets_period_valid" },
    );
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_timesheets
               (timesheet_id,tenant_id,worker_profile_id,period_start,period_end,current_version_id)
             VALUES ($1,$2,$3,'2027-01-11','2027-01-17',$4)`,
            [root, ids.tenant, otherWorkerProfileId, version],
          ),
        ),
      { code: "23503", constraint: "hr_timesheets_worker_same_tenant_fk" },
    );
    const invisible = await transaction(pool, ids.otherTenant, ids.otherActor, (client) =>
      client.query(`SELECT count(*)::int count FROM hr_timesheets WHERE tenant_id=$1`, [
        ids.tenant,
      ]),
    );
    expect(invisible.rows).toEqual([{ count: 0 }]);
  });

  it("preserves submitted and decided history while allowing only bounded draft-entry work", async () => {
    const root = "39000000-0000-4000-8000-000000000003";
    const version = "49000000-0000-4000-8000-000000000003";
    const entry = "69000000-0000-4000-8000-000000000001";
    await transaction(pool, ids.tenant, ids.actor, async (client) => {
      await client.query(
        `INSERT INTO hr_timesheets
           (timesheet_id,tenant_id,worker_profile_id,period_start,period_end,current_version_id)
         VALUES ($1,$2,$3,'2027-03-01','2027-03-07',$4)`,
        [root, ids.tenant, workerProfileId, version],
      );
      await client.query(
        `INSERT INTO hr_timesheet_versions
           (timesheet_version_id,tenant_id,timesheet_id,version)
         VALUES ($1,$2,$3,1)`,
        [version, ids.tenant, root],
      );
      await client.query(
        `INSERT INTO hr_timesheet_entries
           (timesheet_entry_id,tenant_id,timesheet_version_id,entry_date,minutes,description)
         VALUES ($1,$2,$3,'2027-03-01',480,'Customer-free internal work')`,
        [entry, ids.tenant, version],
      );
      await client.query(
        `UPDATE hr_timesheet_versions
         SET status='submitted',assigned_approver_worker_profile_id=$4,
             submitted_at=statement_timestamp(),total_minutes=480,
             updated_at=statement_timestamp(),row_version=2
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3`,
        [ids.tenant, root, version, managerProfileId],
      );
    });
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `UPDATE hr_timesheet_entries SET minutes=60,row_version=2
             WHERE tenant_id=$1 AND timesheet_entry_id=$2`,
            [ids.tenant, entry],
          ),
        ),
      { code: "55000", message: "timesheet entries require a current draft version" },
    );
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.manager, (client) =>
          client.query(
            `INSERT INTO hr_timesheet_approvals
               (tenant_id,timesheet_version_id,approver_worker_profile_id,
                decision,decision_note,correlation_id)
             VALUES ($1,$2,$3,'approved',NULL,$4)`,
            [ids.tenant, version, managerProfileId, ids.correlation],
          ),
        ),
      { code: "55000", message: "timesheet approval and decision must commit atomically" },
    );
    await transaction(pool, ids.tenant, ids.manager, async (client) => {
      await client.query(
        `INSERT INTO hr_timesheet_approvals
           (tenant_id,timesheet_version_id,approver_worker_profile_id,
            decision,decision_note,correlation_id)
         VALUES ($1,$2,$3,'approved',NULL,$4)`,
        [ids.tenant, version, managerProfileId, ids.correlation],
      );
      await client.query(
        `UPDATE hr_timesheet_versions
         SET status='approved',updated_at=statement_timestamp(),row_version=3
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3`,
        [ids.tenant, root, version],
      );
    });
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.manager, (client) =>
          client.query(
            `UPDATE hr_timesheet_approvals SET decision_note='changed'
             WHERE tenant_id=$1 AND timesheet_version_id=$2`,
            [ids.tenant, version],
          ),
        ),
      { code: "42501" },
    );
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.manager, (client) =>
          client.query(`DELETE FROM hr_timesheet_versions WHERE tenant_id=$1 AND timesheet_id=$2`, [
            ids.tenant,
            root,
          ]),
        ),
      { code: "42501" },
    );
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_timesheet_versions
               (timesheet_version_id,tenant_id,timesheet_id,supersedes_version_id,version)
             VALUES ('49000000-0000-4000-8000-000000000004',$1,$2,$3,2)`,
            [ids.tenant, root, version],
          ),
        ),
      { code: "55000", message: "new timesheet version must be the committed current head" },
    );
  });
});
