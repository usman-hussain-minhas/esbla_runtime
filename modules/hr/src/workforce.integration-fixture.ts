import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { OperationContext } from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";

export const workforceIds = {
  correlationCreate: "51000000-0000-4000-8000-000000000001",
  correlationTenantAdmin: "51000000-0000-4000-8000-000000000002",
  idempotencyTenantAdmin: "61000000-0000-4000-8000-000000000001",
  employeeA: "11000000-0000-4000-8000-000000000002",
  employeeB: "11000000-0000-4000-8000-000000000004",
  hrOperatorA: "11000000-0000-4000-8000-000000000001",
  hrOperatorB: "11000000-0000-4000-8000-000000000003",
  membershipEmployeeA: "21000000-0000-4000-8000-000000000002",
  membershipEmployeeB: "21000000-0000-4000-8000-000000000004",
  membershipHrOperatorA: "21000000-0000-4000-8000-000000000001",
  membershipHrOperatorB: "21000000-0000-4000-8000-000000000003",
  membershipTenantAdminA: "21000000-0000-4000-8000-000000000005",
  tenantA: "01000000-0000-4000-8000-000000000001",
  tenantAdminA: "11000000-0000-4000-8000-000000000005",
  tenantB: "01000000-0000-4000-8000-000000000002",
} as const;

export let workforceMigrationPool: Pool;
export let workforcePool: Pool;
export let workforceApplicationRole: string;

export interface WorkforceTenantSnapshot {
  readonly evidence: number;
  readonly history: number;
  readonly outbox: number;
  readonly profiles: number;
  readonly work: number;
}

export async function withWorkforceTenant(
  tenantId: string,
  operation: (client: PoolClient) => Promise<void>,
) {
  const client = await workforceMigrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readWorkforceTenantSnapshot(
  tenantId: string,
): Promise<WorkforceTenantSnapshot> {
  let snapshot: WorkforceTenantSnapshot | undefined;
  await withWorkforceTenant(tenantId, async (client) => {
    const result = await client.query<WorkforceTenantSnapshot>(
      `SELECT
         (SELECT count(*)::integer FROM hr_worker_profiles WHERE tenant_id = $1) AS profiles,
         (SELECT count(*)::integer FROM hr_workforce_status_history WHERE tenant_id = $1) AS history,
         (SELECT count(*)::integer FROM evidence_events WHERE tenant_id = $1) AS evidence,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id = $1) AS outbox,
         (SELECT count(*)::integer FROM work_items WHERE tenant_id = $1) AS work`,
      [tenantId],
    );
    snapshot = result.rows[0];
  });
  if (!snapshot) throw new Error("Workforce tenant snapshot was unavailable");
  return snapshot;
}

export function workforceContext(
  tenantId: string,
  actorPrincipalId: string,
  correlationId: string,
): OperationContext {
  return { actorPrincipalId, correlationId, tenantId };
}

export async function setupWorkforceIntegration(): Promise<void> {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!runtimeUrl || !migrationUrl || !applicationRole) {
    throw new Error("PostgreSQL harness environment is required");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("Application role is not a safe PostgreSQL identifier");
  }
  workforceApplicationRole = applicationRole;

  workforceMigrationPool = createDatabasePool(migrationUrl, { max: 2 });
  await migrateDatabase(createDatabase(workforceMigrationPool));
  await workforceMigrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await workforceMigrationPool.query(
    `GRANT SELECT ON principals, tenant_settings, membership_capabilities,
       hr_workforce_profile_service_control, hr_workforce_status_history
     TO ${applicationRole}`,
  );
  await workforceMigrationPool.query(
    `GRANT SELECT, UPDATE ON memberships, service_activations TO ${applicationRole}`,
  );
  await workforceMigrationPool.query(
    `GRANT SELECT, INSERT, UPDATE ON hr_worker_profiles TO ${applicationRole}`,
  );
  await workforceMigrationPool.query(
    `GRANT SELECT, INSERT ON evidence_events, outbox_events, hr_reporting_relationships
     TO ${applicationRole}`,
  );

  await workforceMigrationPool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Workforce Tenant A'), ($2, 'Workforce Tenant B')`,
    [workforceIds.tenantA, workforceIds.tenantB],
  );
  await workforceMigrationPool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'HR Operator A'), ($2, 'Employee A'),
            ($3, 'HR Operator B'), ($4, 'Employee B'), ($5, 'Tenant Admin A')`,
    [
      workforceIds.hrOperatorA,
      workforceIds.employeeA,
      workforceIds.hrOperatorB,
      workforceIds.employeeB,
      workforceIds.tenantAdminA,
    ],
  );
  await withWorkforceTenant(workforceIds.tenantA, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'hr_operator'), ($4, $2, $5, 'employee'),
              ($6, $2, $7, 'tenant_admin')`,
      [
        workforceIds.membershipHrOperatorA,
        workforceIds.tenantA,
        workforceIds.hrOperatorA,
        workforceIds.membershipEmployeeA,
        workforceIds.employeeA,
        workforceIds.membershipTenantAdminA,
        workforceIds.tenantAdminA,
      ],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       VALUES ($1, $2, 'hr.workforce.create_profile'),
              ($1, $2, 'hr.workforce.link_principal'),
              ($1, $2, 'hr.workforce.change_status'),
              ($1, $2, 'hr.workforce.change_reporting_relationship'),
              ($1, $3, 'hr.workforce.view_own'),
              ($1, $4, 'hr.workforce.create_profile')`,
      [
        workforceIds.tenantA,
        workforceIds.hrOperatorA,
        workforceIds.employeeA,
        workforceIds.tenantAdminA,
      ],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)`,
      [workforceIds.tenantA],
    );
  });
  await withWorkforceTenant(workforceIds.tenantB, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'hr_operator'), ($4, $2, $5, 'employee')`,
      [
        workforceIds.membershipHrOperatorB,
        workforceIds.tenantB,
        workforceIds.hrOperatorB,
        workforceIds.membershipEmployeeB,
        workforceIds.employeeB,
      ],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       VALUES ($1, $2, 'hr.workforce.create_profile'),
              ($1, $2, 'hr.workforce.link_principal'),
              ($1, $2, 'hr.workforce.change_status'),
              ($1, $3, 'hr.workforce.view_own')`,
      [workforceIds.tenantB, workforceIds.hrOperatorB, workforceIds.employeeB],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)`,
      [workforceIds.tenantB],
    );
  });
  workforcePool = createDatabasePool(runtimeUrl, { max: 8 });
}

export async function teardownWorkforceIntegration(): Promise<void> {
  if (workforcePool) await workforcePool.end();
  if (workforceMigrationPool) await workforceMigrationPool.end();
}
