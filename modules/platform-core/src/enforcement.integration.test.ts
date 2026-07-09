import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeWorkItem,
  createWorkItem,
  deriveStableUuid,
  evaluatePolicy,
  getServiceActivation,
  recordMutationProof,
  resolveSetting,
  setServiceActivation,
  type TenantTransaction,
  withTenantTransaction,
} from "./index.js";

const ids = {
  adminA: "10000000-0000-4000-8000-000000000001",
  adminB: "10000000-0000-4000-8000-000000000004",
  correlationActivate1: "50000000-0000-4000-8000-000000000001",
  correlationActivate2: "50000000-0000-4000-8000-000000000003",
  correlationDeactivate: "50000000-0000-4000-8000-000000000002",
  correlationEmployee: "50000000-0000-4000-8000-000000000004",
  correlationManager: "50000000-0000-4000-8000-000000000005",
  employeeA: "10000000-0000-4000-8000-000000000003",
  managerA: "10000000-0000-4000-8000-000000000002",
  membershipAdminA: "20000000-0000-4000-8000-000000000001",
  membershipAdminB: "20000000-0000-4000-8000-000000000004",
  membershipEmployeeA: "20000000-0000-4000-8000-000000000003",
  membershipManagerA: "20000000-0000-4000-8000-000000000002",
  subject: "30000000-0000-4000-8000-000000000001",
  subjectRollback: "30000000-0000-4000-8000-000000000002",
  tenantA: "00000000-0000-4000-8000-000000000001",
  tenantB: "00000000-0000-4000-8000-000000000002",
} as const;

let migrationPool: Pool;
let pool: Pool;

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

function context(tenantId: string, actorPrincipalId: string, correlationId: string) {
  return { actorPrincipalId, correlationId, tenantId };
}

function activationAuthorization(
  transaction: TenantTransaction,
  targetState: "active" | "inactive",
) {
  return evaluatePolicy(
    {
      actionKey: `platform.service_activation.${targetState === "active" ? "activate" : "deactivate"}`,
      input: { serviceKey: "hr.leave_request" },
      resourceKey: "hr.leave_request",
      transaction,
    },
    [
      {
        effect: "allow",
        id: "active-tenant-admin",
        matches: (_input, actor) => actor.roleKey === "tenant_admin",
      },
    ],
  );
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!connectionString || !migrationConnectionString || !applicationRole) {
    throw new Error("PostgreSQL harness environment is required");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("Application role is not a safe PostgreSQL identifier");
  }

  migrationPool = createDatabasePool(migrationConnectionString, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(`GRANT SELECT, INSERT ON tenants, principals TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
     ON memberships, service_activations, tenant_settings, work_items, outbox_events
     TO ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);

  pool = createDatabasePool(connectionString, { max: 5 });
  await pool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Admin A'), ($2, 'Manager A'), ($3, 'Employee A'), ($4, 'Admin B')`,
    [ids.adminA, ids.managerA, ids.employeeA, ids.adminB],
  );

  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'tenant_admin'), ($4, $2, $5, 'manager')`,
      [ids.membershipAdminA, ids.tenantA, ids.adminA, ids.membershipManagerA, ids.managerA],
    );
    await seedTenantRow(
      client,
      ids.tenantA,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'employee', $4)`,
      [ids.membershipEmployeeA, ids.tenantA, ids.employeeA, ids.managerA],
    );
    await seedTenantRow(
      client,
      ids.tenantB,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'tenant_admin')`,
      [ids.membershipAdminB, ids.tenantB, ids.adminB],
    );
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
  await migrationPool.end();
});

describe("platform enforcement primitives", () => {
  it("requires a valid active tenant member and keeps tenant reads scoped", async () => {
    await expect(
      withTenantTransaction(
        pool,
        context("not-a-uuid", ids.adminA, ids.correlationActivate1),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "INVALID_OPERATION_CONTEXT" });

    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async ({ client }) => {
        const rows = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM memberships");
        expect(rows.rows.every((row) => row.tenant_id === ids.tenantA)).toBe(true);
      },
    );

    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async ({ client }) => {
        await client.query("UPDATE memberships SET status = 'suspended' WHERE principal_id = $1", [
          ids.employeeA,
        ]);
      },
    );
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.employeeA, ids.correlationEmployee),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" });
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async ({ client }) => {
        await client.query("UPDATE memberships SET status = 'active' WHERE principal_id = $1", [
          ids.employeeA,
        ]);
      },
    );
  });

  it("resolves registered defaults and validated tenant overrides", async () => {
    const definition = {
      allowTenantOverride: true,
      defaultValue: false,
      key: "hr.leave.require_reason",
      valueType: "boolean" as const,
    };
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async (transaction) => {
        expect(await resolveSetting(transaction, definition)).toEqual({
          key: definition.key,
          source: "registered_default",
          value: false,
          version: null,
        });
        await transaction.client.query(
          `INSERT INTO tenant_settings (tenant_id, setting_key, value_type, value)
           VALUES ($1, $2, 'boolean', 'true'::jsonb)`,
          [ids.tenantA, definition.key],
        );
        expect(await resolveSetting(transaction, definition)).toMatchObject({
          source: "tenant_override",
          value: true,
          version: 1,
        });
        await expect(
          resolveSetting(transaction, { ...definition, allowTenantOverride: false }),
        ).rejects.toMatchObject({ code: "SETTING_OVERRIDE_NOT_ALLOWED" });
        await expect(
          resolveSetting(transaction, {
            ...definition,
            policyFloor: { kind: "locked", value: false } as const,
          }),
        ).rejects.toMatchObject({ code: "SETTING_INVALID" });
      },
    );
    await withTenantTransaction(
      pool,
      context(ids.tenantB, ids.adminB, ids.correlationActivate1),
      async (transaction) => {
        expect(await resolveSetting(transaction, definition)).toMatchObject({
          source: "registered_default",
          value: false,
        });
      },
    );
  });

  it("blocks activation until dependencies are current and supports CAS plus replay", async () => {
    const staleDecision = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async (transaction) => activationAuthorization(transaction, "active"),
    );
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationActivate1),
        async (transaction) =>
          await setServiceActivation(transaction, {
            authorization: staleDecision,
            evidenceEventType: "evidence.hr.leave_service.activated",
            expectedVersion: null,
            outboxEventType: "hr.leave_service.activated",
            preflight: async () => ({ current: true, reasons: [] }),
            serviceKey: "hr.leave_request",
            targetState: "active",
          }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationActivate1),
        async (transaction) =>
          await setServiceActivation(transaction, {
            authorization: { ...activationAuthorization(transaction, "active") },
            evidenceEventType: "evidence.hr.leave_service.activated",
            expectedVersion: null,
            outboxEventType: "hr.leave_service.activated",
            preflight: async () => ({ current: true, reasons: [] }),
            serviceKey: "hr.leave_request",
            targetState: "active",
          }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationActivate1),
        async (transaction) =>
          await setServiceActivation(transaction, {
            authorization: activationAuthorization(transaction, "active"),
            evidenceEventType: "evidence.hr.leave_service.activated",
            expectedVersion: null,
            outboxEventType: "hr.leave_service.activated",
            preflight: async () => ({ current: false, reasons: ["migration_not_current"] }),
            serviceKey: "hr.leave_request",
            targetState: "active",
          }),
      ),
    ).rejects.toMatchObject({ code: "ACTIVATION_DEPENDENCY_BLOCKED" });

    const activated = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async (transaction) =>
        await setServiceActivation(transaction, {
          authorization: activationAuthorization(transaction, "active"),
          evidenceEventType: "evidence.hr.leave_service.activated",
          expectedVersion: null,
          outboxEventType: "hr.leave_service.activated",
          preflight: async () => ({ current: true, reasons: [] }),
          serviceKey: "hr.leave_request",
          targetState: "active",
        }),
    );
    expect(activated).toMatchObject({ replayed: false, state: "active", version: 1 });

    const replayed = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async (transaction) =>
        await setServiceActivation(transaction, {
          authorization: activationAuthorization(transaction, "active"),
          evidenceEventType: "evidence.hr.leave_service.activated",
          expectedVersion: null,
          outboxEventType: "hr.leave_service.activated",
          preflight: async () => ({ current: true, reasons: [] }),
          serviceKey: "hr.leave_request",
          targetState: "active",
        }),
    );
    expect(replayed).toMatchObject({ replayed: true, state: "active", version: 1 });

    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationDeactivate),
      async (transaction) => {
        expect(
          await setServiceActivation(transaction, {
            authorization: activationAuthorization(transaction, "inactive"),
            evidenceEventType: "evidence.hr.leave_service.deactivated",
            expectedVersion: 1,
            outboxEventType: "hr.leave_service.deactivated",
            serviceKey: "hr.leave_request",
            targetState: "inactive",
          }),
        ).toMatchObject({ state: "inactive", version: 2 });
      },
    );
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate2),
      async (transaction) => {
        expect(
          await setServiceActivation(transaction, {
            authorization: activationAuthorization(transaction, "active"),
            evidenceEventType: "evidence.hr.leave_service.activated",
            expectedVersion: 2,
            outboxEventType: "hr.leave_service.activated",
            preflight: async () => ({ current: true, reasons: [] }),
            serviceKey: "hr.leave_request",
            targetState: "active",
          }),
        ).toMatchObject({ state: "active", version: 3 });
        expect(await getServiceActivation(transaction, "hr.leave_request")).toMatchObject({
          state: "active",
          version: 3,
        });
      },
    );

    const originalReplay = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate1),
      async (transaction) =>
        await setServiceActivation(transaction, {
          authorization: activationAuthorization(transaction, "active"),
          evidenceEventType: "evidence.hr.leave_service.activated",
          expectedVersion: null,
          outboxEventType: "hr.leave_service.activated",
          preflight: async () => ({ current: false, reasons: ["now_stale"] }),
          serviceKey: "hr.leave_request",
          targetState: "active",
        }),
    );
    expect(originalReplay).toMatchObject({ replayed: true, state: "active", version: 1 });

    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationActivate2),
      async ({ client }) => {
        const evidence = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM evidence_events WHERE subject_type = 'platform.service_activation'",
        );
        const outbox = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM outbox_events WHERE aggregate_type = 'platform.service_activation'",
        );
        expect(evidence.rows[0]?.count).toBe("3");
        expect(outbox.rows[0]?.count).toBe("3");
      },
    );
  });

  it("creates and completes typed work items idempotently and rolls back atomically", async () => {
    const created = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationEmployee),
      async (transaction) =>
        await createWorkItem(transaction, {
          assigneePrincipalId: ids.managerA,
          subjectId: ids.subject,
          subjectType: "hr.leave_request",
          workType: "hr.leave_request.approval",
        }),
    );
    expect(created).toMatchObject({ replayed: false, status: "open" });
    const replay = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationEmployee),
      async (transaction) =>
        await createWorkItem(transaction, {
          assigneePrincipalId: ids.managerA,
          subjectId: ids.subject,
          subjectType: "hr.leave_request",
          workType: "hr.leave_request.approval",
        }),
    );
    expect(replay).toMatchObject({ replayed: true, workItemId: created.workItemId });

    const completed = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationManager),
      async (transaction) => await completeWorkItem(transaction, created.workItemId),
    );
    expect(completed).toMatchObject({ replayed: false, status: "completed" });
    const completionReplay = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationManager),
      async (transaction) => await completeWorkItem(transaction, created.workItemId),
    );
    expect(completionReplay).toMatchObject({ replayed: true, status: "completed" });

    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.employeeA, ids.correlationEmployee),
        async (transaction) => {
          await createWorkItem(transaction, {
            assigneePrincipalId: ids.managerA,
            subjectId: ids.subjectRollback,
            subjectType: "hr.leave_request",
            workType: "hr.leave_request.approval",
          });
          throw new Error("force rollback");
        },
      ),
    ).rejects.toThrow("force rollback");
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationManager),
      async ({ client }) => {
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM work_items WHERE subject_id = $1",
          [ids.subjectRollback],
        );
        expect(count.rows[0]?.count).toBe("0");
      },
    );
  });

  it("rejects changed proof payloads under the same idempotency keys", async () => {
    const aggregateId = deriveStableUuid("test.aggregate", ids.tenantA, ids.subjectRollback);
    const proof = {
      evidence: {
        eventType: "evidence.test.recorded",
        newState: "recorded",
        priorState: null,
        subjectId: aggregateId,
        subjectType: "test.aggregate",
      },
      outbox: {
        aggregateId,
        aggregateType: "test.aggregate",
        aggregateVersion: 1,
        eventType: "test.recorded",
        payload: { value: "original" },
      },
    };
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationEmployee),
      async (transaction) => await recordMutationProof(transaction, proof),
    );
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationEmployee),
        async (transaction) =>
          await recordMutationProof(transaction, {
            ...proof,
            outbox: { ...proof.outbox, payload: { value: "changed" } },
          }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
