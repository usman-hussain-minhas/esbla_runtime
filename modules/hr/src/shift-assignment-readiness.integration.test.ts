import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { type OperationContext, withTenantTransaction } from "@esbla/platform-core";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectActivationReadiness } from "./activation.js";
import { restoreShiftRuntimeTableAuthority } from "./shift-assignment.integration-fixture.js";
import {
  HR_SHIFT_ASSIGNMENT_CATALOG_REQUIREMENTS,
  HR_SHIFT_ASSIGNMENT_REQUIRED_MIGRATIONS,
  HR_SHIFT_ASSIGNMENT_RUNTIME_TABLE_PRIVILEGES,
  inspectShiftAssignmentEnvironment,
  inspectShiftAssignmentSemanticReadiness,
} from "./shift-assignment-readiness.js";

const tenantId = "04000000-0000-4000-8000-000000000001";
const actorPrincipalId = "14000000-0000-4000-8000-000000000001";
const context: OperationContext = {
  actorPrincipalId,
  correlationId: "24000000-0000-4000-8000-000000000001",
  tenantId,
};
let applicationRole = "";
let migrationPool: Pool;
let runtimePool: Pool;

async function inspectShiftStructuralReadiness() {
  return await withTenantTransaction(runtimePool, context, async (transaction) => {
    return await inspectActivationReadiness(transaction, await migrationPool.connect(), {
      catalog: HR_SHIFT_ASSIGNMENT_CATALOG_REQUIREMENTS,
      migrations: HR_SHIFT_ASSIGNMENT_REQUIRED_MIGRATIONS,
      runtimeTablePrivileges: HR_SHIFT_ASSIGNMENT_RUNTIME_TABLE_PRIVILEGES,
      semantic: { current: true, reasons: [] },
    });
  });
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
  await restoreShiftRuntimeTableAuthority(migrationPool, applicationRole);
  await migrationPool.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Shift Ready')", [
    tenantId,
  ]);
  await migrationPool.query(
    "INSERT INTO principals (principal_id,display_name) VALUES ($1,'Shift Inspector')",
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

beforeEach(async () => await restoreShiftRuntimeTableAuthority(migrationPool, applicationRole));

afterAll(async () => {
  await runtimePool?.end();
  await migrationPool?.end();
});

describe("Shift Assignment structural readiness", () => {
  it("proves exact structure and non-production semantic eligibility", async () => {
    await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
      current: true,
      reasons: [],
    });
    await expect(
      inspectShiftAssignmentEnvironment(migrationPool, "non_production"),
    ).resolves.toEqual({ current: true, reasons: [] });
    const query = vi.fn().mockResolvedValue({ rows: [{ current: true }] });
    await expect(
      inspectShiftAssignmentSemanticReadiness({ query } as never, "non_production"),
    ).resolves.toEqual({ current: true, reasons: [] });
    expect(query).toHaveBeenCalledOnce();
  }, 15_000);

  it("fails closed on production retention or unavailable timezone evidence", async () => {
    const query = vi.fn();
    await expect(
      inspectShiftAssignmentEnvironment({ query } as never, "production"),
    ).resolves.toEqual({
      current: false,
      reasons: ["qualified_retention_evidence_unavailable"],
    });
    expect(query).not.toHaveBeenCalled();

    const unavailable = vi.fn().mockRejectedValue(new Error("private catalog detail"));
    await expect(
      inspectShiftAssignmentEnvironment({ query: unavailable } as never, "non_production"),
    ).resolves.toEqual({
      current: false,
      reasons: ["time_zone_policy_unavailable"],
    });
  });

  it("fails closed if Runtime receives excess Shift-table authority", async () => {
    await migrationPool.query(`GRANT DELETE ON public.hr_shift_assignments TO ${applicationRole}`);
    try {
      await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
        current: false,
        reasons: ["runtime_projection_privileges_not_current"],
      });
    } finally {
      await restoreShiftRuntimeTableAuthority(migrationPool, applicationRole);
    }
    await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
      current: true,
      reasons: [],
    });
  });

  it("fails closed if guarded settings execution or a state trigger drifts", async () => {
    await migrationPool.query(
      `REVOKE EXECUTE ON FUNCTION public.esbla_configure_hr_shift_assignment_settings(
         integer, integer, boolean
       ) FROM ${applicationRole}`,
    );
    try {
      await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
        current: false,
        reasons: ["schema_dependencies_not_current"],
      });
    } finally {
      await migrationPool.query(
        `GRANT EXECUTE ON FUNCTION public.esbla_configure_hr_shift_assignment_settings(
           integer, integer, boolean
         ) TO ${applicationRole}`,
      );
    }

    await migrationPool.query(
      `ALTER TABLE public.hr_shift_assignments
       DISABLE TRIGGER hr_shift_assignments_enforce_state`,
    );
    try {
      await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
        current: false,
        reasons: ["schema_dependencies_not_current"],
      });
    } finally {
      await migrationPool.query(
        `ALTER TABLE public.hr_shift_assignments
         ENABLE TRIGGER hr_shift_assignments_enforce_state`,
      );
    }
    await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
      current: true,
      reasons: [],
    });
  });

  it("fails closed on undeclared Shift-owned catalog objects", async () => {
    await migrationPool.query(
      "ALTER TABLE public.hr_shift_roster_versions ADD COLUMN audit_extra_column text",
    );
    try {
      await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
        current: false,
        reasons: ["schema_dependencies_not_current"],
      });
    } finally {
      await migrationPool.query(
        "ALTER TABLE public.hr_shift_roster_versions DROP COLUMN audit_extra_column",
      );
    }
    await expect(inspectShiftStructuralReadiness()).resolves.toEqual({
      current: true,
      reasons: [],
    });
  });
});
