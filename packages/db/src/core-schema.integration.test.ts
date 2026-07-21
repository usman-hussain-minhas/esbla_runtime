import { fileURLToPath } from "node:url";
import type { Pool, PoolClient, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  correlation: "50000000-0000-4000-8000-000000000001",
  employeeA: "10000000-0000-4000-8000-000000000002",
  employeeB: "10000000-0000-4000-8000-000000000004",
  evidence: "40000000-0000-4000-8000-000000000001",
  managerA: "10000000-0000-4000-8000-000000000001",
  managerB: "10000000-0000-4000-8000-000000000003",
  membershipEmployeeA: "20000000-0000-4000-8000-000000000002",
  membershipEmployeeB: "20000000-0000-4000-8000-000000000004",
  membershipManagerA: "20000000-0000-4000-8000-000000000001",
  membershipManagerB: "20000000-0000-4000-8000-000000000003",
  outbox: "60000000-0000-4000-8000-000000000001",
  subject: "30000000-0000-4000-8000-000000000001",
  tenantA: "00000000-0000-4000-8000-000000000001",
  tenantB: "00000000-0000-4000-8000-000000000002",
  workItem: "70000000-0000-4000-8000-000000000001",
} as const;

let migrationPool: Pool;
let pool: Pool;

const migrationBarrierFixture = fileURLToPath(
  new URL("../test-fixtures/migration-coordination", import.meta.url),
);
const migrationBarrierKey = [1163084364, 1296648018] as const;
const migrationTestGateKey = [1163084364, 1413829460] as const;

async function waitForAdvisoryLock(
  observer: Pool,
  key: readonly [number, number],
  mode: "ExclusiveLock" | "ShareLock",
  granted: boolean,
): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const locks = await observer.query<{ pid: number }>(
      `SELECT pid
       FROM pg_catalog.pg_locks
       WHERE locktype = 'advisory' AND database = (
         SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()
       )
         AND classid = $1::oid AND objid = $2::oid AND objsubid = 2
         AND mode = $3 AND granted = $4`,
      [key[0], key[1], mode, granted],
    );
    const row = locks.rows[0];
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${granted ? "granted" : "waiting"} ${mode} was not observed`);
}

async function waitForAdvisoryLockAbsence(
  observer: Pool,
  key: readonly [number, number],
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const locks = await observer.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_catalog.pg_locks
       WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid
         AND objsubid = 2`,
      [...key],
    );
    if (locks.rows[0]?.count === "0") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Migration coordination lock residue remained");
}

async function tenantTransaction<T>(
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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

async function tenantQuery<T extends Record<string, unknown>>(
  tenantId: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return await tenantTransaction(
    tenantId,
    async (client) => await client.query<T>(text, [...values]),
  );
}

async function migrationTenantTransaction<T>(
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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

async function withServiceControlGuardDisabled<T>(
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return await migrationTenantTransaction(tenantId, async (client) => {
    await client.query(
      `ALTER TABLE hr_workforce_profile_service_control
       DISABLE TRIGGER hr_workforce_profile_service_control_enforce_state`,
    );
    const result = await operation(client);
    await client.query(
      `ALTER TABLE hr_workforce_profile_service_control
       ENABLE TRIGGER hr_workforce_profile_service_control_enforce_state`,
    );
    return result;
  });
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!connectionString || !migrationConnectionString || !applicationRole) {
    throw new Error(
      "DATABASE_URL, DATABASE_MIGRATION_URL and ESBLA_TEST_APPLICATION_ROLE are required; run through with-postgres.mjs",
    );
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("ESBLA_TEST_APPLICATION_ROLE is not a safe PostgreSQL identifier");
  }

  migrationPool = createDatabasePool(migrationConnectionString, { max: 2 });
  const migrationDatabase = createDatabase(migrationPool);
  await migrateDatabase(migrationDatabase);
  await migrateDatabase(migrationDatabase);

  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(`GRANT SELECT, INSERT ON tenants, principals TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT
     ON hr_workforce_profile_service_control, membership_capabilities,
        hr_workforce_status_history
     TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE ON hr_worker_profiles TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
     ON memberships, service_activations, tenant_settings, work_items, outbox_events
     TO ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);

  pool = createDatabasePool(connectionString, { max: 4 });

  await pool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Manager A'), ($2, 'Employee A'), ($3, 'Manager B'), ($4, 'Employee B')`,
    [ids.managerA, ids.employeeA, ids.managerB, ids.employeeB],
  );

  await tenantTransaction(ids.tenantA, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'manager')`,
      [ids.membershipManagerA, ids.tenantA, ids.managerA],
    );
    await client.query(
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'employee', $4)`,
      [ids.membershipEmployeeA, ids.tenantA, ids.employeeA, ids.managerA],
    );
  });

  await tenantTransaction(ids.tenantB, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'manager')`,
      [ids.membershipManagerB, ids.tenantB, ids.managerB],
    );
    await client.query(
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'employee', $4)`,
      [ids.membershipEmployeeB, ids.tenantB, ids.employeeB, ids.managerB],
    );
  });
});

afterAll(async () => {
  await pool.end();
  await migrationPool.end();
});

describe("core PostgreSQL foundation", () => {
  it("replays every migration once and forces RLS on every tenant-owned table", async () => {
    const migrations = await migrationPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(migrations.rows[0]?.count).toBe("9");

    const rowSecurity = await pool.query<{
      force_row_security: boolean;
      row_security: boolean;
      table_name: string;
    }>(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS row_security,
              c.relforcerowsecurity AS force_row_security
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [
        [
          "evidence_events",
          "hr_leave_requests",
          "hr_worker_profiles",
          "hr_workforce_profile_service_control",
          "hr_workforce_status_history",
          "membership_capabilities",
          "memberships",
          "outbox_events",
          "service_activations",
          "tenant_settings",
          "work_items",
          "workspace_tasks",
        ],
      ],
    );

    expect(rowSecurity.rows).toHaveLength(12);
    expect(rowSecurity.rows.every((row) => row.row_security && row.force_row_security)).toBe(true);
    const schemaPrivilege = await pool.query<{ can_create: boolean; current_schema: string }>(
      `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
              current_schema() AS current_schema`,
    );
    const schemaAcl = await migrationPool.query(
      `SELECT n.nspowner::regrole::text AS owner,
              pg_has_role('esbla_app', 'esbla_migrator', 'MEMBER') AS inherits_migrator
       FROM pg_namespace n WHERE n.nspname = 'public'`,
    );
    expect(schemaAcl.rows).toEqual([{ inherits_migrator: false, owner: "esbla_migrator" }]);
    expect(schemaPrivilege.rows).toEqual([{ can_create: false, current_schema: "public" }]);
    await expect(pool.query("CREATE TABLE unauthorized_table (id integer)")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      pool.query("ALTER TABLE memberships DISABLE ROW LEVEL SECURITY"),
    ).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("keeps exact membership capabilities tenant-scoped and read-only to Runtime", async () => {
    await migrationTenantTransaction(ids.tenantA, async (client) =>
      client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.workforce.activate_service')`,
        [ids.tenantA, ids.managerA],
      ),
    );
    expect((await pool.query("SELECT * FROM membership_capabilities")).rows).toEqual([]);
    expect(
      (
        await tenantQuery<{ capability_id: string }>(
          ids.tenantA,
          "SELECT capability_id FROM membership_capabilities",
        )
      ).rows,
    ).toEqual([{ capability_id: "hr.workforce.activate_service" }]);
    expect((await tenantQuery(ids.tenantB, "SELECT * FROM membership_capabilities")).rows).toEqual(
      [],
    );
    await expect(
      tenantQuery(
        ids.tenantA,
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.workforce.deactivate_service')`,
        [ids.tenantA, ids.managerA],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const statement of [
      `UPDATE membership_capabilities SET capability_id = capability_id
       WHERE tenant_id = '${ids.tenantA}' AND principal_id = '${ids.managerA}'`,
      `DELETE FROM membership_capabilities
       WHERE tenant_id = '${ids.tenantA}' AND principal_id = '${ids.managerA}'`,
      "TRUNCATE membership_capabilities",
    ]) {
      await expect(tenantQuery(ids.tenantA, statement)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      pool.query("SELECT public.esbla_guard_membership_capability_authority()"),
    ).rejects.toMatchObject({ code: "42501" });

    const authorityAcl = await migrationPool.query<{
      can_delete: boolean;
      can_execute_guard: boolean;
      can_insert: boolean;
      can_truncate: boolean;
      can_update: boolean;
    }>(
      `SELECT has_table_privilege('esbla_app', 'membership_capabilities', 'INSERT') AS can_insert,
              has_table_privilege('esbla_app', 'membership_capabilities', 'UPDATE') AS can_update,
              has_table_privilege('esbla_app', 'membership_capabilities', 'DELETE') AS can_delete,
              has_table_privilege('esbla_app', 'membership_capabilities', 'TRUNCATE') AS can_truncate,
              has_function_privilege(
                'esbla_app',
                'public.esbla_guard_membership_capability_authority()',
                'EXECUTE'
              ) AS can_execute_guard`,
    );
    expect(authorityAcl.rows).toEqual([
      {
        can_delete: false,
        can_execute_guard: false,
        can_insert: false,
        can_truncate: false,
        can_update: false,
      },
    ]);

    const membershipForeignKey = await migrationPool.query<{ definition: string }>(
      `SELECT pg_catalog.pg_get_constraintdef(oid) AS definition
       FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.membership_capabilities'::regclass
         AND conname = 'membership_capabilities_membership_fk'`,
    );
    expect(membershipForeignKey.rows).toEqual([
      {
        definition:
          "FOREIGN KEY (tenant_id, principal_id) REFERENCES memberships(tenant_id, principal_id) ON DELETE RESTRICT",
      },
    ]);
    await migrationPool.query(
      "ALTER TABLE membership_capabilities DISABLE TRIGGER membership_capabilities_guard_authority",
    );
    try {
      await expect(
        migrationTenantTransaction(ids.tenantA, async (client) =>
          client.query(
            `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
             VALUES ($1, '10000000-0000-4000-8000-000000000099', 'hr.workforce.activate_service')`,
            [ids.tenantA],
          ),
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "membership_capabilities_membership_fk",
      });
    } finally {
      await migrationPool.query(
        "ALTER TABLE membership_capabilities ENABLE TRIGGER membership_capabilities_guard_authority",
      );
    }
    await expect(
      migrationTenantTransaction(ids.tenantA, async (client) =>
        client.query(
          `UPDATE membership_capabilities
           SET capability_id = 'hr.workforce.deactivate_service'
           WHERE tenant_id = $1 AND principal_id = $2`,
          [ids.tenantA, ids.managerA],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(migrationPool.query("TRUNCATE membership_capabilities")).rejects.toMatchObject({
      code: "55000",
    });

    const guard = await migrationPool.query<{
      config: string;
      public_execute: boolean;
      security_definer: boolean;
    }>(
      `SELECT procedure.prosecdef AS security_definer,
              procedure.proconfig[1] AS config,
              EXISTS (
                SELECT 1
                FROM pg_catalog.aclexplode(COALESCE(
                  procedure.proacl,
                  pg_catalog.acldefault('f', procedure.proowner)
                )) privilege
                WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
              ) AS public_execute
       FROM pg_catalog.pg_proc procedure
       WHERE procedure.oid =
         'public.esbla_guard_membership_capability_authority()'::regprocedure`,
    );
    expect(guard.rows).toEqual([
      {
        config: "search_path=pg_catalog, public",
        public_execute: false,
        security_definer: true,
      },
    ]);

    const actor = await pool.connect();
    const revoker = await migrationPool.connect();
    try {
      await actor.query("BEGIN");
      await actor.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await actor.query(
        `SELECT role_key FROM memberships
         WHERE tenant_id = $1 AND principal_id = $2 FOR SHARE`,
        [ids.tenantA, ids.managerA],
      );
      for (const [text, values] of [
        [
          `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
           VALUES ($1, $2, 'hr.workforce.deactivate_service')`,
          [ids.tenantA, ids.managerA],
        ],
        [
          `UPDATE membership_capabilities SET capability_id = capability_id
           WHERE tenant_id = $1 AND principal_id = $2`,
          [ids.tenantA, ids.managerA],
        ],
        [
          `DELETE FROM membership_capabilities
           WHERE tenant_id = $1 AND principal_id = $2`,
          [ids.tenantA, ids.managerA],
        ],
      ] as const) {
        await revoker.query("BEGIN");
        await revoker.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
        await revoker.query("SET LOCAL lock_timeout = '100ms'");
        await expect(revoker.query(text, [...values])).rejects.toMatchObject({ code: "55P03" });
        await revoker.query("ROLLBACK");
      }
      await actor.query("ROLLBACK");
    } finally {
      await revoker.query("ROLLBACK").catch(() => undefined);
      await actor.query("ROLLBACK").catch(() => undefined);
      revoker.release();
      actor.release();
    }
    expect(
      (await tenantQuery(ids.tenantA, "SELECT capability_id FROM membership_capabilities")).rows,
    ).toHaveLength(1);
  });

  it("installs the bounded workforce-profile service-control projection", async () => {
    const columns = await migrationPool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'hr_workforce_profile_service_control'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "service_control_id",
      "tenant_id",
      "service_key",
      "settings_version",
      "updated_at",
      "row_version",
    ]);

    const constraints = await migrationPool.query<{ definition: string; name: string }>(
      `SELECT conname AS name, pg_catalog.pg_get_constraintdef(oid) AS definition
       FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.hr_workforce_profile_service_control'::regclass
       ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.name)).toEqual([
      "hr_workforce_profile_service_control_activation_fk",
      "hr_workforce_profile_service_control_key_exact",
      "hr_workforce_profile_service_control_pkey",
      "hr_workforce_profile_service_control_row_version_positive",
      "hr_workforce_profile_service_control_settings_version_positive",
    ]);
    expect(
      constraints.rows.find(
        (row) => row.name === "hr_workforce_profile_service_control_activation_fk",
      )?.definition,
    ).toContain(
      "FOREIGN KEY (tenant_id, service_key) REFERENCES service_activations(tenant_id, service_key)",
    );

    const indexDefinition = await migrationPool.query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'hr_workforce_profile_service_control'
         AND indexname = 'uq_hr_workforce_profile_service_control_tenant_key'`,
    );
    expect(indexDefinition.rows).toHaveLength(1);
    expect(indexDefinition.rows[0]?.indexdef).toContain(
      "UNIQUE INDEX uq_hr_workforce_profile_service_control_tenant_key",
    );
    expect(indexDefinition.rows[0]?.indexdef).toContain("(tenant_id, service_key)");

    const policy = await migrationPool.query<{ policy: string }>(
      `SELECT policyname || '|' || cmd || '|' || qual || '|' || with_check AS policy
       FROM pg_catalog.pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'hr_workforce_profile_service_control'`,
    );
    expect(policy.rows[0]?.policy).toBe(
      "hr_workforce_profile_service_control_tenant_isolation|ALL|" +
        "(tenant_id = esbla_current_tenant_id())|(tenant_id = esbla_current_tenant_id())",
    );

    const functions = await migrationPool.query<{
      config: string;
      name: string;
      owner: string;
      security_definer: boolean;
    }>(
      `SELECT proname AS name,
              prosecdef AS security_definer,
              owner.rolname AS owner,
              proconfig[1] AS config
       FROM pg_catalog.pg_proc
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = proowner
       WHERE pronamespace = 'public'::regnamespace
         AND proname = ANY($1::text[])
       ORDER BY proname`,
      [
        [
          "esbla_enforce_hr_workforce_profile_service_control",
          "esbla_sync_hr_workforce_profile_service_activation",
        ],
      ],
    );
    expect(functions.rows.map((row) => row.name)).toEqual([
      "esbla_enforce_hr_workforce_profile_service_control",
      "esbla_sync_hr_workforce_profile_service_activation",
    ]);
    expect(functions.rows.map((row) => row.security_definer)).toEqual([false, true]);
    expect(functions.rows.every((row) => row.owner === "esbla_migrator")).toBe(true);
    expect(functions.rows.every((row) => row.config === "search_path=pg_catalog, public")).toBe(
      true,
    );
    const executionPrivileges = await migrationPool.query<{
      delete_allowed: boolean;
      enforce_allowed: boolean;
      insert_allowed: boolean;
      select_allowed: boolean;
      sync_allowed: boolean;
      update_allowed: boolean;
    }>(
      `SELECT pg_catalog.has_table_privilege(
                'esbla_app', 'public.hr_workforce_profile_service_control', 'SELECT'
              ) AS select_allowed,
              pg_catalog.has_table_privilege(
                'esbla_app', 'public.hr_workforce_profile_service_control', 'INSERT'
              ) AS insert_allowed,
              pg_catalog.has_table_privilege(
                'esbla_app', 'public.hr_workforce_profile_service_control', 'UPDATE'
              ) AS update_allowed,
              pg_catalog.has_table_privilege(
                'esbla_app', 'public.hr_workforce_profile_service_control', 'DELETE'
              ) AS delete_allowed,
              pg_catalog.has_function_privilege(
                'esbla_app',
                'public.esbla_enforce_hr_workforce_profile_service_control()',
                'EXECUTE'
              ) AS enforce_allowed,
              pg_catalog.has_function_privilege(
                'esbla_app',
                'public.esbla_sync_hr_workforce_profile_service_activation()',
                'EXECUTE'
              ) AS sync_allowed`,
    );
    expect(executionPrivileges.rows).toEqual([
      {
        delete_allowed: false,
        enforce_allowed: false,
        insert_allowed: false,
        select_allowed: true,
        sync_allowed: false,
        update_allowed: false,
      },
    ]);
  });

  it("keeps workforce-profile metadata synchronized, isolated, stable, and fail-closed", async () => {
    type ServiceControlRow = {
      row_version: number;
      service_control_id: string;
      service_key: string;
      settings_version: number;
      tenant_id: string;
      updated_at: string;
    };
    const readControl = async (tenantId: string) =>
      await tenantQuery<ServiceControlRow>(
        tenantId,
        `SELECT service_control_id::text,
                tenant_id::text,
                service_key,
                settings_version,
                updated_at::text,
                row_version
         FROM hr_workforce_profile_service_control
         ORDER BY service_control_id`,
      );

    await tenantQuery(
      ids.tenantA,
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)`,
      [ids.tenantA],
    );
    const createdA = await readControl(ids.tenantA);
    expect(createdA.rows[0]).toMatchObject({
      row_version: 1,
      service_key: "workforce_profile",
      settings_version: 1,
      tenant_id: ids.tenantA,
    });
    const stableServiceControlId = createdA.rows[0]?.service_control_id;
    const createdAt = createdA.rows[0]?.updated_at;
    expect(stableServiceControlId).toMatch(/^[0-9a-f-]{36}$/);

    const noContext = await pool.query("SELECT * FROM hr_workforce_profile_service_control");
    expect(noContext.rows).toEqual([]);
    expect((await readControl(ids.tenantB)).rows).toEqual([]);

    await expect(
      tenantTransaction(ids.tenantA, async (client) => {
        await client.query("CREATE TEMP TABLE workforce_profile_spoof (id integer) ON COMMIT DROP");
        await client.query(
          `CREATE FUNCTION pg_temp.spoof_workforce_profile_projection() RETURNS trigger
           LANGUAGE plpgsql
           AS $$
           BEGIN
             UPDATE public.hr_workforce_profile_service_control
             SET row_version = row_version + 1,
                 updated_at = updated_at + interval '1 microsecond'
             WHERE tenant_id = current_setting('app.tenant_id')::uuid;
             RETURN NEW;
           END
           $$`,
        );
        await client.query(
          `CREATE TRIGGER workforce_profile_spoof_nested_update
           AFTER INSERT ON workforce_profile_spoof
           FOR EACH ROW EXECUTE FUNCTION pg_temp.spoof_workforce_profile_projection()`,
        );
        await client.query("INSERT INTO workforce_profile_spoof (id) VALUES (1)");
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await readControl(ids.tenantA)).rows[0]).toMatchObject({
      row_version: 1,
      service_control_id: stableServiceControlId,
    });

    await tenantQuery(
      ids.tenantA,
      `UPDATE service_activations
       SET state = 'inactive', version = 2
       WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
      [ids.tenantA],
    );
    const deactivatedA = await readControl(ids.tenantA);
    expect(deactivatedA.rows[0]).toMatchObject({
      row_version: 2,
      service_control_id: stableServiceControlId,
      settings_version: 1,
    });
    expect(Date.parse(deactivatedA.rows[0]?.updated_at ?? "")).toBeGreaterThan(
      Date.parse(createdAt ?? ""),
    );

    await tenantQuery(
      ids.tenantB,
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)`,
      [ids.tenantB],
    );
    const createdB = await readControl(ids.tenantB);

    const transitionTenantB = async () =>
      await tenantQuery(
        ids.tenantB,
        `UPDATE service_activations
         SET state = 'inactive', version = 2
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
        [ids.tenantB],
      );
    const readTenantBAuthority = async () =>
      await tenantQuery<{ state: string; version: number }>(
        ids.tenantB,
        `SELECT state::text, version
         FROM service_activations
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
        [ids.tenantB],
      );

    const removed = await withServiceControlGuardDisabled(
      ids.tenantB,
      async (client) =>
        await client.query(
          `DELETE FROM hr_workforce_profile_service_control
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
          [ids.tenantB],
        ),
    );
    expect(removed.rowCount).toBe(1);
    await expect(transitionTenantB()).rejects.toMatchObject({ code: "55000" });
    expect((await readTenantBAuthority()).rows).toEqual([{ state: "active", version: 1 }]);

    await withServiceControlGuardDisabled(
      ids.tenantB,
      async (client) =>
        await client.query(
          `INSERT INTO hr_workforce_profile_service_control
           (service_control_id, tenant_id, service_key, settings_version, updated_at, row_version)
         VALUES ($1, $2, 'workforce_profile', 1, $3, 1)`,
          [createdB.rows[0]?.service_control_id, ids.tenantB, createdB.rows[0]?.updated_at],
        ),
    );
    await withServiceControlGuardDisabled(
      ids.tenantB,
      async (client) =>
        await client.query(
          `UPDATE hr_workforce_profile_service_control
         SET row_version = 2,
             updated_at = updated_at + interval '1 microsecond'
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
          [ids.tenantB],
        ),
    );
    await expect(transitionTenantB()).rejects.toMatchObject({ code: "55000" });
    expect((await readTenantBAuthority()).rows).toEqual([{ state: "active", version: 1 }]);
    expect((await readControl(ids.tenantB)).rows[0]?.row_version).toBe(2);

    await withServiceControlGuardDisabled(
      ids.tenantB,
      async (client) =>
        await client.query(
          `UPDATE hr_workforce_profile_service_control
         SET row_version = 1,
             updated_at = $2
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
          [ids.tenantB, createdB.rows[0]?.updated_at],
        ),
    );

    await expect(
      migrationTenantTransaction(
        ids.tenantA,
        async (client) =>
          await client.query(
            `UPDATE hr_workforce_profile_service_control
           SET settings_version = settings_version + 1
           WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
            [ids.tenantA],
          ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      migrationTenantTransaction(
        ids.tenantA,
        async (client) =>
          await client.query(
            `DELETE FROM hr_workforce_profile_service_control
           WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
            [ids.tenantA],
          ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      migrationTenantTransaction(
        ids.tenantA,
        async (client) => await client.query("TRUNCATE hr_workforce_profile_service_control"),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    expect((await readControl(ids.tenantB)).rows[0]).toMatchObject({
      row_version: 1,
      service_control_id: createdB.rows[0]?.service_control_id,
      settings_version: 1,
    });
  });

  it("enforces the workforce-profile lifecycle, protected history, and exact Runtime ACL", async () => {
    const privileges = await migrationPool.query<{ actual: boolean[] }>(
      `SELECT ARRAY[
         has_table_privilege('esbla_app', 'hr_worker_profiles', 'SELECT'),
         has_table_privilege('esbla_app', 'hr_worker_profiles', 'INSERT'),
         has_table_privilege('esbla_app', 'hr_worker_profiles', 'UPDATE'),
         has_table_privilege('esbla_app', 'hr_worker_profiles', 'DELETE'),
         has_table_privilege('esbla_app', 'hr_worker_profiles', 'TRUNCATE'),
         has_table_privilege('esbla_app', 'hr_worker_profiles', 'REFERENCES'),
         has_table_privilege('esbla_app', 'hr_worker_profiles', 'TRIGGER'),
         has_table_privilege('esbla_app', 'hr_workforce_status_history', 'SELECT'),
         has_table_privilege('esbla_app', 'hr_workforce_status_history', 'INSERT'),
         has_table_privilege('esbla_app', 'hr_workforce_status_history', 'UPDATE'),
         has_table_privilege('esbla_app', 'hr_workforce_status_history', 'REFERENCES'),
         has_table_privilege('esbla_app', 'hr_workforce_status_history', 'TRIGGER'),
         has_function_privilege(
           'esbla_app', 'esbla_append_hr_workforce_status_history()', 'EXECUTE'
         )
       ] AS actual`,
    );
    expect(privileges.rows[0]?.actual).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);

    await tenantQuery(
      ids.tenantA,
      `UPDATE service_activations SET state = 'active', version = 3
       WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
      [ids.tenantA],
    );
    const mutate = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> =>
      await tenantTransaction(ids.tenantA, async (client) => {
        await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.managerA]);
        await client.query("SELECT set_config('app.correlation_id', $1, true)", [ids.correlation]);
        return await operation(client);
      });
    for (const [actor, correlation] of [
      [null, ids.correlation],
      ["not-a-uuid", ids.correlation],
      [ids.managerA, null],
      [ids.managerA, "not-a-uuid"],
    ] as const) {
      await expect(
        tenantTransaction(ids.tenantA, async (client) => {
          if (actor)
            await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [actor]);
          if (correlation)
            await client.query("SELECT set_config('app.correlation_id', $1, true)", [correlation]);
          await client.query("INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1)", [
            ids.tenantA,
          ]);
        }),
      ).rejects.toMatchObject({ code: "22023" });
    }

    const created = await mutate(
      async (client) =>
        await client.query<{ server_time: boolean; worker_profile_id: string }>(
          `INSERT INTO hr_worker_profiles
             (worker_profile_id, tenant_id, employee_number, created_at, updated_at)
           VALUES ($1, $2, ' WF-0001 ', '2099-01-01', '2099-01-01')
           RETURNING worker_profile_id::text,
             created_at = updated_at AND created_at < '2099-01-01'::timestamptz AS server_time`,
          [ids.subject, ids.tenantA],
        ),
    );
    const profileId = created.rows[0]?.worker_profile_id;
    if (!profileId) throw new Error("Workforce profile identifier was not returned");
    expect(profileId).not.toBe(ids.subject);
    expect(created.rows[0]?.server_time).toBe(true);
    await expect(
      mutate(
        async (client) =>
          await client.query(
            `INSERT INTO hr_worker_profiles
               (tenant_id, current_reporting_relationship_id)
             VALUES ($1, $2)`,
            [ids.tenantA, ids.subject],
          ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    expect((await tenantQuery(ids.tenantB, "SELECT * FROM hr_worker_profiles")).rows).toEqual([]);
    const history = async () =>
      await tenantQuery<{ new_status: string; previous_status: string | null }>(
        ids.tenantA,
        `SELECT previous_status::text, new_status::text
         FROM hr_workforce_status_history WHERE worker_profile_id = $1
         ORDER BY effective_at, workforce_status_history_id`,
        [profileId],
      );
    expect((await history()).rows).toEqual([{ new_status: "draft", previous_status: null }]);
    const initialClock = await tenantQuery<{ server_time: boolean }>(
      ids.tenantA,
      `SELECT history.effective_at = profile.created_at
          AND history.effective_at < '2099-01-01'::timestamptz AS server_time
       FROM hr_workforce_status_history history
       JOIN hr_worker_profiles profile USING (tenant_id, worker_profile_id)
       WHERE history.worker_profile_id = $1 AND history.previous_status IS NULL`,
      [profileId],
    );
    expect(initialClock.rows[0]?.server_time).toBe(true);

    const memberStatus = async (status: "active" | "suspended") =>
      await tenantQuery(
        ids.tenantA,
        "UPDATE memberships SET status = $3 WHERE tenant_id = $1 AND principal_id = $2",
        [ids.tenantA, ids.employeeA, status],
      );
    const link = async (id: string) =>
      await mutate(
        async (client) =>
          await client.query(
            `UPDATE hr_worker_profiles SET principal_id = $2, row_version = 2
             WHERE tenant_id = $1 AND worker_profile_id = $3`,
            [ids.tenantA, ids.employeeA, id],
          ),
      );
    const transition = async (status: string, version: number) =>
      await mutate(
        async (client) =>
          await client.query(
            `UPDATE hr_worker_profiles SET workforce_status = $3, row_version = $4
             WHERE tenant_id = $1 AND worker_profile_id = $2`,
            [ids.tenantA, profileId, status, version],
          ),
      );

    await memberStatus("suspended");
    await expect(link(profileId)).rejects.toMatchObject({ code: "55000" });
    await memberStatus("active");
    await link(profileId);
    expect((await history()).rows).toHaveLength(1);
    await expect(
      migrationTenantTransaction(
        ids.tenantA,
        async (client) =>
          await client.query(
            `INSERT INTO hr_workforce_status_history
               (tenant_id, worker_profile_id, previous_status, new_status,
                effective_at, actor_principal_id, correlation_id)
             VALUES ($1, $2, NULL, 'active', now(), $3, $4)`,
            [ids.tenantA, profileId, ids.managerA, ids.correlation],
          ),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    for (const [sql, values] of [
      [
        `UPDATE hr_worker_profiles SET principal_id = $2, workforce_status = 'active',
           row_version = 3 WHERE tenant_id = $1 AND worker_profile_id = $3`,
        [ids.tenantA, ids.managerA, profileId],
      ],
      [
        `UPDATE hr_worker_profiles SET workforce_status = 'active', row_version = 2
         WHERE tenant_id = $1 AND worker_profile_id = $2`,
        [ids.tenantA, profileId],
      ],
      [
        `UPDATE hr_worker_profiles SET employee_number = 'CHANGED', row_version = 3
         WHERE tenant_id = $1 AND worker_profile_id = $2`,
        [ids.tenantA, profileId],
      ],
    ] as const)
      await expect(
        mutate(async (client) => await client.query(sql, [...values])),
      ).rejects.toMatchObject({ code: "55000" });

    const second = await mutate(
      async (client) =>
        await client.query<{ worker_profile_id: string }>(
          "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id::text",
          [ids.tenantA],
        ),
    );
    const secondProfileId = second.rows[0]?.worker_profile_id;
    if (!secondProfileId) throw new Error("Second workforce profile identifier was not returned");
    await memberStatus("suspended");
    await expect(transition("active", 3)).rejects.toMatchObject({ code: "55000" });
    await memberStatus("active");
    await transition("active", 3);
    await expect(link(secondProfileId)).rejects.toMatchObject({ code: "23505" });
    await transition("suspended", 4);
    await transition("active", 5);
    await transition("terminated", 6);
    await expect(transition("suspended", 7)).rejects.toMatchObject({ code: "55000" });
    const linker = await pool.connect();
    const contender = await migrationPool.connect();
    try {
      for (const [sql, values] of [
        [
          "SELECT 1 FROM service_activations WHERE tenant_id = $1 AND service_key = 'workforce_profile' FOR UPDATE",
          [ids.tenantA],
        ],
        [
          "SELECT 1 FROM memberships WHERE tenant_id = $1 AND principal_id = $2 FOR UPDATE",
          [ids.tenantA, ids.employeeA],
        ],
      ] as const) {
        await contender.query("BEGIN");
        await contender.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
        await contender.query(sql, [...values]);
        await expect(link(secondProfileId)).rejects.toMatchObject({ code: "55P03" });
        await contender.query("ROLLBACK");
      }
      await linker.query("BEGIN");
      await linker.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await linker.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.managerA]);
      await linker.query("SELECT set_config('app.correlation_id', $1, true)", [ids.correlation]);
      expect(
        (
          await linker.query(
            `UPDATE hr_worker_profiles SET principal_id = $2, row_version = 2
             WHERE tenant_id = $1 AND worker_profile_id = $3`,
            [ids.tenantA, ids.employeeA, secondProfileId],
          )
        ).rowCount,
      ).toBe(1);
      for (const [sql, values] of [
        [
          `UPDATE service_activations SET state = 'inactive', version = 4
           WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
          [ids.tenantA],
        ],
        [
          "UPDATE memberships SET status = 'suspended' WHERE tenant_id = $1 AND principal_id = $2",
          [ids.tenantA, ids.employeeA],
        ],
      ] as const) {
        await contender.query("BEGIN");
        await contender.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
        await contender.query("SET LOCAL lock_timeout = '100ms'");
        await expect(contender.query(sql, [...values])).rejects.toMatchObject({ code: "55P03" });
        await contender.query("ROLLBACK");
      }
      await linker.query("COMMIT");
    } finally {
      await linker.query("ROLLBACK").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      linker.release();
      contender.release();
    }
    expect((await history()).rows).toEqual([
      { new_status: "draft", previous_status: null },
      { new_status: "active", previous_status: "draft" },
      { new_status: "suspended", previous_status: "active" },
      { new_status: "active", previous_status: "suspended" },
      { new_status: "terminated", previous_status: "active" },
    ]);
    await expect(
      tenantQuery(ids.tenantA, "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1)", [
        ids.tenantB,
      ]),
    ).rejects.toMatchObject({ code: "55000" });

    for (const [sql, values, code] of [
      ["DELETE FROM hr_worker_profiles WHERE worker_profile_id = $1", [profileId], "55000"],
      ["TRUNCATE hr_worker_profiles CASCADE", [], "55000"],
    ] as const) {
      await expect(
        migrationTenantTransaction(
          ids.tenantA,
          async (client) => await client.query(sql, [...values]),
        ),
      ).rejects.toMatchObject({ code });
    }
    for (const [sql, values] of [
      [
        "UPDATE hr_workforce_status_history SET correlation_id = $1 WHERE worker_profile_id = $2",
        [ids.correlation, profileId],
      ],
      ["DELETE FROM hr_workforce_status_history WHERE worker_profile_id = $1", [profileId]],
      ["TRUNCATE hr_workforce_status_history", []],
    ] as const) {
      await expect(
        migrationTenantTransaction(
          ids.tenantA,
          async (client) => await client.query(sql, [...values]),
        ),
      ).rejects.toMatchObject({ code: "55000" });
    }

    await tenantQuery(
      ids.tenantA,
      `UPDATE service_activations SET state = 'inactive', version = 4
       WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
      [ids.tenantA],
    );
    await expect(
      mutate(
        async (client) =>
          await client.query("INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1)", [
            ids.tenantA,
          ]),
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("fails closed without tenant context and filters reads to the current tenant", async () => {
    const noContext = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM memberships");
    expect(noContext.rows).toEqual([]);

    const tenantA = await tenantQuery<{ tenant_id: string }>(
      ids.tenantA,
      "SELECT tenant_id FROM memberships ORDER BY principal_id",
    );
    const tenantB = await tenantQuery<{ tenant_id: string }>(
      ids.tenantB,
      "SELECT tenant_id FROM memberships ORDER BY principal_id",
    );

    expect(tenantA.rows).toHaveLength(2);
    expect(tenantB.rows).toHaveLength(2);
    expect(tenantA.rows.every((row) => row.tenant_id === ids.tenantA)).toBe(true);
    expect(tenantB.rows.every((row) => row.tenant_id === ids.tenantB)).toBe(true);
  });

  it("rejects cross-tenant writes and cross-tenant manager references", async () => {
    await expect(
      tenantQuery(
        ids.tenantA,
        `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
         VALUES ('20000000-0000-4000-8000-000000000099', $1, $2, 'employee')`,
        [ids.tenantB, ids.employeeA],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      tenantQuery(
        ids.tenantA,
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ('20000000-0000-4000-8000-000000000098', $1, $2, 'employee', $3)`,
        [ids.tenantA, ids.employeeB, ids.managerB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps evidence append-only and deduplicated", async () => {
    await tenantQuery(
      ids.tenantA,
      `INSERT INTO evidence_events
         (evidence_event_id, tenant_id, event_type, subject_type, subject_id, actor_principal_id,
          correlation_id, prior_state, new_state)
       VALUES ($1, $2, 'evidence.hr.test', 'hr.test', $3, $4, $5, NULL, 'created')`,
      [ids.evidence, ids.tenantA, ids.subject, ids.managerA, ids.correlation],
    );

    await expect(
      tenantQuery(
        ids.tenantA,
        `INSERT INTO evidence_events
           (tenant_id, event_type, subject_type, subject_id, actor_principal_id,
            correlation_id, prior_state, new_state)
         VALUES ($1, 'evidence.hr.test', 'hr.test', $2, $3, $4, NULL, 'created')`,
        [ids.tenantA, ids.subject, ids.managerA, ids.correlation],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      tenantQuery(
        ids.tenantA,
        "UPDATE evidence_events SET new_state = 'changed' WHERE evidence_event_id = $1",
        [ids.evidence],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(tenantQuery(ids.tenantA, "TRUNCATE evidence_events")).rejects.toMatchObject({
      code: "42501",
    });

    const migrationClient = await migrationPool.connect();
    try {
      await migrationClient.query("BEGIN");
      await migrationClient.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await expect(
        migrationClient.query(
          "UPDATE evidence_events SET new_state = 'changed' WHERE evidence_event_id = $1",
          [ids.evidence],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await migrationClient.query("ROLLBACK");

      await migrationClient.query("BEGIN");
      await migrationClient.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await expect(migrationClient.query("TRUNCATE evidence_events")).rejects.toMatchObject({
        code: "55000",
      });
      await migrationClient.query("ROLLBACK");
    } finally {
      migrationClient.release();
    }
  });

  it("enforces outbox idempotency and work-item completion consistency", async () => {
    await tenantQuery(
      ids.tenantA,
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, aggregate_type, aggregate_id,
          aggregate_version, correlation_id, payload)
       VALUES ($1, $2, 'hr.test.created', 'hr.test', $3, 1, $4,
               '{"status":"created"}'::jsonb)`,
      [ids.outbox, ids.tenantA, ids.subject, ids.correlation],
    );
    await expect(
      tenantQuery(
        ids.tenantA,
        `INSERT INTO outbox_events
           (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version,
            correlation_id, payload)
         VALUES ($1, 'hr.test.created', 'hr.test', $2, 1, $3, '{}'::jsonb)`,
        [ids.tenantA, ids.subject, ids.correlation],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await tenantQuery(
      ids.tenantA,
      `INSERT INTO work_items
         (work_item_id, tenant_id, assignee_principal_id, work_type, subject_type, subject_id)
       VALUES ($1, $2, $3, 'hr.test.approval', 'hr.test', $4)`,
      [ids.workItem, ids.tenantA, ids.managerA, ids.subject],
    );
    await expect(
      tenantQuery(
        ids.tenantA,
        "UPDATE work_items SET status = 'completed' WHERE work_item_id = $1",
        [ids.workItem],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps tenant resolution safe under a hostile caller search path", async () => {
    const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
    if (!migrationConnectionString) throw new Error("Migration connection is required");
    const attackPool = createDatabasePool(migrationConnectionString, { max: 1 });
    const client = await attackPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE SCHEMA attacker");
      await client.query(
        `CREATE FUNCTION attacker.current_setting(text, boolean) RETURNS text
         LANGUAGE sql IMMUTABLE
         AS $$ SELECT '00000000-0000-4000-8000-000000000099'::text $$`,
      );
      await client.query("SET LOCAL search_path TO attacker, pg_catalog, public");
      await client.query("SELECT pg_catalog.set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      const resolved = await client.query<{ tenant_id: string }>(
        "SELECT public.esbla_current_tenant_id()::text AS tenant_id",
      );
      expect(resolved.rows).toEqual([{ tenant_id: ids.tenantA }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await attackPool.end();
    }
  });

  it("holds one migration barrier across Drizzle preamble, DDL, and ledger commit", async () => {
    const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
    if (!migrationConnectionString) throw new Error("Migration connection is required");
    const singleConnectionPool = createDatabasePool(migrationConnectionString, { max: 1 });
    const observerPool = createDatabasePool(migrationConnectionString, { max: 2 });
    const runtimeClient = await pool.connect();
    const gateClient = await observerPool.connect();
    let migration: Promise<void> | undefined;
    let runtimeOpen = false;
    let gateHeld = false;
    let secondRuntimeClient: PoolClient | undefined;
    let secondRuntimeOpen = false;
    try {
      await runtimeClient.query("BEGIN");
      runtimeOpen = true;
      await runtimeClient.query(
        "SELECT pg_catalog.pg_advisory_xact_lock_shared($1::integer, $2::integer)",
        [...migrationBarrierKey],
      );
      await gateClient.query("SELECT pg_catalog.pg_advisory_lock($1::integer, $2::integer)", [
        ...migrationTestGateKey,
      ]);
      gateHeld = true;

      migration = migrateDatabase(createDatabase(singleConnectionPool), migrationBarrierFixture);
      await waitForAdvisoryLock(observerPool, migrationBarrierKey, "ExclusiveLock", false);
      await runtimeClient.query("COMMIT");
      runtimeOpen = false;

      const migrationBackend = await waitForAdvisoryLock(
        observerPool,
        migrationBarrierKey,
        "ExclusiveLock",
        true,
      );
      await waitForAdvisoryLock(observerPool, migrationTestGateKey, "ExclusiveLock", false);

      secondRuntimeClient = await pool.connect();
      await secondRuntimeClient.query("BEGIN");
      secondRuntimeOpen = true;
      const secondShared = secondRuntimeClient.query(
        "SELECT pg_catalog.pg_advisory_xact_lock_shared($1::integer, $2::integer)",
        [...migrationBarrierKey],
      );
      await waitForAdvisoryLock(observerPool, migrationBarrierKey, "ShareLock", false);

      await gateClient.query("SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer)", [
        ...migrationTestGateKey,
      ]);
      gateHeld = false;
      await migration;
      await secondShared;
      await secondRuntimeClient.query("COMMIT");
      secondRuntimeOpen = false;

      const probe = await observerPool.query<{ backend_pid: number }>(
        "SELECT backend_pid FROM public.migration_barrier_probe",
      );
      expect(probe.rows).toEqual([{ backend_pid: migrationBackend }]);
      await waitForAdvisoryLockAbsence(observerPool, migrationBarrierKey);

      await expect(
        migrateDatabase(createDatabase(singleConnectionPool), `${migrationBarrierFixture}-missing`),
      ).rejects.toThrow();
      await waitForAdvisoryLockAbsence(observerPool, migrationBarrierKey);
      const recovered = await singleConnectionPool.query<{ value: number }>(
        "SELECT 1::integer AS value",
      );
      expect(recovered.rows).toEqual([{ value: 1 }]);
    } finally {
      if (runtimeOpen) await runtimeClient.query("ROLLBACK").catch(() => undefined);
      if (secondRuntimeOpen) await secondRuntimeClient?.query("ROLLBACK").catch(() => undefined);
      if (gateHeld) {
        await gateClient
          .query("SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer)", [
            ...migrationTestGateKey,
          ])
          .catch(() => undefined);
      }
      await migration?.catch(() => undefined);
      secondRuntimeClient?.release();
      runtimeClient.release();
      gateClient.release();
      await singleConnectionPool.end();
      await observerPool.end();
    }
  });
});
