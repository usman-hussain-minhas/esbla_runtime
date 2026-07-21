import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  correlation: "53000000-0000-4000-8000-000000000001",
  employee: "13000000-0000-4000-8000-000000000003",
  employeeAlternate: "13000000-0000-4000-8000-000000000004",
  hrOperator: "13000000-0000-4000-8000-000000000001",
  manager: "13000000-0000-4000-8000-000000000002",
  membershipEmployee: "23000000-0000-4000-8000-000000000003",
  membershipEmployeeAlternate: "23000000-0000-4000-8000-000000000004",
  membershipHrOperator: "23000000-0000-4000-8000-000000000001",
  membershipManager: "23000000-0000-4000-8000-000000000002",
  membershipOtherHrOperator: "23000000-0000-4000-8000-000000000011",
  membershipOtherManager: "23000000-0000-4000-8000-000000000012",
  spoofedRelationship: "43000000-0000-4000-8000-000000000001",
  tenant: "03000000-0000-4000-8000-000000000001",
  tenantOther: "03000000-0000-4000-8000-000000000002",
} as const;
let applicationRole: string;
let migrationPool: Pool;
let pool: Pool;
let alternateProfileId: string;
let managerProfileId: string;
let otherManagerProfileId: string;
let unlinkedProfileId: string;
let workerProfileId: string;
const reportingInsert = `INSERT INTO hr_reporting_relationships
  (tenant_id, worker_profile_id, manager_worker_profile_id,
   relationship_status, supersedes_reporting_relationship_id, relationship_version)
  VALUES ($1, $2, $3, $4, $5, $6)`;
const profileStatusUpdate = `UPDATE hr_worker_profiles SET workforce_status = $3,
  row_version = $4 WHERE tenant_id = $1 AND worker_profile_id = $2`;
const serviceStateUpdate = `UPDATE service_activations SET state = $2, version = $3
  WHERE tenant_id = $1 AND service_key = 'workforce_profile'`;

async function tenantTransaction<T>(
  source: Pool,
  tenantId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await source.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.hrOperator]);
    await client.query("SELECT set_config('app.correlation_id', $1, true)", [ids.correlation]);
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

async function activateProfile(
  client: PoolClient,
  tenantId: string,
  principalId: string,
): Promise<string> {
  const created = await client.query<{ worker_profile_id: string }>(
    "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id::text",
    [tenantId],
  );
  const profileId = created.rows[0]?.worker_profile_id;
  if (!profileId) throw new Error("Workforce Profile identifier was unavailable");
  await client.query(
    `UPDATE hr_worker_profiles SET principal_id = $3, row_version = 2
     WHERE tenant_id = $1 AND worker_profile_id = $2`,
    [tenantId, profileId, principalId],
  );
  await client.query(
    `UPDATE hr_worker_profiles SET workforce_status = 'active', row_version = 3
     WHERE tenant_id = $1 AND worker_profile_id = $2`,
    [tenantId, profileId],
  );
  return profileId;
}

async function expectTenantDatabaseError(
  source: Pool,
  tenantId: string,
  statement: string,
  values: readonly unknown[],
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  await expect(
    tenantTransaction(source, tenantId, (client) => client.query(statement, [...values])),
  ).rejects.toMatchObject(expected);
}

async function expectReportingInsertError(
  values: readonly unknown[],
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  await expectTenantDatabaseError(pool, ids.tenant, reportingInsert, values, expected);
}

async function migrationQuery(statement: string, values: readonly unknown[]): Promise<void> {
  await tenantTransaction(migrationPool, ids.tenant, (client) =>
    client.query(statement, [...values]),
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
  await migrationPool.query(
    `GRANT SELECT, UPDATE ON service_activations, memberships, hr_worker_profiles
     TO ${applicationRole}`,
  );
  const reportingAvailable = await migrationPool.query<{ available: boolean }>(
    "SELECT to_regclass('public.hr_reporting_relationships') IS NOT NULL AS available",
  );
  if (reportingAvailable.rows[0]?.available)
    await migrationPool.query(
      `GRANT USAGE ON TYPE hr_reporting_relationship_status TO ${applicationRole};
       GRANT SELECT, INSERT ON hr_reporting_relationships TO ${applicationRole}`,
    );

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Reporting Tenant'), ($2, 'Other Reporting Tenant')`,
    [ids.tenant, ids.tenantOther],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'HR Operator'), ($2, 'Current Manager'),
            ($3, 'Current Worker'), ($4, 'Alternate Worker')`,
    [ids.hrOperator, ids.manager, ids.employee, ids.employeeAlternate],
  );
  await tenantTransaction(migrationPool, ids.tenant, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $4, $2, 'hr_operator'), ($3, $4, $5, 'manager'),
              ($6, $4, $7, 'employee'), ($8, $4, $9, 'employee')`,
      [
        ids.membershipHrOperator,
        ids.hrOperator,
        ids.membershipManager,
        ids.tenant,
        ids.manager,
        ids.membershipEmployee,
        ids.employee,
        ids.membershipEmployeeAlternate,
        ids.employeeAlternate,
      ],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)`,
      [ids.tenant],
    );
    managerProfileId = await activateProfile(client, ids.tenant, ids.manager);
    workerProfileId = await activateProfile(client, ids.tenant, ids.employee);
    alternateProfileId = await activateProfile(client, ids.tenant, ids.employeeAlternate);
    const unlinked = await client.query<{ worker_profile_id: string }>(
      "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id::text",
      [ids.tenant],
    );
    unlinkedProfileId = unlinked.rows[0]?.worker_profile_id ?? "";
    if (!unlinkedProfileId)
      throw new Error("Unlinked Workforce Profile identifier was unavailable");
  });
  await tenantTransaction(migrationPool, ids.tenantOther, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $3, $2, 'hr_operator'), ($4, $3, $5, 'manager')`,
      [
        ids.membershipOtherHrOperator,
        ids.hrOperator,
        ids.tenantOther,
        ids.membershipOtherManager,
        ids.manager,
      ],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)`,
      [ids.tenantOther],
    );
    otherManagerProfileId = await activateProfile(client, ids.tenantOther, ids.manager);
  });
});

afterAll(async () => {
  if (pool) await pool.end();
  if (migrationPool) await migrationPool.end();
});

describe("Workforce reporting persistence kernel", () => {
  it("installs the exact schema, tenant isolation, and least-privilege projection", async () => {
    const catalog = await migrationPool.query<{ force_rls: boolean; rls: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS force_rls
       FROM pg_catalog.pg_class
       WHERE oid = 'public.hr_reporting_relationships'::regclass`,
    );
    expect(catalog.rows).toEqual([{ force_rls: true, rls: true }]);
    const labels = await migrationPool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_catalog.pg_enum
       WHERE enumtypid = 'public.hr_reporting_relationship_status'::regtype
       ORDER BY enumsortorder`,
    );
    expect(labels.rows.map(({ enumlabel }) => enumlabel)).toEqual(["assigned", "unassigned"]);

    const columns = await migrationPool.query<{ definition: string }>(
      `SELECT string_agg(
         column_name || '|' || udt_name || '|' || is_nullable || '|' ||
         COALESCE(column_default, ''), ',' ORDER BY ordinal_position
       ) AS definition
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'hr_reporting_relationships'`,
    );
    expect(columns.rows[0]?.definition).toBe(
      "reporting_relationship_id|uuid|NO|gen_random_uuid(),tenant_id|uuid|NO|,worker_profile_id|uuid|NO|,manager_worker_profile_id|uuid|YES|,relationship_status|hr_reporting_relationship_status|NO|,effective_at|timestamptz|NO|now(),supersedes_reporting_relationship_id|uuid|YES|,relationship_version|int4|NO|,created_at|timestamptz|NO|now(),row_version|int4|NO|1",
    );
    const indexes = await migrationPool.query<{ definition: string }>(
      `SELECT string_agg(indexname || '|' || indexdef, E'\n' ORDER BY indexname) AS definition
       FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND tablename IN (
         'hr_reporting_relationships', 'hr_worker_profiles'
       ) AND indexname = ANY($1::text[])`,
      [
        "idx_hr_reporting_relationships_tenant_manager_current_cursor,idx_hr_reporting_relationships_tenant_worker_history,uq_hr_reporting_relationships_composite_identity,uq_hr_reporting_relationships_tenant_successor,uq_hr_reporting_relationships_tenant_worker_version,uq_hr_worker_profiles_tenant_relationship_head".split(
          ",",
        ),
      ],
    );
    expect(indexes.rows[0]?.definition).toBe(
      `idx_hr_reporting_relationships_tenant_manager_current_cursor|CREATE INDEX idx_hr_reporting_relationships_tenant_manager_current_cursor ON public.hr_reporting_relationships USING btree (tenant_id, manager_worker_profile_id, relationship_status, effective_at DESC, reporting_relationship_id DESC)
idx_hr_reporting_relationships_tenant_worker_history|CREATE INDEX idx_hr_reporting_relationships_tenant_worker_history ON public.hr_reporting_relationships USING btree (tenant_id, worker_profile_id, relationship_version DESC, reporting_relationship_id DESC)
uq_hr_reporting_relationships_composite_identity|CREATE UNIQUE INDEX uq_hr_reporting_relationships_composite_identity ON public.hr_reporting_relationships USING btree (tenant_id, worker_profile_id, reporting_relationship_id)
uq_hr_reporting_relationships_tenant_successor|CREATE UNIQUE INDEX uq_hr_reporting_relationships_tenant_successor ON public.hr_reporting_relationships USING btree (tenant_id, supersedes_reporting_relationship_id) WHERE (supersedes_reporting_relationship_id IS NOT NULL)
uq_hr_reporting_relationships_tenant_worker_version|CREATE UNIQUE INDEX uq_hr_reporting_relationships_tenant_worker_version ON public.hr_reporting_relationships USING btree (tenant_id, worker_profile_id, relationship_version)
uq_hr_worker_profiles_tenant_relationship_head|CREATE UNIQUE INDEX uq_hr_worker_profiles_tenant_relationship_head ON public.hr_worker_profiles USING btree (tenant_id, current_reporting_relationship_id) WHERE (current_reporting_relationship_id IS NOT NULL)`,
    );
    const constraints = await migrationPool.query<{ definition: string }>(
      `SELECT string_agg(
         conname || '|' || pg_catalog.pg_get_constraintdef(oid), E'\n' ORDER BY conname
       ) AS definition
       FROM pg_catalog.pg_constraint WHERE conname = ANY($1::text[])`,
      [
        "hr_reporting_relationships_manager_same_tenant_fk,hr_reporting_relationships_predecessor_same_worker_fk,hr_reporting_relationships_report_same_tenant_fk,hr_worker_profiles_current_relationship_same_root_fk".split(
          ",",
        ),
      ],
    );
    expect(constraints.rows[0]?.definition).toBe(
      `hr_reporting_relationships_manager_same_tenant_fk|FOREIGN KEY (tenant_id, manager_worker_profile_id) REFERENCES hr_worker_profiles(tenant_id, worker_profile_id) ON DELETE RESTRICT
hr_reporting_relationships_predecessor_same_worker_fk|FOREIGN KEY (tenant_id, worker_profile_id, supersedes_reporting_relationship_id) REFERENCES hr_reporting_relationships(tenant_id, worker_profile_id, reporting_relationship_id) ON DELETE RESTRICT
hr_reporting_relationships_report_same_tenant_fk|FOREIGN KEY (tenant_id, worker_profile_id) REFERENCES hr_worker_profiles(tenant_id, worker_profile_id) ON DELETE RESTRICT
hr_worker_profiles_current_relationship_same_root_fk|FOREIGN KEY (tenant_id, worker_profile_id, current_reporting_relationship_id) REFERENCES hr_reporting_relationships(tenant_id, worker_profile_id, reporting_relationship_id) ON DELETE RESTRICT`,
    );
    const policy = await migrationPool.query<{ policy: string }>(
      `SELECT policyname || '|' || cmd || '|' || qual || '|' || with_check AS policy
       FROM pg_catalog.pg_policies
       WHERE schemaname = 'public' AND tablename = 'hr_reporting_relationships'`,
    );
    expect(policy.rows[0]?.policy).toBe(
      "hr_reporting_relationships_tenant_isolation|ALL|(tenant_id = esbla_current_tenant_id())|(tenant_id = esbla_current_tenant_id())",
    );
    const privileges = await migrationPool.query<{ actual: boolean[] }>(
      `SELECT ARRAY[
         has_table_privilege($1, 'hr_reporting_relationships', 'SELECT'),
         has_table_privilege($1, 'hr_reporting_relationships', 'INSERT'),
         has_table_privilege($1, 'hr_reporting_relationships', 'UPDATE'),
         has_table_privilege($1, 'hr_reporting_relationships', 'DELETE'),
         has_table_privilege($1, 'hr_reporting_relationships', 'TRUNCATE'),
         has_table_privilege($1, 'hr_reporting_relationships', 'REFERENCES'),
         has_table_privilege($1, 'hr_reporting_relationships', 'TRIGGER'),
         has_table_privilege($1, 'service_activations', 'SELECT'),
         has_table_privilege($1, 'memberships', 'SELECT'),
         has_table_privilege($1, 'hr_worker_profiles', 'SELECT'),
         has_table_privilege($1, 'hr_worker_profiles', 'UPDATE')
       ] AS actual`,
      [applicationRole],
    );
    expect(privileges.rows[0]?.actual.join()).toBe(
      "true,true,false,false,false,false,false,true,true,true,true",
    );
  });

  it("appends only eligible immediate heads and keeps prior facts immutable", async () => {
    const result = await tenantTransaction(pool, ids.tenant, async (client) => {
      const assigned = await client.query<{
        created_at: Date;
        effective_at: Date;
        relationship_version: number;
        reporting_relationship_id: string;
        row_version: number;
      }>(
        `INSERT INTO hr_reporting_relationships
           (reporting_relationship_id, tenant_id, worker_profile_id,
            manager_worker_profile_id, relationship_status, effective_at,
            supersedes_reporting_relationship_id, relationship_version, created_at, row_version)
         VALUES ($4, $1, $2, $3, 'assigned', '2000-01-01Z', NULL, 1, '2000-01-01Z', 7)
         RETURNING reporting_relationship_id, relationship_version,
                   effective_at, created_at, row_version`,
        [ids.tenant, workerProfileId, managerProfileId, ids.spoofedRelationship],
      );
      const first = assigned.rows[0];
      if (!first) throw new Error("Assigned relationship was unavailable");
      const firstHead = await client.query(
        `UPDATE hr_worker_profiles
         SET current_reporting_relationship_id = $3, row_version = 4
         WHERE tenant_id = $1 AND worker_profile_id = $2 AND row_version = 3`,
        [ids.tenant, workerProfileId, first.reporting_relationship_id],
      );
      expect(firstHead.rowCount).toBe(1);
      const unassigned = await client.query<{
        relationship_version: number;
        reporting_relationship_id: string;
      }>(
        `INSERT INTO hr_reporting_relationships
           (tenant_id, worker_profile_id, manager_worker_profile_id,
            relationship_status, supersedes_reporting_relationship_id, relationship_version)
         VALUES ($1, $2, NULL, 'unassigned', $3, 2)
         RETURNING reporting_relationship_id, relationship_version`,
        [ids.tenant, workerProfileId, first.reporting_relationship_id],
      );
      const second = unassigned.rows[0];
      if (!second) throw new Error("Unassigned relationship was unavailable");
      const secondHead = await client.query(
        `UPDATE hr_worker_profiles
         SET current_reporting_relationship_id = $3, row_version = 5
         WHERE tenant_id = $1 AND worker_profile_id = $2
           AND current_reporting_relationship_id = $4 AND row_version = 4`,
        [
          ids.tenant,
          workerProfileId,
          second.reporting_relationship_id,
          first.reporting_relationship_id,
        ],
      );
      expect(secondHead.rowCount).toBe(1);
      return { first, second };
    });

    expect(result.first).toMatchObject({ relationship_version: 1, row_version: 1 });
    expect(result.first.reporting_relationship_id).not.toBe(ids.spoofedRelationship);
    expect(result.first.effective_at).toEqual(result.first.created_at);
    expect(result.first.created_at).not.toEqual(new Date("2000-01-01Z"));
    expect(result.second.relationship_version).toBe(2);
    const firstId = result.first.reporting_relationship_id;
    const secondId = result.second.reporting_relationship_id;
    const persisted = await tenantTransaction(pool, ids.tenant, (client) =>
      client.query<{ state: string }>(
        `SELECT profile.current_reporting_relationship_id || '|' || profile.row_version ||
                '|' || string_agg(relationship.relationship_status || ':' ||
                  relationship.relationship_version, ',' ORDER BY relationship.relationship_version)
                AS state
         FROM hr_worker_profiles profile
         JOIN hr_reporting_relationships relationship
           ON relationship.tenant_id = profile.tenant_id
          AND relationship.worker_profile_id = profile.worker_profile_id
         WHERE profile.worker_profile_id = $1
         GROUP BY profile.current_reporting_relationship_id, profile.row_version`,
        [workerProfileId],
      ),
    );
    expect(persisted.rows).toEqual([{ state: `${secondId}|5|assigned:1,unassigned:2` }]);
    expect(
      (
        await tenantTransaction(pool, ids.tenantOther, (client) =>
          client.query("SELECT * FROM hr_reporting_relationships"),
        )
      ).rows,
    ).toEqual([]);

    await expectReportingInsertError([ids.tenant, workerProfileId, null, "assigned", secondId, 3], {
      code: "23514",
      constraint: "hr_reporting_relationships_status_manager_consistent",
    });
    await expectReportingInsertError(
      [ids.tenant, workerProfileId, managerProfileId, "unassigned", secondId, 3],
      { code: "23514", constraint: "hr_reporting_relationships_status_manager_consistent" },
    );
    await expectReportingInsertError(
      [ids.tenant, workerProfileId, null, "unassigned", secondId, 4],
      { code: "55000", message: "reporting relationship version must advance exactly" },
    );
    await expectReportingInsertError(
      [ids.tenant, workerProfileId, null, "unassigned", firstId, 3],
      { code: "55000", message: "reporting relationship predecessor is not current" },
    );
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, null, "unassigned", firstId, 1],
      { code: "55000", message: "reporting relationship predecessor is not current" },
    );
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, otherManagerProfileId, "assigned", null, 1],
      { code: "55000", message: "reporting relationship manager must be active" },
    );
    await expectReportingInsertError(
      [ids.tenant, otherManagerProfileId, null, "unassigned", null, 1],
      { code: "55000", message: "reporting relationship report must be active" },
    );
    await expectReportingInsertError(
      [ids.tenantOther, otherManagerProfileId, null, "unassigned", null, 1],
      { code: "55000", message: "workforce profile service is inactive" },
    );
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, unlinkedProfileId, "assigned", null, 1],
      { code: "55000", message: "reporting relationship manager must be active" },
    );
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, null, "unassigned", null, 0],
      { code: "55000", message: "reporting relationship version must advance exactly" },
    );

    await migrationQuery(serviceStateUpdate, [ids.tenant, "inactive", 2]);
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, null, "unassigned", null, 1],
      { code: "55000", message: "workforce profile service is inactive" },
    );
    await migrationQuery(serviceStateUpdate, [ids.tenant, "active", 3]);
    await migrationQuery(profileStatusUpdate, [ids.tenant, alternateProfileId, "suspended", 4]);
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, managerProfileId, "assigned", null, 1],
      { code: "55000", message: "reporting relationship report must be active" },
    );
    await migrationQuery(profileStatusUpdate, [ids.tenant, alternateProfileId, "active", 5]);
    await migrationQuery(profileStatusUpdate, [ids.tenant, managerProfileId, "suspended", 4]);
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, managerProfileId, "assigned", null, 1],
      { code: "55000", message: "reporting relationship manager must be active" },
    );
    await migrationQuery(profileStatusUpdate, [ids.tenant, managerProfileId, "active", 5]);
    await migrationQuery(
      "UPDATE memberships SET role_key = $3 WHERE tenant_id = $1 AND principal_id = $2",
      [ids.tenant, ids.manager, "employee"],
    );
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, managerProfileId, "assigned", null, 1],
      { code: "55000", message: "reporting relationship manager membership is not current" },
    );
    await migrationQuery(
      "UPDATE memberships SET role_key = $3 WHERE tenant_id = $1 AND principal_id = $2",
      [ids.tenant, ids.manager, "manager"],
    );
    await migrationQuery(
      "UPDATE memberships SET status = $3 WHERE tenant_id = $1 AND principal_id = $2",
      [ids.tenant, ids.manager, "suspended"],
    );
    await expectReportingInsertError(
      [ids.tenant, alternateProfileId, managerProfileId, "assigned", null, 1],
      { code: "55000", message: "reporting relationship manager membership is not current" },
    );
    await migrationQuery(
      "UPDATE memberships SET status = $3 WHERE tenant_id = $1 AND principal_id = $2",
      [ids.tenant, ids.manager, "active"],
    );
    expect(
      (
        await tenantTransaction(pool, ids.tenant, (client) =>
          client.query("SELECT 1 FROM hr_reporting_relationships WHERE worker_profile_id = $1", [
            alternateProfileId,
          ]),
        )
      ).rowCount,
    ).toBe(0);

    await expectTenantDatabaseError(
      migrationPool,
      ids.tenant,
      `UPDATE hr_worker_profiles
       SET current_reporting_relationship_id = $3, row_version = 6
       WHERE tenant_id = $1 AND worker_profile_id = $2`,
      [ids.tenant, workerProfileId, firstId],
      { code: "55000", message: "workforce profile reporting head transition is invalid" },
    );
    for (const statement of [
      "UPDATE hr_reporting_relationships SET row_version = 2 WHERE tenant_id = $1",
      "DELETE FROM hr_reporting_relationships WHERE tenant_id = $1",
    ]) {
      await expectTenantDatabaseError(migrationPool, ids.tenant, statement, [ids.tenant], {
        code: "55000",
        message: "reporting relationships are append-only",
      });
    }
    await expect(
      migrationPool.query("TRUNCATE hr_reporting_relationships CASCADE"),
    ).rejects.toMatchObject({
      code: "55000",
      message: "reporting relationships are append-only",
    });
  });
});
