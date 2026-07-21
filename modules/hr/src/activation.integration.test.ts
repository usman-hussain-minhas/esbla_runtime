import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { type OperationContext, withTenantTransaction } from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activateHrLeaveService,
  activateWorkforceProfileService as activateWorkforceProfileServiceDomain,
  approveLeaveRequest,
  deactivateHrLeaveService,
  deactivateWorkforceProfileService,
  getLeaveRequest,
  getLeaveRequestDetail,
  getWorkforceProfileServiceControl,
  listAssignedLeaveRequests,
  listLeaveEvidence,
  listOwnLeaveRequests,
  rejectLeaveRequest,
  submitLeaveRequest,
} from "./index.js";

const tenantContextHash = "9e360ba35e62b22ddb9b993a9af007ecec92777c4623e805c439fceeee17197f";
const workforceProfileMigrationHash =
  "6e91e539b1ae824f386a468384904794bdb866630748bbd54e2ddc7dd85d9d6a";
const migrationBarrierKey = [1163084364, 1296648018] as const;
const initialActivationConflict = {
  code: "ACTIVATION_CONFLICT",
  details: {
    actualState: null,
    actualVersion: null,
    expectedVersion: 99,
    targetState: "active",
  },
  message: "Service activation currentness check failed",
} as const;
const ids = {
  adminA: "10000000-0000-4000-8000-000000002001",
  correlationActivate: "50000000-0000-4000-8000-000000002001",
  correlationAppPool: "50000000-0000-4000-8000-000000002002",
  correlationCatalog: "50000000-0000-4000-8000-000000002003",
  correlationCrossTenant: "50000000-0000-4000-8000-000000002004",
  correlationDeactivate: "50000000-0000-4000-8000-000000002005",
  correlationDenied: "50000000-0000-4000-8000-000000002006",
  correlationMigration: "50000000-0000-4000-8000-000000002007",
  correlationSubmit: "50000000-0000-4000-8000-000000002008",
  correlationSubmitBlocked: "50000000-0000-4000-8000-000000002009",
  correlationWorkforceActivate: "50000000-0000-4000-8000-000000002010",
  correlationWorkforceCatalog: "50000000-0000-4000-8000-000000002011",
  correlationWorkforceDeactivate: "50000000-0000-4000-8000-000000002012",
  correlationWorkforceDenied: "50000000-0000-4000-8000-000000002013",
  correlationWorkforceReactivate: "50000000-0000-4000-8000-000000002014",
  employeeA: "10000000-0000-4000-8000-000000002002",
  managerA: "10000000-0000-4000-8000-000000002003",
  membershipAdminA: "20000000-0000-4000-8000-000000002001",
  membershipAdminB: "20000000-0000-4000-8000-000000002005",
  membershipEmployeeA: "20000000-0000-4000-8000-000000002002",
  membershipManagerA: "20000000-0000-4000-8000-000000002003",
  membershipObserverA: "20000000-0000-4000-8000-000000002004",
  observerA: "10000000-0000-4000-8000-000000002004",
  request: "30000000-0000-4000-8000-000000002001",
  requestBlocked: "30000000-0000-4000-8000-000000002002",
  tenantA: "00000000-0000-4000-8000-000000002001",
  tenantB: "00000000-0000-4000-8000-000000002002",
} as const;
const catalogDriftCases = [
  {
    apply: [
      "ALTER TABLE public.principals RENAME TO principals_semantic_original",
      "CREATE VIEW public.principals AS SELECT * FROM public.principals_semantic_original",
    ],
    name: "same-name view",
    restore: [
      "DROP VIEW public.principals",
      "ALTER TABLE public.principals_semantic_original RENAME TO principals",
    ],
  },
  {
    apply: [
      "ALTER INDEX public.hr_leave_requests_employee_history_idx RENAME TO hr_leave_history_semantic_original",
      "CREATE INDEX hr_leave_requests_employee_history_idx ON public.hr_leave_requests (leave_request_id)",
    ],
    name: "wrong-shape index",
    restore: [
      "DROP INDEX public.hr_leave_requests_employee_history_idx",
      "ALTER INDEX public.hr_leave_history_semantic_original RENAME TO hr_leave_requests_employee_history_idx",
    ],
  },
  {
    apply: [
      "ALTER POLICY hr_leave_requests_tenant_isolation ON public.hr_leave_requests USING (tenant_id = public.esbla_current_tenant_id() AND tenant_id IS NOT NULL) WITH CHECK (tenant_id = public.esbla_current_tenant_id() AND tenant_id IS NOT NULL)",
    ],
    name: "behaviorally equivalent altered policy",
    restore: [
      "ALTER POLICY hr_leave_requests_tenant_isolation ON public.hr_leave_requests USING (tenant_id = public.esbla_current_tenant_id()) WITH CHECK (tenant_id = public.esbla_current_tenant_id())",
    ],
  },
  {
    apply: [
      "CREATE POLICY hr_leave_requests_semantic_duplicate ON public.hr_leave_requests AS PERMISSIVE FOR ALL TO public USING (tenant_id = public.esbla_current_tenant_id()) WITH CHECK (tenant_id = public.esbla_current_tenant_id())",
    ],
    name: "extra tenant-safe permissive policy",
    restore: ["DROP POLICY hr_leave_requests_semantic_duplicate ON public.hr_leave_requests"],
  },
  {
    apply: ["ALTER TABLE public.hr_leave_requests DISABLE TRIGGER hr_leave_requests_enforce_state"],
    name: "disabled state trigger",
    restore: [
      "ALTER TABLE public.hr_leave_requests ENABLE TRIGGER hr_leave_requests_enforce_state",
    ],
  },
  {
    apply: [
      "ALTER TABLE public.memberships RENAME CONSTRAINT memberships_status_valid TO memberships_status_valid_semantic_original",
      "ALTER TABLE public.memberships ADD CONSTRAINT memberships_status_valid CHECK (true) NOT VALID",
    ],
    name: "same-name non-enforcing constraint",
    restore: [
      "ALTER TABLE public.memberships DROP CONSTRAINT memberships_status_valid",
      "ALTER TABLE public.memberships RENAME CONSTRAINT memberships_status_valid_semantic_original TO memberships_status_valid",
    ],
  },
  {
    apply: ["ALTER FUNCTION public.esbla_current_tenant_id() VOLATILE"],
    name: "function volatility",
    restore: ["ALTER FUNCTION public.esbla_current_tenant_id() STABLE"],
  },
  {
    apply: [
      "CREATE OR REPLACE FUNCTION public.esbla_current_tenant_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT (NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::pg_catalog.uuid) $$",
    ],
    name: "behaviorally equivalent function body",
    restore: () => [originalTenantContextFunctionDefinition],
  },
  {
    apply: ["ALTER FUNCTION public.esbla_current_tenant_id() RESET ALL"],
    name: "function search path",
    restore: ["ALTER FUNCTION public.esbla_current_tenant_id() SET search_path = pg_catalog"],
  },
  {
    apply: ["ALTER TABLE public.hr_leave_requests ALTER COLUMN version SET DEFAULT 2"],
    name: "altered column default",
    restore: ["ALTER TABLE public.hr_leave_requests ALTER COLUMN version SET DEFAULT 1"],
  },
];
type CatalogDriftCase = (typeof catalogDriftCases)[number];
let applicationRole = "";
let migrationPool: Pool;
let migrationConnectionString = "";
let originalTenantContextFunctionDefinition = "";
let pool: Pool;
let untrustedMigrationReadPool: Pool;
const rejectingMigrationReadPool = {
  connect: () => Promise.reject(new Error("sensitive migration-reader diagnostic")),
} as unknown as Pool;
const context = (
  tenantId: string,
  actorPrincipalId: string,
  correlationId: string,
): OperationContext => ({ actorPrincipalId, correlationId, tenantId });
const activateWorkforceProfileService = (
  runtimePool: Pool,
  migrationReadPool: Pool,
  operationContext: OperationContext,
  input: { readonly expectedVersion: number | null },
) =>
  activateWorkforceProfileServiceDomain(
    runtimePool,
    migrationReadPool,
    operationContext,
    input,
    "non_production",
  );
async function seedTenantRow(
  client: PoolClient,
  tenantId: string,
  query: string,
  values: readonly unknown[],
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(query, [...values]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function activationSnapshot(
  tenantId: string = ids.tenantA,
  actorPrincipalId: string = ids.observerA,
) {
  return await withTenantTransaction(
    pool,
    context(tenantId, actorPrincipalId, ids.correlationDenied),
    async ({ client }) => {
      const activation = await client.query<{ state: string; version: number }>(
        `SELECT state, version FROM service_activations
         WHERE tenant_id = $1 AND service_key = 'hr.leave_request'`,
        [tenantId],
      );
      const activationEvidence = await client.query<{
        event_type: string;
        new_state: string;
        prior_state: string | null;
      }>(
        `SELECT event_type, prior_state, new_state FROM evidence_events
         WHERE tenant_id = $1 AND subject_type = 'platform.service_activation'
         ORDER BY occurred_at, evidence_event_id`,
        [tenantId],
      );
      const activationOutbox = await client.query<{
        aggregate_version: number;
        event_type: string;
        payload: unknown;
      }>(
        `SELECT event_type, aggregate_version, payload FROM outbox_events
         WHERE tenant_id = $1 AND aggregate_type = 'platform.service_activation'
         ORDER BY aggregate_version`,
        [tenantId],
      );
      const counts = await client.query<{
        domain_evidence_count: string;
        domain_outbox_count: string;
        leave_count: string;
        work_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM hr_leave_requests WHERE tenant_id = $1) AS leave_count,
           (SELECT count(*)::text FROM work_items
             WHERE tenant_id = $1 AND subject_type = 'hr.leave_request') AS work_count,
           (SELECT count(*)::text FROM evidence_events
             WHERE tenant_id = $1 AND subject_type = 'hr.leave_request') AS domain_evidence_count,
           (SELECT count(*)::text FROM outbox_events
             WHERE tenant_id = $1 AND aggregate_type = 'hr.leave_request') AS domain_outbox_count`,
        [tenantId],
      );
      const row = counts.rows[0];
      if (!row) throw new Error("Activation snapshot counts are unavailable");
      return {
        activation: activation.rows,
        activationEvidence: activationEvidence.rows,
        activationOutbox: activationOutbox.rows,
        domainEvidenceCount: row.domain_evidence_count,
        domainOutboxCount: row.domain_outbox_count,
        leaveCount: row.leave_count,
        workCount: row.work_count,
      };
    },
  );
}
async function workforceProfileSnapshot() {
  return await withTenantTransaction(
    pool,
    context(ids.tenantA, ids.observerA, ids.correlationWorkforceDenied),
    async ({ client }) => {
      const activation = await client.query<{ state: string; version: number }>(
        `SELECT state, version FROM service_activations
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
        [ids.tenantA],
      );
      const control = await client.query<{
        row_version: number;
        service_control_id: string;
        settings_version: number;
      }>(
        `SELECT service_control_id, settings_version, row_version
         FROM hr_workforce_profile_service_control
         WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
        [ids.tenantA],
      );
      const proof = await client.query<{
        action: string;
        after_version: number;
        before_version: number | null;
        event_type: string;
      }>(
        `SELECT evidence.event_type,
                outbox.payload ->> 'action' AS action,
                (outbox.payload ->> 'beforeVersion')::integer AS before_version,
                (outbox.payload ->> 'afterVersion')::integer AS after_version
         FROM evidence_events evidence
         JOIN outbox_events outbox
          ON outbox.tenant_id = evidence.tenant_id
         AND outbox.aggregate_type = evidence.subject_type
         AND outbox.aggregate_id = evidence.subject_id
         AND outbox.correlation_id = evidence.correlation_id
         AND outbox.event_type = evidence.event_type
         WHERE evidence.tenant_id = $1
           AND evidence.subject_type = 'hr.workforce_profile.service_control'
         ORDER BY outbox.aggregate_version`,
        [ids.tenantA],
      );
      return { activation: activation.rows, control: control.rows, proof: proof.rows };
    },
  );
}
async function setAdminA(fields: { roleKey?: string; status?: string }): Promise<void> {
  await withTenantTransaction(
    pool,
    context(ids.tenantA, ids.observerA, ids.correlationDenied),
    async ({ client }) => {
      await client.query(
        `UPDATE memberships
         SET role_key = COALESCE($3, role_key), status = COALESCE($4, status)
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenantA, ids.adminA, fields.roleKey ?? null, fields.status ?? null],
      );
    },
  );
}
async function setAdminCapability(capabilityId: string, granted: boolean): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      granted
        ? `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
           VALUES ($1, $2, $3)`
        : `DELETE FROM membership_capabilities
           WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = $3`,
      [ids.tenantA, ids.adminA, capabilityId],
    );
  } finally {
    client.release();
  }
}
async function waitForAdvisoryLock(
  observer: Pool,
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
         AND mode = $3 AND granted = $4
       ORDER BY pid
       LIMIT 1`,
      [migrationBarrierKey[0], migrationBarrierKey[1], mode, granted],
    );
    const pid = locks.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${granted ? "granted" : "waiting"} ${mode} was not observed`);
}
async function waitForAdvisoryLockAbsence(observer: Pool): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const locks = await observer.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM pg_catalog.pg_locks
       WHERE locktype = 'advisory' AND database = (
         SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()
       )
         AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
      [...migrationBarrierKey],
    );
    if (locks.rows[0]?.total === "0") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Migration barrier lock residue remained after activation rollback");
}
function withPostmasterIdentityDrift(source: Pool): Pool {
  return {
    connect: async () => {
      const client = await source.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          const result = await client.query<Record<string, unknown>>(text, [...(values ?? [])]);
          const row = result.rows[0];
          if (row && Object.hasOwn(row, "postmaster_started_at")) {
            row.postmaster_started_at = "0";
          }
          return result;
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
}

async function expectPlatformError(
  operation: Promise<unknown>,
  expected: {
    readonly code: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly message: string;
  },
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const platformError = error as Error & { code?: unknown; details?: unknown };
    expect({
      code: platformError.code,
      details: platformError.details,
      message: platformError.message,
      name: platformError.name,
    }).toEqual({ ...expected, name: "PlatformError" });
    return;
  }
  throw new Error(`Expected ${expected.code} but operation succeeded`);
}

async function expectActivationBlocked(
  readPool: Pool,
  correlationId: string,
  reason: string,
): Promise<void> {
  await expectPlatformError(
    activateHrLeaveService(pool, readPool, context(ids.tenantA, ids.adminA, correlationId), {
      expectedVersion: 99,
    }),
    {
      code: "ACTIVATION_DEPENDENCY_BLOCKED",
      details: { reasons: [reason] },
      message: "Service activation dependencies are not current",
    },
  );
}

async function expectReadinessCurrentWithoutMutation(): Promise<void> {
  const initial = await activationSnapshot();
  await expectPlatformError(
    activateHrLeaveService(
      pool,
      migrationPool,
      context(ids.tenantA, ids.adminA, ids.correlationCatalog),
      { expectedVersion: 99 },
    ),
    initialActivationConflict,
  );
  expect(await activationSnapshot()).toEqual(initial);
}

async function runSqlTransaction(client: PoolClient, statements: readonly string[]): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path TO pg_catalog");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
async function withCommittedCatalogDrift(
  catalogCase: CatalogDriftCase,
  proof: () => Promise<void>,
): Promise<void> {
  const client = await migrationPool.connect();
  let applied = false;
  const errors: unknown[] = [];
  const restore = () =>
    runSqlTransaction(
      client,
      typeof catalogCase.restore === "function" ? catalogCase.restore() : catalogCase.restore,
    );
  try {
    await runSqlTransaction(client, catalogCase.apply);
    applied = true;
    try {
      await proof();
    } catch (error) {
      errors.push(error);
    }
    try {
      await restore();
      applied = false;
    } catch (error) {
      errors.push(error);
    }
  } finally {
    if (applied) {
      try {
        await restore();
      } catch (error) {
        errors.push(error);
      }
    }
    client.release();
  }
  try {
    await expectReadinessCurrentWithoutMutation();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `Catalog drift case failed: ${catalogCase.name}`);
  }
}
beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  migrationConnectionString = process.env.DATABASE_MIGRATION_URL ?? "";
  const configuredApplicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!connectionString || !migrationConnectionString || !configuredApplicationRole) {
    throw new Error("PostgreSQL harness environment is required");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(configuredApplicationRole)) {
    throw new Error("Application role is not a safe PostgreSQL identifier");
  }
  applicationRole = configuredApplicationRole;

  migrationPool = createDatabasePool(migrationConnectionString, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrateDatabase(createDatabase(migrationPool));
  const functionDefinition = await migrationPool.query<{ definition: string }>(
    `SELECT pg_catalog.pg_get_functiondef(
       'public.esbla_current_tenant_id()'::pg_catalog.regprocedure
     ) AS definition`,
  );
  originalTenantContextFunctionDefinition = functionDefinition.rows[0]?.definition ?? "";
  if (!originalTenantContextFunctionDefinition) {
    throw new Error("Tenant context function definition is unavailable");
  }
  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(`GRANT SELECT, INSERT ON tenants, principals TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE
     ON memberships, service_activations, tenant_settings, work_items,
        outbox_events, hr_leave_requests
     TO ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT
     ON hr_workforce_profile_service_control, membership_capabilities,
        hr_workforce_status_history
     TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE ON hr_worker_profiles TO ${applicationRole}`,
  );
  pool = createDatabasePool(connectionString, { max: 8 });
  untrustedMigrationReadPool = createDatabasePool(connectionString, { max: 1 });

  await pool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Activation Tenant A'), ($2, 'Activation Tenant B')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Activation Admin'), ($2, 'Activation Employee'),
            ($3, 'Activation Manager'), ($4, 'Activation Observer')`,
    [ids.adminA, ids.employeeA, ids.managerA, ids.observerA],
  );

  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'tenant_admin', NULL),
              ($4, $2, $5, 'employee', $6),
              ($7, $2, $6, 'manager', NULL),
              ($8, $2, $9, 'tenant_admin', NULL)`,
      [
        ids.membershipAdminA,
        ids.tenantA,
        ids.adminA,
        ids.membershipEmployeeA,
        ids.employeeA,
        ids.managerA,
        ids.membershipManagerA,
        ids.membershipObserverA,
        ids.observerA,
      ],
    );
    await seedTenantRow(
      client,
      ids.tenantB,
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'employee')`,
      [ids.membershipAdminB, ids.tenantB, ids.adminA],
    );
  } finally {
    client.release();
  }
  const authorityClient = await migrationPool.connect();
  try {
    await seedTenantRow(
      authorityClient,
      ids.tenantA,
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       SELECT $1, $2, capability_id
       FROM unnest($3::text[]) AS capability(capability_id)`,
      [
        ids.tenantA,
        ids.adminA,
        [
          "hr.workforce.activate_service",
          "hr.workforce.deactivate_service",
          "hr.workforce.view_service_control",
        ],
      ],
    );
  } finally {
    authorityClient.release();
  }
});

afterAll(async () => {
  await untrustedMigrationReadPool.end();
  await pool.end();
  await migrationPool.end();
});

describe.sequential("HR Leave service lifecycle control plane", () => {
  it("authorizes before rejecting an unisolated or untrusted migration reader", async () => {
    const initial = await activationSnapshot();
    await expect(
      activateHrLeaveService(
        pool,
        rejectingMigrationReadPool,
        context(ids.tenantA, ids.employeeA, ids.correlationAppPool),
        { expectedVersion: 99 },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expectActivationBlocked(pool, ids.correlationAppPool, "migration_reader_not_isolated");
    await expectActivationBlocked(
      untrustedMigrationReadPool,
      ids.correlationAppPool,
      "migration_ledger_unavailable",
    );
    const identityFailure = await activateHrLeaveService(
      pool,
      withPostmasterIdentityDrift(migrationPool),
      context(ids.tenantA, ids.adminA, ids.correlationAppPool),
      { expectedVersion: 99 },
    ).catch((error: unknown) => error);
    expect(await activationSnapshot()).toEqual(initial);
    await waitForAdvisoryLockAbsence(migrationPool);
    await expectPlatformError(Promise.reject(identityFailure), {
      code: "ACTIVATION_DEPENDENCY_BLOCKED",
      details: { reasons: ["database_identity_mismatch"] },
      message: "Service activation dependencies are not current",
    });
    await expectActivationBlocked(
      rejectingMigrationReadPool,
      ids.correlationAppPool,
      "migration_ledger_unavailable",
    );
    expect(await activationSnapshot()).toEqual(initial);
  });

  it("fails closed on a stale required tenant-context migration", async () => {
    const initial = await activationSnapshot();
    const migration = await migrationPool.query<{ hash: string; id: number }>(
      `SELECT id, hash FROM drizzle.__drizzle_migrations
       WHERE created_at = $1 AND hash = $2`,
      [1784276307910, tenantContextHash],
    );
    expect(migration.rows).toHaveLength(1);
    const migrationId = migration.rows[0]?.id;
    if (migrationId === undefined) throw new Error("Tenant-context migration row is unavailable");
    const staleHash = "0".repeat(64);
    const changed = await migrationPool.query<{ id: number }>(
      `UPDATE drizzle.__drizzle_migrations SET hash = $3
       WHERE id = $1 AND hash = $2 RETURNING id`,
      [migrationId, tenantContextHash, staleHash],
    );
    expect(changed.rows).toEqual([{ id: migrationId }]);
    try {
      await expectActivationBlocked(
        migrationPool,
        ids.correlationMigration,
        "migration_0005_not_current",
      );
    } finally {
      const restored = await migrationPool.query<{ id: number }>(
        `UPDATE drizzle.__drizzle_migrations SET hash = $3
         WHERE id = $1 AND hash = $2 RETURNING id`,
        [migrationId, staleHash, tenantContextHash],
      );
      expect(restored.rows).toEqual([{ id: migrationId }]);
    }
    expect(await activationSnapshot()).toEqual(initial);
    await expectReadinessCurrentWithoutMutation();
  });

  it.each(catalogDriftCases)("fails closed on $name", async (catalogCase) => {
    const initial = await activationSnapshot();
    await withCommittedCatalogDrift(catalogCase, async () => {
      await expectActivationBlocked(
        migrationPool,
        ids.correlationCatalog,
        "schema_dependencies_not_current",
      );
      expect(await activationSnapshot()).toEqual(initial);
    });
    expect(await activationSnapshot()).toEqual(initial);
  });

  it("acquires a migration reader before waiting on the migration barrier", async () => {
    const initial = await activationSnapshot();
    const orderedPool = createDatabasePool(migrationConnectionString, {
      connectionTimeoutMillis: 3_000,
      max: 1,
    });
    const reservedReader = await orderedPool.connect();
    const readerPid = (
      await reservedReader.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid")
    ).rows[0]?.pid;
    if (readerPid === undefined) throw new Error("Migration-reader backend PID is unavailable");
    const sentinel = "SELECT 'migration-reader-order-sentinel'::text AS marker";
    await reservedReader.query(sentinel);
    const barrierClient = await migrationPool.connect();
    let activationFailure: unknown;
    let acquiredExclusive = false;
    let barrierHeld = false;
    let ddlLockAcquired = false;
    let readerHeld = true;
    let activation: ReturnType<typeof activateHrLeaveService> | undefined;
    let readerObservation: { idleCount: number; query?: string; state?: string } | undefined;
    let releasedExclusive = false;
    try {
      activation = activateHrLeaveService(
        pool,
        orderedPool,
        context(ids.tenantA, ids.adminA, ids.correlationMigration),
        { expectedVersion: 99 },
      );
      await expect.poll(() => orderedPool.waitingCount, { timeout: 2_000 }).toBe(1);
      expect(await activationSnapshot()).toEqual(initial);
      const locked = await barrierClient.query<{ locked: boolean }>(
        "SELECT pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS locked",
        [...migrationBarrierKey],
      );
      acquiredExclusive = locked.rows[0]?.locked === true;
      barrierHeld = acquiredExclusive;
      if (acquiredExclusive) {
        try {
          await barrierClient.query("BEGIN");
          await barrierClient.query(
            "LOCK TABLE public.memberships IN ACCESS EXCLUSIVE MODE NOWAIT",
          );
          ddlLockAcquired = true;
        } catch (error) {
          if ((error as { code?: unknown }).code !== "55P03") throw error;
        } finally {
          await barrierClient.query("ROLLBACK").catch(() => undefined);
        }
        reservedReader.release();
        readerHeld = false;
        await waitForAdvisoryLock(migrationPool, "ShareLock", false);
        const activity = await barrierClient.query<{ query: string; state: string }>(
          "SELECT state, query FROM pg_catalog.pg_stat_activity WHERE pid = $1",
          [readerPid],
        );
        readerObservation = { ...activity.rows[0], idleCount: orderedPool.idleCount };
        const unlocked = await barrierClient.query<{ unlocked: boolean }>(
          "SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
          [...migrationBarrierKey],
        );
        releasedExclusive = unlocked.rows[0]?.unlocked === true;
        barrierHeld = !releasedExclusive;
      }
    } finally {
      if (readerHeld) reservedReader.release();
      if (barrierHeld) {
        await barrierClient
          .query("SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer)", [
            ...migrationBarrierKey,
          ])
          .catch(() => undefined);
      }
      if (activation) activationFailure = await activation.catch((error: unknown) => error);
      barrierClient.release();
      await orderedPool.end();
    }
    await waitForAdvisoryLockAbsence(migrationPool);
    expect(await activationSnapshot()).toEqual(initial);
    await expectPlatformError(Promise.reject(activationFailure), initialActivationConflict);
    if (acquiredExclusive) {
      expect(releasedExclusive).toBe(true);
      expect(readerObservation).toEqual({ idleCount: 0, query: sentinel, state: "idle" });
      expect(ddlLockAcquired).toBe(true);
    }
    expect(acquiredExclusive).toBe(true);
  });

  it("requires a current tenant admin and preserves replay across later drift", async () => {
    const initial = await activationSnapshot();
    for (const actorPrincipalId of [ids.employeeA, ids.managerA]) {
      await expect(
        activateHrLeaveService(
          pool,
          rejectingMigrationReadPool,
          context(ids.tenantA, actorPrincipalId, ids.correlationDenied),
          { expectedVersion: null },
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    }
    expect(await activationSnapshot()).toEqual(initial);
    await expect(
      activateHrLeaveService(
        pool,
        migrationPool,
        context(ids.tenantB, ids.adminA, ids.correlationCrossTenant),
        { expectedVersion: null },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await activationSnapshot(ids.tenantB, ids.adminA)).toMatchObject({
      activation: [],
      activationEvidence: [],
      activationOutbox: [],
    });

    await expect(
      activateHrLeaveService(
        pool,
        migrationPool,
        context(ids.tenantA, ids.adminA, ids.correlationActivate),
        { expectedVersion: null },
      ),
    ).resolves.toEqual({
      billingState: "non_billable",
      replayed: false,
      serviceKey: "hr.leave_request",
      state: "active",
      version: 1,
    });
    const active = await activationSnapshot();
    expect(active).toMatchObject({
      activation: [{ state: "active", version: 1 }],
      activationEvidence: [
        {
          event_type: "evidence.hr.leave_service.activated",
          new_state: "active",
          prior_state: "inactive",
        },
      ],
      activationOutbox: [
        {
          aggregate_version: 1,
          event_type: "internal.platform.service_activation.changed",
          payload: { serviceKey: "hr.leave_request", state: "active", version: 1 },
        },
      ],
    });

    const staleHash = "1".repeat(64);
    await migrationPool.query("UPDATE drizzle.__drizzle_migrations SET hash = $2 WHERE hash = $1", [
      tenantContextHash,
      staleHash,
    ]);
    try {
      await expect(
        activateHrLeaveService(
          pool,
          rejectingMigrationReadPool,
          context(ids.tenantA, ids.adminA, ids.correlationActivate),
          { expectedVersion: null },
        ),
      ).resolves.toMatchObject({ billingState: "non_billable", replayed: true, version: 1 });
    } finally {
      await migrationPool.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = $2 WHERE hash = $1",
        [staleHash, tenantContextHash],
      );
    }
    await expect(
      activateHrLeaveService(
        pool,
        rejectingMigrationReadPool,
        context(ids.tenantA, ids.adminA, ids.correlationActivate),
        { expectedVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const demotingReadPool = {
      connect: async () => {
        await setAdminA({ roleKey: "employee" });
        throw new Error("sensitive migration-reader diagnostic");
      },
    } as unknown as Pool;
    try {
      await expect(
        activateHrLeaveService(
          pool,
          demotingReadPool,
          context(ids.tenantA, ids.adminA, ids.correlationCatalog),
          { expectedVersion: 1 },
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await setAdminA({ roleKey: "tenant_admin" });
    }
    await setAdminA({ status: "suspended" });
    try {
      await expect(
        activateHrLeaveService(
          pool,
          migrationPool,
          context(ids.tenantA, ids.adminA, ids.correlationActivate),
          { expectedVersion: null },
        ),
      ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" });
    } finally {
      await setAdminA({ status: "active" });
    }
    expect(await activationSnapshot()).toEqual(active);
  });

  it("deactivates without deleting product state and gates every public Leave operation", async () => {
    await submitLeaveRequest(pool, context(ids.tenantA, ids.employeeA, ids.correlationSubmit), {
      categoryCode: "annual",
      endDate: "2027-04-17",
      idempotencyKey: "activation-preservation",
      leaveRequestId: ids.request,
      reason: "Lifecycle preservation proof",
      startDate: "2027-04-17",
    });
    const before = await activationSnapshot();
    expect(before).toMatchObject({
      domainEvidenceCount: "1",
      domainOutboxCount: "1",
      leaveCount: "1",
      workCount: "1",
    });
    await expect(
      deactivateHrLeaveService(
        pool,
        context(ids.tenantA, ids.employeeA, ids.correlationDeactivate),
        { expectedVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const deactivated = await deactivateHrLeaveService(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationDeactivate),
      { expectedVersion: 1 },
    );
    expect(deactivated).toEqual({
      billingState: "non_billable",
      replayed: false,
      serviceKey: "hr.leave_request",
      state: "inactive",
      version: 2,
    });
    await expect(
      deactivateHrLeaveService(pool, context(ids.tenantA, ids.adminA, ids.correlationDeactivate), {
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ billingState: "non_billable", replayed: true, version: 2 });

    const after = await activationSnapshot();
    expect(after).toMatchObject({
      activation: [{ state: "inactive", version: 2 }],
      activationEvidence: [
        {
          event_type: "evidence.hr.leave_service.activated",
          new_state: "active",
          prior_state: "inactive",
        },
        {
          event_type: "evidence.hr.leave_service.deactivated",
          new_state: "inactive",
          prior_state: "active",
        },
      ],
      activationOutbox: [
        {
          aggregate_version: 1,
          event_type: "internal.platform.service_activation.changed",
        },
        {
          aggregate_version: 2,
          event_type: "internal.platform.service_activation.changed",
        },
      ],
      domainEvidenceCount: before.domainEvidenceCount,
      domainOutboxCount: before.domainOutboxCount,
      leaveCount: before.leaveCount,
      workCount: before.workCount,
    });

    const inactiveEmployee = context(ids.tenantA, ids.employeeA, ids.correlationSubmitBlocked);
    const inactiveManager = context(ids.tenantA, ids.managerA, ids.correlationSubmitBlocked);
    const inactiveOperations = [
      () =>
        submitLeaveRequest(pool, inactiveEmployee, {
          categoryCode: "annual" as const,
          endDate: "2027-04-18",
          idempotencyKey: "inactive-submit",
          leaveRequestId: ids.requestBlocked,
          startDate: "2027-04-18",
        }),
      () =>
        approveLeaveRequest(pool, inactiveManager, {
          expectedVersion: 1,
          leaveRequestId: ids.request,
        }),
      () =>
        rejectLeaveRequest(pool, inactiveManager, {
          decisionNote: "Inactive",
          expectedVersion: 1,
          leaveRequestId: ids.request,
        }),
      () => getLeaveRequest(pool, inactiveEmployee, ids.request),
      () => getLeaveRequestDetail(pool, inactiveEmployee, ids.request),
      () => listOwnLeaveRequests(pool, inactiveEmployee),
      () => listAssignedLeaveRequests(pool, inactiveManager),
      () => listLeaveEvidence(pool, inactiveEmployee, ids.request),
    ];
    for (const operation of inactiveOperations) {
      await expect(operation()).rejects.toMatchObject({ code: "LEAVE_SERVICE_INACTIVE" });
    }
    expect(await activationSnapshot()).toEqual(after);
  });
});
describe.sequential("Workforce Profile service-control lifecycle", () => {
  it("fails closed for unauthorized actors and preserves exact historical replay proof", async () => {
    const employeeContext = context(ids.tenantA, ids.employeeA, ids.correlationWorkforceDenied);
    await expect(getWorkforceProfileServiceControl(pool, employeeContext)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await expect(
      getWorkforceProfileServiceControl(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationWorkforceDenied),
      ),
    ).rejects.toMatchObject({ code: "WORKFORCE_SERVICE_CONTROL_NOT_FOUND" });
    const empty = await workforceProfileSnapshot();
    expect(empty).toEqual({ activation: [], control: [], proof: [] });
    await expect(
      activateWorkforceProfileService(pool, rejectingMigrationReadPool, employeeContext, {
        expectedVersion: null,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await workforceProfileSnapshot()).toEqual(empty);

    const activated = await activateWorkforceProfileService(
      pool,
      migrationPool,
      context(ids.tenantA, ids.adminA, ids.correlationWorkforceActivate),
      { expectedVersion: null },
    );
    expect(activated).toEqual({
      billingState: "non_billable",
      control: {
        activationState: "active",
        activationVersion: 1,
        serviceKey: "workforce_profile",
        settingsVersion: 1,
        updatedAt: expect.any(String),
        version: 1,
      },
      replayed: false,
    });
    await expect(
      activateWorkforceProfileService(
        pool,
        rejectingMigrationReadPool,
        context(ids.tenantA, ids.adminA, ids.correlationWorkforceActivate),
        { expectedVersion: null },
      ),
    ).resolves.toEqual({ ...activated, replayed: true });

    const deactivated = await deactivateWorkforceProfileService(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationWorkforceDeactivate),
      { expectedVersion: 1 },
    );
    expect(deactivated.control).toMatchObject({
      activationState: "inactive",
      activationVersion: 2,
      settingsVersion: 1,
      version: 2,
    });
    await expect(
      deactivateWorkforceProfileService(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationWorkforceDeactivate),
        { expectedVersion: 1 },
      ),
    ).resolves.toEqual({ ...deactivated, replayed: true });

    const reactivated = await activateWorkforceProfileService(
      pool,
      migrationPool,
      context(ids.tenantA, ids.adminA, ids.correlationWorkforceReactivate),
      { expectedVersion: 2 },
    );
    expect(reactivated.control).toMatchObject({
      activationState: "active",
      activationVersion: 3,
      settingsVersion: 1,
      version: 3,
    });
    await expect(
      activateWorkforceProfileService(
        pool,
        rejectingMigrationReadPool,
        context(ids.tenantA, ids.adminA, ids.correlationWorkforceActivate),
        { expectedVersion: null },
      ),
    ).resolves.toEqual({ ...activated, replayed: true });
    await expect(
      getWorkforceProfileServiceControl(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationWorkforceDenied),
      ),
    ).resolves.toEqual({ ...reactivated, replayed: false });

    const proofContext = context(ids.tenantA, ids.observerA, ids.correlationWorkforceDenied);
    const originalPayload = await withTenantTransaction(pool, proofContext, async ({ client }) => {
      const proof = await client.query<{ payload: unknown }>(
        `SELECT payload FROM outbox_events
         WHERE tenant_id = $1
           AND aggregate_type = 'hr.workforce_profile.service_control'
           AND correlation_id = $2`,
        [ids.tenantA, ids.correlationWorkforceActivate],
      );
      const payload = proof.rows[0]?.payload;
      if (
        !payload ||
        typeof payload !== "object" ||
        !("serviceControl" in payload) ||
        !payload.serviceControl ||
        typeof payload.serviceControl !== "object"
      ) {
        throw new Error("Workforce Profile replay proof is unavailable");
      }
      await client.query(
        `UPDATE outbox_events
         SET payload = jsonb_set(payload, '{serviceControl,updatedAt}', '"2000-01-01T00:00:00.000Z"')
         WHERE tenant_id = $1
           AND aggregate_type = 'hr.workforce_profile.service_control'
           AND correlation_id = $2`,
        [ids.tenantA, ids.correlationWorkforceActivate],
      );
      return payload;
    });
    try {
      await expect(
        activateWorkforceProfileService(
          pool,
          rejectingMigrationReadPool,
          context(ids.tenantA, ids.adminA, ids.correlationWorkforceActivate),
          { expectedVersion: null },
        ),
      ).rejects.toMatchObject({ code: "ACTIVATION_CONFLICT" });
    } finally {
      await withTenantTransaction(pool, proofContext, async ({ client }) =>
        client.query(
          `UPDATE outbox_events SET payload = $3::jsonb
           WHERE tenant_id = $1
             AND aggregate_type = 'hr.workforce_profile.service_control'
             AND correlation_id = $2`,
          [ids.tenantA, ids.correlationWorkforceActivate, JSON.stringify(originalPayload)],
        ),
      );
    }

    const beforeDemotion = await workforceProfileSnapshot();
    await setAdminA({ roleKey: "employee" });
    try {
      await expect(
        getWorkforceProfileServiceControl(
          pool,
          context(ids.tenantA, ids.adminA, ids.correlationWorkforceDenied),
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(
        activateWorkforceProfileService(
          pool,
          rejectingMigrationReadPool,
          context(ids.tenantA, ids.adminA, ids.correlationWorkforceActivate),
          { expectedVersion: null },
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await setAdminA({ roleKey: "tenant_admin" });
    }
    await expect(
      getWorkforceProfileServiceControl(
        pool,
        context(ids.tenantB, ids.adminA, ids.correlationWorkforceDenied),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await workforceProfileSnapshot()).toEqual(beforeDemotion);
  });

  it("re-reads the exact current capability for every service-control consumer", async () => {
    const before = await workforceProfileSnapshot();
    const cases = [
      {
        capability: "hr.workforce.view_service_control",
        operation: () =>
          getWorkforceProfileServiceControl(
            pool,
            context(ids.tenantA, ids.adminA, ids.correlationWorkforceDenied),
          ),
      },
      {
        capability: "hr.workforce.activate_service",
        operation: () =>
          activateWorkforceProfileService(
            pool,
            migrationPool,
            context(ids.tenantA, ids.adminA, ids.correlationWorkforceCatalog),
            { expectedVersion: 2 },
          ),
      },
      {
        capability: "hr.workforce.deactivate_service",
        operation: () =>
          deactivateWorkforceProfileService(
            pool,
            context(ids.tenantA, ids.adminA, ids.correlationWorkforceCatalog),
            { expectedVersion: 3 },
          ),
      },
    ];
    for (const testCase of cases) {
      await setAdminCapability(testCase.capability, false);
      try {
        await expect(testCase.operation()).rejects.toMatchObject({ code: "POLICY_DENIED" });
      } finally {
        await setAdminCapability(testCase.capability, true);
      }
    }
    expect(await workforceProfileSnapshot()).toEqual(before);
  });

  it("blocks stale migration and catalog evidence before activation", async () => {
    await deactivateWorkforceProfileService(
      pool,
      context(ids.tenantA, ids.adminA, "50000000-0000-4000-8000-000000002015"),
      { expectedVersion: 3 },
    );
    const inactive = await workforceProfileSnapshot();
    await expect(
      activateWorkforceProfileServiceDomain(
        pool,
        migrationPool,
        context(ids.tenantA, ids.adminA, ids.correlationWorkforceCatalog),
        { expectedVersion: 4 },
        "production",
      ),
    ).rejects.toMatchObject({
      code: "ACTIVATION_DEPENDENCY_BLOCKED",
      details: { reasons: ["qualified_retention_evidence_unavailable"] },
    });
    expect(await workforceProfileSnapshot()).toEqual(inactive);
    const blocked = async (reason: string, runtimePool: Pool = pool) =>
      await expect(
        activateWorkforceProfileService(
          runtimePool,
          migrationPool,
          context(ids.tenantA, ids.adminA, ids.correlationWorkforceCatalog),
          { expectedVersion: 4 },
        ),
      ).rejects.toMatchObject({
        code: "ACTIVATION_DEPENDENCY_BLOCKED",
        details: { reasons: [reason] },
      });
    const drift = async (
      apply: string,
      restore: string,
      reason: string,
      driftPool = migrationPool,
    ) => {
      await driftPool.query(apply);
      try {
        await blocked(reason);
      } finally {
        await driftPool.query(restore);
      }
    };

    for (const [grant, revoke] of [
      [
        `GRANT UPDATE (settings_version) ON hr_workforce_profile_service_control TO ${applicationRole}`,
        `REVOKE UPDATE (settings_version) ON hr_workforce_profile_service_control FROM ${applicationRole}`,
      ],
      [
        `GRANT REFERENCES ON hr_worker_profiles TO ${applicationRole}`,
        `REVOKE REFERENCES ON hr_worker_profiles FROM ${applicationRole}`,
      ],
      [
        `GRANT TRIGGER ON hr_worker_profiles TO ${applicationRole}`,
        `REVOKE TRIGGER ON hr_worker_profiles FROM ${applicationRole}`,
      ],
    ] as const) {
      await drift(grant, revoke, "runtime_projection_privileges_not_current");
    }
    expect(await workforceProfileSnapshot()).toEqual(inactive);

    const staleHash = "2".repeat(64);
    await migrationPool.query("UPDATE drizzle.__drizzle_migrations SET hash = $2 WHERE hash = $1", [
      workforceProfileMigrationHash,
      staleHash,
    ]);
    try {
      await blocked("migration_0008_not_current");
    } finally {
      await migrationPool.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = $2 WHERE hash = $1",
        [staleHash, workforceProfileMigrationHash],
      );
    }
    expect(await workforceProfileSnapshot()).toEqual(inactive);

    for (const [apply, restore] of [
      [
        "ALTER TABLE service_activations DISABLE TRIGGER service_activations_sync_hr_workforce_profile",
        "ALTER TABLE service_activations ENABLE TRIGGER service_activations_sync_hr_workforce_profile",
      ],
      [
        "ALTER TABLE membership_capabilities DISABLE TRIGGER membership_capabilities_guard_authority",
        "ALTER TABLE membership_capabilities ENABLE TRIGGER membership_capabilities_guard_authority",
      ],
      [
        "ALTER TABLE hr_worker_profiles DISABLE TRIGGER hr_worker_profiles_enforce_state",
        "ALTER TABLE hr_worker_profiles ENABLE TRIGGER hr_worker_profiles_enforce_state",
      ],
      [
        "CREATE TRIGGER hr_worker_profiles_extra_drift BEFORE UPDATE ON hr_worker_profiles FOR EACH ROW EXECUTE FUNCTION esbla_enforce_hr_workforce_profile_state()",
        "DROP TRIGGER hr_worker_profiles_extra_drift ON hr_worker_profiles",
      ],
      [
        "ALTER TYPE hr_workforce_status RENAME VALUE 'terminated' TO 'ended'",
        "ALTER TYPE hr_workforce_status RENAME VALUE 'ended' TO 'terminated'",
      ],
      [
        "CREATE POLICY hr_worker_profiles_restrictive_drift ON hr_worker_profiles AS RESTRICTIVE FOR SELECT USING (false)",
        "DROP POLICY hr_worker_profiles_restrictive_drift ON hr_worker_profiles",
      ],
      [
        `GRANT EXECUTE ON FUNCTION esbla_append_hr_workforce_status_history() TO ${applicationRole}`,
        `REVOKE EXECUTE ON FUNCTION esbla_append_hr_workforce_status_history() FROM ${applicationRole}`,
      ],
    ] as const)
      await drift(apply, restore, "schema_dependencies_not_current");
    const migrationRole = /^postgresql:\/\/([a-z_][a-z0-9_]*)@\//.exec(
      migrationConnectionString,
    )?.[1];
    if (!migrationRole) throw new Error("Unsafe migration role");
    const adminConnectionString = migrationConnectionString.replace(
      `postgresql://${migrationRole}@/`,
      "postgresql://postgres@/",
    );
    const applicationConnectionString = migrationConnectionString.replace(
      `postgresql://${migrationRole}@/`,
      `postgresql://${applicationRole}@/`,
    );
    const adminPool = createDatabasePool(adminConnectionString, { max: 1 });
    try {
      for (const attribute of "SUPERUSER,BYPASSRLS,REPLICATION,CREATEROLE,CREATEDB".split(",")) {
        await adminPool.query(`ALTER ROLE ${applicationRole} WITH ${attribute}`);
        try {
          await blocked("runtime_projection_privileges_not_current");
        } finally {
          await adminPool.query(`ALTER ROLE ${applicationRole} WITH NO${attribute}`);
        }
      }
      await adminPool.query(`GRANT pg_monitor TO ${applicationRole}`);
      try {
        await blocked("runtime_projection_privileges_not_current");
      } finally {
        await adminPool.query(`REVOKE pg_monitor FROM ${applicationRole}`);
      }
      const assumedRolePool = createDatabasePool(adminConnectionString, {
        max: 1,
        options: `-c role=${applicationRole}`,
      });
      try {
        await blocked("runtime_projection_privileges_not_current", assumedRolePool);
      } finally {
        await assumedRolePool.end();
      }
      await adminPool.query(`ALTER ROLE ${applicationRole} SET session_replication_role = replica`);
      const replicaPool = createDatabasePool(applicationConnectionString, { max: 1 });
      try {
        await blocked("runtime_projection_privileges_not_current", replicaPool);
      } finally {
        await replicaPool.end();
        await adminPool.query(`ALTER ROLE ${applicationRole} RESET session_replication_role`);
      }
      const serverVersionNum = (
        await adminPool.query<{ value: number }>(
          "SELECT current_setting('server_version_num')::integer AS value",
        )
      ).rows[0]?.value;
      if (!serverVersionNum) throw new Error("PostgreSQL version unavailable");
      if (serverVersionNum >= 150000) {
        for (const privilege of ["SET", "ALTER SYSTEM"]) {
          await drift(
            `GRANT ${privilege} ON PARAMETER session_replication_role TO ${applicationRole}`,
            `REVOKE ${privilege} ON PARAMETER session_replication_role FROM ${applicationRole}`,
            "runtime_projection_privileges_not_current",
            adminPool,
          );
        }
      }
      for (const [apply, restore, reason] of [
        [
          "ALTER FUNCTION esbla_append_hr_workforce_status_history() OWNER TO postgres",
          `ALTER FUNCTION esbla_append_hr_workforce_status_history() OWNER TO ${migrationRole}`,
          "schema_dependencies_not_current",
        ],
        [
          "ALTER TABLE hr_worker_profiles OWNER TO postgres",
          `ALTER TABLE hr_worker_profiles OWNER TO ${migrationRole}`,
          "schema_dependencies_not_current",
        ],
        [
          "ALTER TYPE hr_workforce_status OWNER TO postgres",
          `ALTER TYPE hr_workforce_status OWNER TO ${migrationRole}`,
          "schema_dependencies_not_current",
        ],
      ] as const) {
        await adminPool.query(apply);
        try {
          await blocked(reason);
        } finally {
          await adminPool.query(restore);
        }
      }
    } finally {
      await adminPool.end();
    }
    expect(await workforceProfileSnapshot()).toEqual(inactive);
    await expect(
      activateWorkforceProfileService(
        pool,
        migrationPool,
        context(ids.tenantA, ids.adminA, ids.correlationWorkforceCatalog),
        { expectedVersion: 4 },
      ),
    ).resolves.toMatchObject({
      control: { activationState: "active", activationVersion: 5, version: 5 },
      replayed: false,
    });
  });

  it("serializes same-key replay and distinct-key conflict without duplicate proof", async () => {
    await deactivateWorkforceProfileService(
      pool,
      context(ids.tenantA, ids.adminA, "50000000-0000-4000-8000-000000002016"),
      { expectedVersion: 5 },
    );
    const sameContext = context(ids.tenantA, ids.adminA, "50000000-0000-4000-8000-000000002017");
    const same = await Promise.all([
      activateWorkforceProfileService(pool, migrationPool, sameContext, { expectedVersion: 6 }),
      activateWorkforceProfileService(pool, migrationPool, sameContext, { expectedVersion: 6 }),
    ]);
    expect(same.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(same.map(({ control }) => control.version)).toEqual([7, 7]);

    await deactivateWorkforceProfileService(
      pool,
      context(ids.tenantA, ids.adminA, "50000000-0000-4000-8000-000000002018"),
      { expectedVersion: 7 },
    );
    const distinct = await Promise.allSettled([
      activateWorkforceProfileService(
        pool,
        migrationPool,
        context(ids.tenantA, ids.adminA, "50000000-0000-4000-8000-000000002019"),
        { expectedVersion: 8 },
      ),
      activateWorkforceProfileService(
        pool,
        migrationPool,
        context(ids.tenantA, ids.adminA, "50000000-0000-4000-8000-000000002020"),
        { expectedVersion: 8 },
      ),
    ]);
    expect(distinct.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = distinct.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "ACTIVATION_CONFLICT" } });
    const final = await workforceProfileSnapshot();
    expect(final.activation).toEqual([{ state: "active", version: 9 }]);
    expect(final.control).toMatchObject([{ row_version: 9, settings_version: 1 }]);
    expect(final.proof).toHaveLength(9);
  });
});
