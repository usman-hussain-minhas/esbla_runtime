import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  admin: "04000000-0000-4000-8000-000000000003",
  membership: "04000000-0000-4000-8000-000000000004",
  membershipOther: "04000000-0000-4000-8000-000000000005",
  tenant: "04000000-0000-4000-8000-000000000001",
  tenantOther: "04000000-0000-4000-8000-000000000002",
} as const;
const configureSql = "SELECT public.esbla_configure_hr_workforce_profile_settings($1, $2, $3, $4)";
let applicationRole = "";
let migrationPool: Pool;
let runtimePool: Pool;

async function tenantTransaction<T>(
  source: Pool,
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await source.connect();
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
async function setAuthority(client: PoolClient): Promise<void> {
  await client.query(
    "SELECT set_config('app.actor_principal_id',$1,true), set_config('app.correlation_id',$2,true)",
    [ids.admin, randomUUID()],
  );
}
async function configure(
  tenantId: string,
  expectedSettingsVersion: number,
  employeeNumberRequired: boolean,
  managerVisibility: string,
  unlinkedWorkerCreationAllowed: boolean,
): Promise<void> {
  await tenantTransaction(migrationPool, tenantId, async (client) => {
    await setAuthority(client);
    await client.query(configureSql, [
      expectedSettingsVersion,
      employeeNumberRequired,
      managerVisibility,
      unlinkedWorkerCreationAllowed,
    ]);
  });
}

function exactSettings(
  employeeNumberRequired: boolean,
  managerVisibility: "minimized" | "none",
  unlinkedWorkerCreationAllowed: boolean,
  version: number,
) {
  return [
    ["hr.workforce_profile.employee_number_required", "boolean", employeeNumberRequired],
    ["hr.workforce_profile.manager_visibility", "enum", managerVisibility],
    [
      "hr.workforce_profile.unlinked_worker_creation_allowed",
      "boolean",
      unlinkedWorkerCreationAllowed,
    ],
  ].map(([setting_key, value_type, value]) => ({ setting_key, value, value_type, version }));
}

function exactControl(
  activation_state: string,
  activation_version: number,
  row_version: number,
  settings_version: number,
) {
  return [{ activation_state, activation_version, row_version, settings_version }];
}

async function snapshot(tenantId: string = ids.tenant) {
  return await tenantTransaction(migrationPool, tenantId, async (client) => {
    const control = await client.query(
      `SELECT activation.state AS activation_state,
              activation.version AS activation_version,
              control.settings_version, control.row_version
       FROM hr_workforce_profile_service_control control
       JOIN service_activations activation
         ON activation.tenant_id = control.tenant_id
        AND activation.service_key = control.service_key
       WHERE control.tenant_id = $1 AND control.service_key = 'workforce_profile'`,
      [tenantId],
    );
    const settings = await client.query(
      `SELECT setting_key, value_type, value, version FROM tenant_settings
       WHERE tenant_id = $1 AND setting_key LIKE 'hr.workforce_profile.%'
       ORDER BY setting_key`,
      [tenantId],
    );
    return { control: control.rows, settings: settings.rows };
  });
}

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL harness environment is required");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  runtimePool = createDatabasePool(runtimeUrl, { max: 2 });
  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(
    `REVOKE ALL ON tenant_settings, hr_workforce_profile_service_control FROM ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT ON service_activations, tenant_settings,
       hr_workforce_profile_service_control TO ${applicationRole}`,
  );
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Settings Tenant'), ($2, 'Other Settings Tenant')`,
    [ids.tenant, ids.tenantOther],
  );
  await migrationPool.query(
    "INSERT INTO principals (principal_id, display_name) VALUES ($1, 'Settings Admin')",
    [ids.admin],
  );
  for (const [tenantId, membershipId] of [
    [ids.tenant, ids.membership],
    [ids.tenantOther, ids.membershipOther],
  ] as const) {
    await tenantTransaction(migrationPool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
         VALUES ($1, 'workforce_profile', 'active', 1)`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ($1, $2, $3, 'tenant_admin', NULL)`,
        [membershipId, tenantId, ids.admin],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.workforce.configure_service')`,
        [tenantId, ids.admin],
      );
    });
  }
});

afterAll(async () => {
  if (runtimePool) await runtimePool.end();
  if (migrationPool) await migrationPool.end();
});

describe("Workforce Profile settings persistence kernel", () => {
  it("installs one exact application boundary without direct table-write authority", async () => {
    const catalog = await migrationPool.query(
      `SELECT pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
                'integer, boolean, text, boolean'
              AND language.lanname = 'plpgsql'
              AND pg_catalog.format_type(procedure.prorettype, NULL) = 'void'
              AND procedure.provolatile = 'v'
              AND COALESCE(pg_catalog.array_to_string(procedure.proconfig, ','), '') =
                'search_path=pg_catalog, public'
              AND procedure.prosecdef AND procedure.proowner = role.oid
              AND NOT procedure.proleakproof AND NOT procedure.proisstrict
              AND NOT procedure.proretset
              AND pg_catalog.has_function_privilege($1, procedure.oid, 'EXECUTE')
              AND NOT pg_catalog.has_function_privilege('public', procedure.oid, 'EXECUTE')
              AND (SELECT pg_catalog.count(*) = 2
                            AND pg_catalog.count(*) FILTER (
                              WHERE privilege.grantee = procedure.proowner
                            ) = 1
                            AND pg_catalog.count(*) FILTER (
                              WHERE privilege.grantee = application.oid
                            ) = 1
                     FROM pg_catalog.aclexplode(COALESCE(
                       procedure.proacl, pg_catalog.acldefault('f', procedure.proowner)
                     )) privilege
                     WHERE privilege.privilege_type = 'EXECUTE') AS current
       FROM pg_catalog.pg_proc procedure
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
       JOIN pg_catalog.pg_roles role ON role.rolname = current_user
       JOIN pg_catalog.pg_roles application ON application.rolname = $1
      WHERE namespace.nspname = 'public'
         AND procedure.proname = 'esbla_configure_hr_workforce_profile_settings'`,
      [applicationRole],
    );
    expect(catalog.rows).toEqual([{ current: true }]);
    const privileges = await migrationPool.query(
      `SELECT pg_catalog.bool_and(
                pg_catalog.has_table_privilege($1, name, 'SELECT')
                AND NOT pg_catalog.has_table_privilege($1, name, 'INSERT')
                AND NOT pg_catalog.has_any_column_privilege($1, name, 'INSERT')
                AND NOT pg_catalog.has_table_privilege($1, name, 'UPDATE')
                AND NOT pg_catalog.has_any_column_privilege($1, name, 'UPDATE')
                AND NOT pg_catalog.has_table_privilege($1, name, 'DELETE')
                AND NOT pg_catalog.has_table_privilege($1, name, 'TRUNCATE')
                AND NOT pg_catalog.has_table_privilege($1, name, 'REFERENCES')
                AND NOT pg_catalog.has_any_column_privilege($1, name, 'REFERENCES')
                AND NOT pg_catalog.has_table_privilege($1, name, 'TRIGGER')
              ) AS read_only
       FROM pg_catalog.unnest(ARRAY[
         'tenant_settings', 'hr_workforce_profile_service_control'
       ]) name`,
      [applicationRole],
    );
    expect(privileges.rows).toEqual([{ read_only: true }]);
    const beforeBypass = await snapshot();
    await tenantTransaction(runtimePool, ids.tenant, async (client) => {
      await expect(client.query(configureSql, [1, true, "none", false])).rejects.toMatchObject({
        code: "42501",
      });
    });
    expect(await snapshot()).toEqual(beforeBypass);
  });

  it("serializes exact settings CAS, rollback, tenant scope, and activation", async () => {
    await expect(configure(ids.tenant, 1, true, "all", false)).rejects.toMatchObject({
      code: "22023",
    });
    await configure(ids.tenant, 1, true, "none", false);
    expect(await snapshot()).toEqual({
      control: exactControl("active", 1, 2, 2),
      settings: exactSettings(true, "none", false, 1),
    });
    await expect(configure(ids.tenant, 1, false, "minimized", true)).rejects.toMatchObject({
      code: "40001",
    });
    const concurrent = await Promise.allSettled([
      configure(ids.tenant, 2, false, "minimized", true),
      configure(ids.tenant, 2, true, "none", true),
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "40001" },
    });
    const afterConcurrent = await snapshot();
    expect(afterConcurrent.control).toMatchObject([
      { activation_version: 1, row_version: 3, settings_version: 3 },
    ]);
    expect([
      exactSettings(false, "minimized", true, 2),
      exactSettings(true, "none", true, 2),
    ]).toContainEqual(afterConcurrent.settings);

    const beforeRollback = await snapshot();
    const rollbackClient = await migrationPool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
      await setAuthority(rollbackClient);
      await rollbackClient.query(configureSql, [3, false, "none", false]);
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    expect(await snapshot()).toEqual(beforeRollback);
    expect(await snapshot(ids.tenantOther)).toEqual({
      control: exactControl("active", 1, 1, 1),
      settings: [],
    });

    const blocker = await migrationPool.connect();
    const contender = await migrationPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
      await blocker.query(
        `SELECT 1 FROM service_activations
         WHERE tenant_id = $1 AND service_key = 'workforce_profile' FOR UPDATE`,
        [ids.tenant],
      );
      await contender.query("BEGIN");
      await contender.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
      await setAuthority(contender);
      const pid = (await contender.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      const pending = contender.query(configureSql, [3, true, "none", false]).then(
        () => null,
        (error: unknown) => error,
      );
      await expect
        .poll(async () => {
          const state = await migrationPool.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [pid],
          );
          return state.rows[0]?.wait_event_type;
        })
        .toBe("Lock");
      await blocker.query(
        `UPDATE service_activations SET state = 'inactive', version = 2
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
        [ids.tenant],
      );
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "55000" });
      await contender.query("ROLLBACK");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      contender.release();
    }
    expect((await snapshot()).settings).toEqual(afterConcurrent.settings);
    await tenantTransaction(migrationPool, ids.tenant, async (client) => {
      await client.query(
        `UPDATE service_activations SET state = 'active', version = 3
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
        [ids.tenant],
      );
    });
    await configure(ids.tenant, 3, true, "minimized", false);
    expect(await snapshot()).toEqual({
      control: exactControl("active", 3, 6, 4),
      settings: exactSettings(true, "minimized", false, 3),
    });
  });
});
