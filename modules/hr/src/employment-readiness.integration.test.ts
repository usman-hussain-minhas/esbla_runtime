import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { type OperationContext, withTenantTransaction } from "@esbla/platform-core";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inspectActivationReadiness } from "./activation.js";
import {
  HR_EMPLOYMENT_RECORD_CATALOG_REQUIREMENTS,
  HR_EMPLOYMENT_RECORD_REQUIRED_MIGRATIONS,
  HR_EMPLOYMENT_RECORD_RUNTIME_TABLE_PRIVILEGES,
} from "./activation-readiness.js";

const tenantId = "03000000-0000-4000-8000-000000000001";
const actorPrincipalId = "13000000-0000-4000-8000-000000000001";
const context: OperationContext = {
  actorPrincipalId,
  correlationId: "23000000-0000-4000-8000-000000000001",
  tenantId,
};
let applicationRole = "";
let migrationPool: Pool;
let runtimePool: Pool;

async function restoreEmploymentRuntimeAuthority() {
  for (const required of HR_EMPLOYMENT_RECORD_RUNTIME_TABLE_PRIVILEGES) {
    if (!/^public\.[a-z_][a-z0-9_]*$/.test(required.name)) {
      throw new Error("Employment readiness contains an unsafe table identity");
    }
    const columns = await migrationPool.query<{ value: string | null }>(
      `SELECT string_agg(quote_ident(attribute.attname), ', ' ORDER BY attribute.attnum) AS value
       FROM pg_attribute attribute
       WHERE attribute.attrelid = $1::regclass
         AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
      [required.name],
    );
    const columnList = columns.rows[0]?.value;
    if (!columnList) throw new Error("Employment readiness table columns are unavailable");

    await migrationPool.query(
      `REVOKE ALL PRIVILEGES ON TABLE ${required.name} FROM ${applicationRole}`,
    );
    await migrationPool.query(
      `REVOKE SELECT (${columnList}), INSERT (${columnList}), UPDATE (${columnList}),
              REFERENCES (${columnList}) ON ${required.name} FROM ${applicationRole}`,
    );
    const grants: string[] = [];
    if (required.select) grants.push("SELECT");
    if (required.insert) grants.push("INSERT");
    if (required.update) grants.push("UPDATE");
    if (required.delete) grants.push("DELETE");
    if (required.truncate) grants.push("TRUNCATE");
    if (required.references) grants.push("REFERENCES");
    if (required.trigger) grants.push("TRIGGER");
    if (grants.length > 0) {
      await migrationPool.query(
        `GRANT ${grants.join(", ")} ON TABLE ${required.name} TO ${applicationRole}`,
      );
    }
  }
}

async function inspectEmploymentReadiness() {
  return await withTenantTransaction(runtimePool, context, async (transaction) =>
    inspectActivationReadiness(transaction, await migrationPool.connect(), {
      catalog: HR_EMPLOYMENT_RECORD_CATALOG_REQUIREMENTS,
      migrations: HR_EMPLOYMENT_RECORD_REQUIRED_MIGRATIONS,
      runtimeTablePrivileges: HR_EMPLOYMENT_RECORD_RUNTIME_TABLE_PRIVILEGES,
      semantic: { current: true, reasons: [] },
    }),
  );
}

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL test authority is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT ON principals, tenant_settings, membership_capabilities,
       hr_workforce_profile_service_control, hr_workforce_status_history TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE ON service_activations, hr_worker_profiles,
       hr_employment_record_service_control TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT ON evidence_events, outbox_events,
       hr_reporting_relationships TO ${applicationRole}`,
  );
  await migrationPool.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Employment Ready')", [
    tenantId,
  ]);
  await migrationPool.query(
    "INSERT INTO principals (principal_id,display_name) VALUES ($1,'Employment Inspector')",
    [actorPrincipalId],
  );
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'tenant_admin')`,
      [randomUUID(), tenantId, actorPrincipalId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  runtimePool = createDatabasePool(runtimeUrl, { max: 2 });
});

beforeEach(restoreEmploymentRuntimeAuthority);

afterAll(async () => {
  await runtimePool?.end();
  await migrationPool?.end();
});

describe("dormant Employment Record readiness foundation", () => {
  it("proves exact migration, catalog, and select-only membership authority", async () => {
    await expect(inspectEmploymentReadiness()).resolves.toEqual({ current: true, reasons: [] });
    const privilege = await withTenantTransaction(runtimePool, context, async ({ client }) =>
      client.query<{ insert: boolean; select: boolean; update: boolean }>(
        `SELECT has_table_privilege(current_user,'public.memberships','SELECT') "select",
                has_table_privilege(current_user,'public.memberships','INSERT') "insert",
                has_table_privilege(current_user,'public.memberships','UPDATE') "update"`,
      ),
    );
    expect(privilege.rows[0]).toEqual({ insert: false, select: true, update: false });
  });

  it("fails closed if Runtime membership mutation authority reappears", async () => {
    await migrationPool.query(`GRANT UPDATE ON public.memberships TO ${applicationRole}`);
    try {
      await expect(inspectEmploymentReadiness()).resolves.toEqual({
        current: false,
        reasons: ["runtime_projection_privileges_not_current"],
      });
    } finally {
      await restoreEmploymentRuntimeAuthority();
    }
    await expect(inspectEmploymentReadiness()).resolves.toEqual({ current: true, reasons: [] });
  });

  it("fails closed on undeclared Employment-owned catalog objects", async () => {
    await expect(inspectEmploymentReadiness()).resolves.toEqual({ current: true, reasons: [] });
    for (const { apply, restore } of [
      {
        apply: "ALTER TABLE public.hr_employment_records ADD COLUMN audit_extra_column text",
        restore: "ALTER TABLE public.hr_employment_records DROP COLUMN audit_extra_column",
      },
      {
        apply:
          "CREATE UNIQUE INDEX audit_extra_index ON public.hr_employment_records (tenant_id, created_at)",
        restore: "DROP INDEX public.audit_extra_index",
      },
      {
        apply:
          "ALTER TABLE public.hr_employment_records ADD CONSTRAINT audit_extra_constraint CHECK (false) NOT VALID",
        restore: "ALTER TABLE public.hr_employment_records DROP CONSTRAINT audit_extra_constraint",
      },
    ]) {
      await migrationPool.query(apply);
      try {
        await expect(inspectEmploymentReadiness()).resolves.toEqual({
          current: false,
          reasons: ["schema_dependencies_not_current"],
        });
      } finally {
        await migrationPool.query(restore);
      }
      await expect(inspectEmploymentReadiness()).resolves.toEqual({ current: true, reasons: [] });
    }
  });
});
