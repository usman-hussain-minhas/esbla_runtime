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
    expect(migrations.rows[0]?.count).toBe("5");

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
          "memberships",
          "outbox_events",
          "service_activations",
          "tenant_settings",
          "work_items",
          "workspace_tasks",
        ],
      ],
    );

    expect(rowSecurity.rows).toHaveLength(8);
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
});
