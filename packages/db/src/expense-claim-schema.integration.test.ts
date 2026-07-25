import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  actor: "1a000000-0000-4000-8000-000000000001",
  correlation: "5a000000-0000-4000-8000-000000000001",
  manager: "1a000000-0000-4000-8000-000000000002",
  managerMembership: "2a000000-0000-4000-8000-000000000002",
  membership: "2a000000-0000-4000-8000-000000000001",
  otherActor: "1a000000-0000-4000-8000-000000000003",
  otherMembership: "2a000000-0000-4000-8000-000000000003",
  otherTenant: "0a000000-0000-4000-8000-000000000002",
  tenant: "0a000000-0000-4000-8000-000000000001",
} as const;

let applicationRole = "";
let managerProfileId = "";
let migrationPool: Pool;
let otherWorkerProfileId = "";
let pool: Pool;
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
  const profileId = created.rows[0]?.worker_profile_id ?? "";
  await client.query(
    `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, profileId, principalId],
  );
  await client.query(
    `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, profileId],
  );
  return profileId;
}

beforeAll(async () => {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL harness environment is required");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  pool = createDatabasePool(runtimeUrl, { max: 4 });

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Expense Tenant'),($2,'Other Expense Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Expense Worker'),($2,'Expense Manager'),($3,'Other Worker')`,
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
       VALUES ($1,'workforce_profile','active',1),($1,'expense_claim_boundary','active',1)`,
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
       VALUES ($1,'workforce_profile','active',1),($1,'expense_claim_boundary','active',1)`,
      [ids.otherTenant],
    );
    otherWorkerProfileId = await createActiveProfile(client, ids.otherTenant, ids.otherActor);
  });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("Expense Claim Boundary persistence kernel", () => {
  it("installs exact tenant-owned schema, indexes, RLS, head link, and least privilege", async () => {
    const tables = await migrationPool.query<{ force_rls: boolean; name: string; rls: boolean }>(
      `SELECT relname name,relrowsecurity rls,relforcerowsecurity force_rls
       FROM pg_catalog.pg_class
       WHERE oid=ANY(ARRAY[
         'public.hr_expense_claim_approvals'::regclass,
         'public.hr_expense_claim_lines'::regclass,
         'public.hr_expense_claim_service_control'::regclass,
         'public.hr_expense_claim_versions'::regclass,
         'public.hr_expense_claims'::regclass
       ]) ORDER BY relname`,
    );
    expect(tables.rows).toEqual([
      { force_rls: true, name: "hr_expense_claim_approvals", rls: true },
      { force_rls: true, name: "hr_expense_claim_lines", rls: true },
      { force_rls: true, name: "hr_expense_claim_service_control", rls: true },
      { force_rls: true, name: "hr_expense_claim_versions", rls: true },
      { force_rls: true, name: "hr_expense_claims", rls: true },
    ]);

    const enums = await migrationPool.query<{ definition: string }>(
      `SELECT typname || ':' || string_agg(enumlabel,',' ORDER BY enumsortorder) definition
       FROM pg_catalog.pg_type JOIN pg_catalog.pg_enum ON enumtypid=pg_type.oid
       WHERE typname=ANY($1::text[]) GROUP BY typname ORDER BY typname`,
      [["hr_expense_claim_decision", "hr_expense_claim_status"]],
    );
    expect(enums.rows.map(({ definition }) => definition)).toEqual([
      "hr_expense_claim_decision:approved,rejected",
      "hr_expense_claim_status:draft,submitted,approved,rejected",
    ]);

    const indexes = await migrationPool.query<{ name: string }>(
      `SELECT indexname name FROM pg_catalog.pg_indexes
       WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
      [
        [
          "idx_hr_expense_claims_tenant_worker_created",
          "idx_hr_expense_lines_tenant_version_date",
          "idx_hr_expense_versions_tenant_approver_submitted",
          "idx_hr_expense_versions_tenant_claim_cursor",
          "uq_hr_expense_approvals_tenant_version",
          "uq_hr_expense_claim_boundary_service_control_tenant_key",
          "uq_hr_expense_versions_composite_identity",
          "uq_hr_expense_versions_tenant_claim_number",
          "uq_hr_expense_versions_tenant_successor",
        ],
      ],
    );
    expect(indexes.rows.map(({ name }) => name)).toHaveLength(9);

    const currentHead = await migrationPool.query<{
      deferrable: boolean;
      initially_deferred: boolean;
    }>(
      `SELECT condeferrable deferrable,condeferred initially_deferred
       FROM pg_catalog.pg_constraint
       WHERE conname='hr_expense_claims_current_version_same_root_fk'`,
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
          "hr_expense_claim_approvals",
          "hr_expense_claim_lines",
          "hr_expense_claim_service_control",
          "hr_expense_claim_versions",
          "hr_expense_claims",
        ],
      ],
    );
    expect(
      privileges.rows.map(({ name, select, insert, update, delete: remove, truncate }) =>
        [name, select, insert, update, remove, truncate].join(":"),
      ),
    ).toEqual([
      "hr_expense_claim_approvals:true:true:false:false:false",
      "hr_expense_claim_lines:true:true:true:true:false",
      "hr_expense_claim_service_control:true:false:false:false:false",
      "hr_expense_claim_versions:true:true:true:false:false",
      "hr_expense_claims:true:true:true:false:false",
    ]);
  });

  it("creates one stable root and exact first head atomically", async () => {
    const claimId = "3a000000-0000-4000-8000-000000000001";
    const versionId = "4a000000-0000-4000-8000-000000000001";
    await transaction(pool, ids.tenant, ids.actor, async (client) => {
      await client.query(
        `INSERT INTO hr_expense_claims
           (expense_claim_id,tenant_id,worker_profile_id,current_version_id)
         VALUES ($1,$2,$3,$4)`,
        [claimId, ids.tenant, workerProfileId, versionId],
      );
      await client.query(
        `INSERT INTO hr_expense_claim_versions
           (expense_claim_version_id,tenant_id,expense_claim_id,version,currency_code)
         VALUES ($1,$2,$3,1,'PKR')`,
        [versionId, ids.tenant, claimId],
      );
    });
    const stored = await transaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT root.current_version_id::text,version.status,version.version
         FROM hr_expense_claims root JOIN hr_expense_claim_versions version
           ON version.tenant_id=root.tenant_id
          AND version.expense_claim_id=root.expense_claim_id
          AND version.expense_claim_version_id=root.current_version_id
         WHERE root.tenant_id=$1 AND root.expense_claim_id=$2`,
        [ids.tenant, claimId],
      ),
    );
    expect(stored.rows).toEqual([{ current_version_id: versionId, status: "draft", version: 1 }]);

    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_expense_claims
               (tenant_id,worker_profile_id,current_version_id)
             VALUES ($1,$2,$3)`,
            [ids.tenant, workerProfileId, "4a000000-0000-4000-8000-000000000099"],
          ),
        ),
      { code: "23503", constraint: "hr_expense_claims_current_version_same_root_fk" },
    );
  });

  it("enforces tenant identity, value bounds, and RLS", async () => {
    const claimId = "3a000000-0000-4000-8000-000000000002";
    const versionId = "4a000000-0000-4000-8000-000000000002";
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_expense_claims
               (expense_claim_id,tenant_id,worker_profile_id,current_version_id)
             VALUES ($1,$2,$3,$4)`,
            [claimId, ids.tenant, otherWorkerProfileId, versionId],
          ),
        ),
      { code: "23503", constraint: "hr_expense_claims_worker_same_tenant_fk" },
    );
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, async (client) => {
          await client.query(
            `INSERT INTO hr_expense_claims
               (expense_claim_id,tenant_id,worker_profile_id,current_version_id)
             VALUES ($1,$2,$3,$4)`,
            [claimId, ids.tenant, workerProfileId, versionId],
          );
          await client.query(
            `INSERT INTO hr_expense_claim_versions
               (expense_claim_version_id,tenant_id,expense_claim_id,version,currency_code)
             VALUES ($1,$2,$3,1,'pkr')`,
            [versionId, ids.tenant, claimId],
          );
        }),
      { code: "23514", constraint: "hr_expense_versions_currency_valid" },
    );
    const invisible = await transaction(pool, ids.otherTenant, ids.otherActor, (client) =>
      client.query(`SELECT count(*)::int count FROM hr_expense_claims WHERE tenant_id=$1`, [
        ids.tenant,
      ]),
    );
    expect(invisible.rows).toEqual([{ count: 0 }]);
  });

  it("preserves submitted and decided history and bounds draft-line work", async () => {
    const claimId = "3a000000-0000-4000-8000-000000000003";
    const lineId = "6a000000-0000-4000-8000-000000000001";
    const versionId = "4a000000-0000-4000-8000-000000000003";
    await transaction(pool, ids.tenant, ids.actor, async (client) => {
      await client.query(
        `INSERT INTO hr_expense_claims
           (expense_claim_id,tenant_id,worker_profile_id,current_version_id)
         VALUES ($1,$2,$3,$4)`,
        [claimId, ids.tenant, workerProfileId, versionId],
      );
      await client.query(
        `INSERT INTO hr_expense_claim_versions
           (expense_claim_version_id,tenant_id,expense_claim_id,version,currency_code)
         VALUES ($1,$2,$3,1,'PKR')`,
        [versionId, ids.tenant, claimId],
      );
      await client.query(
        `INSERT INTO hr_expense_claim_lines
           (expense_line_id,tenant_id,expense_claim_version_id,
            expense_date,category_code,amount_minor,description)
         VALUES ($1,$2,$3,'2027-03-01','other',12500,'Local travel')`,
        [lineId, ids.tenant, versionId],
      );
      await client.query(
        `UPDATE hr_expense_claim_versions
         SET status='submitted',assigned_approver_worker_profile_id=$4,
             submitted_at=statement_timestamp(),total_amount_minor=12500,
             updated_at=statement_timestamp(),row_version=2
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3`,
        [ids.tenant, claimId, versionId, managerProfileId],
      );
    });
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `UPDATE hr_expense_claim_lines SET amount_minor=500,row_version=2
             WHERE tenant_id=$1 AND expense_line_id=$2`,
            [ids.tenant, lineId],
          ),
        ),
      { code: "55000", message: "expense claim lines require a current draft version" },
    );
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.manager, (client) =>
          client.query(
            `INSERT INTO hr_expense_claim_approvals
               (tenant_id,expense_claim_version_id,approver_worker_profile_id,
                decision,decision_note,correlation_id)
             VALUES ($1,$2,$3,'approved',NULL,$4)`,
            [ids.tenant, versionId, managerProfileId, ids.correlation],
          ),
        ),
      { code: "55000", message: "expense claim approval and decision must commit atomically" },
    );
    await transaction(pool, ids.tenant, ids.manager, async (client) => {
      await client.query(
        `INSERT INTO hr_expense_claim_approvals
           (tenant_id,expense_claim_version_id,approver_worker_profile_id,
            decision,decision_note,correlation_id)
         VALUES ($1,$2,$3,'approved',NULL,$4)`,
        [ids.tenant, versionId, managerProfileId, ids.correlation],
      );
      await client.query(
        `UPDATE hr_expense_claim_versions
         SET status='approved',updated_at=statement_timestamp(),row_version=3
         WHERE tenant_id=$1 AND expense_claim_id=$2 AND expense_claim_version_id=$3`,
        [ids.tenant, claimId, versionId],
      );
    });
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.manager, (client) =>
          client.query(
            `UPDATE hr_expense_claim_approvals SET decision_note='changed'
             WHERE tenant_id=$1 AND expense_claim_version_id=$2`,
            [ids.tenant, versionId],
          ),
        ),
      { code: "42501" },
    );
    await expectDatabaseError(
      () =>
        transaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_expense_claim_versions
               (expense_claim_version_id,tenant_id,expense_claim_id,
                supersedes_version_id,version,currency_code)
             VALUES ('4a000000-0000-4000-8000-000000000004',$1,$2,$3,2,'PKR')`,
            [ids.tenant, claimId, versionId],
          ),
        ),
      { code: "55000", message: "new expense claim version must be the committed current head" },
    );
  });
});
