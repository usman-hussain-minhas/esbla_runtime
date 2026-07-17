import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import {
  evaluatePolicy,
  type OperationContext,
  setServiceActivation,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveLeaveRequest,
  getLeaveRequestDetail,
  listAssignedLeaveRequests,
  listLeaveEvidence,
  rejectLeaveRequest,
  submitLeaveRequest,
} from "./index.js";

const ids = {
  admin: "10000000-0000-4000-8000-000000001201",
  correlationActivate: "50000000-0000-4000-8000-000000001201",
  correlationApprove: "50000000-0000-4000-8000-000000001205",
  correlationReject: "50000000-0000-4000-8000-000000001203",
  correlationRejectRetry: "50000000-0000-4000-8000-000000001204",
  correlationSubmit: "50000000-0000-4000-8000-000000001202",
  employee: "10000000-0000-4000-8000-000000001203",
  manager: "10000000-0000-4000-8000-000000001202",
  membershipAdmin: "20000000-0000-4000-8000-000000001201",
  membershipEmployee: "20000000-0000-4000-8000-000000001203",
  membershipManager: "20000000-0000-4000-8000-000000001202",
  request: "30000000-0000-4000-8000-000000001201",
  requestApproved: "30000000-0000-4000-8000-000000001202",
  tenant: "00000000-0000-4000-8000-000000001201",
} as const;

interface QueryCounter {
  readonly statements: string[];
  total: number;
}

let migrationPool: Pool;
let pool: Pool;

function context(actorPrincipalId: string, correlationId: string): OperationContext {
  return { actorPrincipalId, correlationId, tenantId: ids.tenant };
}

function countQueries(targetPool: Pool, counter: QueryCounter): Pool {
  return new Proxy(targetPool, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") {
                return (...args: Parameters<PoolClient["query"]>) => {
                  counter.total += 1;
                  if (typeof args[0] === "string") counter.statements.push(args[0]);
                  return clientTarget.query(...args);
                };
              }
              return Reflect.get(clientTarget, clientProperty, clientReceiver);
            },
          });
        };
      }
      if (property === "query") {
        return (...args: Parameters<Pool["query"]>) => {
          counter.total += 1;
          if (typeof args[0] === "string") counter.statements.push(args[0]);
          return target.query(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Pool;
}

async function seedTenantRow(
  client: PoolClient,
  query: string,
  values: readonly unknown[],
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
    await client.query(query, [...values]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function activateLeaveService(): Promise<void> {
  await withTenantTransaction(
    pool,
    context(ids.admin, ids.correlationActivate),
    async (transaction) => {
      const authorization = evaluatePolicy(
        {
          actionKey: "platform.service_activation.activate",
          input: { serviceKey: "hr.leave_request" },
          resourceKey: "hr.leave_request",
          transaction,
        },
        [
          {
            effect: "allow",
            id: "tenant_admin_activate_service",
            matches: (_input, actor) => actor.roleKey === "tenant_admin",
          },
        ],
      );
      await setServiceActivation(transaction, {
        authorization,
        evidenceEventType: "evidence.hr.leave_service.activated",
        expectedVersion: null,
        outboxEventType: "hr.leave_service.activated",
        preflight: async () => ({ current: true, reasons: [] }),
        serviceKey: "hr.leave_request",
        targetState: "active",
      });
    },
  );
}

async function createPools(): Promise<void> {
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
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(`GRANT SELECT, INSERT ON tenants, principals TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
     ON memberships, service_activations, tenant_settings, work_items,
        outbox_events, hr_leave_requests
     TO ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);

  pool = createDatabasePool(connectionString, { max: 6 });
}

beforeAll(async () => {
  await createPools();
  await pool.query(`INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Proof Tenant')`, [
    ids.tenant,
  ]);
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Proof Admin'), ($2, 'Proof Manager'), ($3, 'Proof Employee')`,
    [ids.admin, ids.manager, ids.employee],
  );

  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'tenant_admin', NULL),
              ($4, $2, $5, 'manager', NULL),
              ($6, $2, $7, 'employee', $5)`,
      [
        ids.membershipAdmin,
        ids.tenant,
        ids.admin,
        ids.membershipManager,
        ids.manager,
        ids.membershipEmployee,
        ids.employee,
      ],
    );
  } finally {
    client.release();
  }
  await activateLeaveService();
});

afterAll(async () => {
  await pool.end();
  await migrationPool.end();
});

describe("HR Leave Request vertical proof closure", () => {
  it("proves submit, assigned work, rejection policy, evidence, and restart persistence", async () => {
    const submitted = await submitLeaveRequest(pool, context(ids.employee, ids.correlationSubmit), {
      categoryCode: "annual",
      endDate: "2026-07-22",
      idempotencyKey: "80000000-0000-4000-8000-000000001201",
      leaveRequestId: ids.request,
      reason: "Family coverage",
      startDate: "2026-07-21",
    });
    expect(submitted.replayed).toBe(false);
    expect(submitted.request).toMatchObject({ status: "submitted", version: 1 });

    const assigned = await listAssignedLeaveRequests(
      pool,
      context(ids.manager, ids.correlationSubmit),
    );
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      employeeDisplayName: "Proof Employee",
      leaveRequestId: ids.request,
      version: 1,
    });

    await expect(
      rejectLeaveRequest(pool, context(ids.manager, ids.correlationReject), {
        expectedVersion: 1,
        leaveRequestId: ids.request,
      }),
    ).rejects.toMatchObject({ code: "LEAVE_INPUT_INVALID" });

    const rejected = await rejectLeaveRequest(pool, context(ids.manager, ids.correlationReject), {
      decisionNote: "Coverage unavailable",
      expectedVersion: 1,
      leaveRequestId: ids.request,
    });
    expect(rejected.replayed).toBe(false);
    expect(rejected.request).toMatchObject({
      decisionNote: "Coverage unavailable",
      status: "rejected",
      version: 2,
    });

    const retry = await rejectLeaveRequest(pool, context(ids.manager, ids.correlationReject), {
      decisionNote: "Coverage unavailable",
      expectedVersion: 1,
      leaveRequestId: ids.request,
    });
    expect(retry.replayed).toBe(true);
    expect(retry.request.leaveRequestId).toBe(ids.request);

    await expect(
      rejectLeaveRequest(pool, context(ids.manager, ids.correlationRejectRetry), {
        decisionNote: "Different note",
        expectedVersion: 2,
        leaveRequestId: ids.request,
      }),
    ).rejects.toMatchObject({ code: "LEAVE_STATE_CONFLICT" });

    const evidence = await listLeaveEvidence(
      pool,
      context(ids.manager, ids.correlationReject),
      ids.request,
    );
    expect(evidence.map((event) => event.eventType)).toEqual([
      "evidence.hr.leave_request.submitted",
      "evidence.hr.leave_request.rejected",
    ]);

    const workItem = await withTenantTransaction(
      pool,
      context(ids.manager, ids.correlationReject),
      async ({ client }) =>
        await client.query<{ status: string }>(
          `SELECT status FROM work_items WHERE tenant_id = $1 AND subject_id = $2`,
          [ids.tenant, ids.request],
        ),
    );
    expect(workItem.rows).toEqual([{ status: "completed" }]);

    const outbox = await withTenantTransaction(
      pool,
      context(ids.manager, ids.correlationReject),
      async ({ client }) =>
        await client.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY event_type`,
          [ids.tenant, ids.request],
        ),
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual([
      "hr.leave_request.rejected",
      "hr.leave_request.submitted",
    ]);

    await pool.end();
    pool = createDatabasePool(process.env.DATABASE_URL ?? "", { max: 4 });

    const persisted = await getLeaveRequestDetail(
      pool,
      context(ids.employee, ids.correlationReject),
      ids.request,
    );
    expect(persisted?.request).toMatchObject({
      decisionNote: "Coverage unavailable",
      status: "rejected",
      version: 2,
    });
    expect(persisted?.history.map((event) => event.newState)).toEqual(["submitted", "rejected"]);
  });

  it("keeps assigned-list and evidence/detail query paths inside the proof budget", async () => {
    const approvedSubmission = await submitLeaveRequest(
      pool,
      context(ids.employee, ids.correlationApprove),
      {
        categoryCode: "sick",
        endDate: "2026-08-02",
        idempotencyKey: "80000000-0000-4000-8000-000000001205",
        leaveRequestId: ids.requestApproved,
        reason: "Medical",
        startDate: "2026-08-01",
      },
    );
    expect(approvedSubmission.request.status).toBe("submitted");
    await approveLeaveRequest(pool, context(ids.manager, ids.correlationApprove), {
      decisionNote: "Approved",
      expectedVersion: 1,
      leaveRequestId: ids.requestApproved,
    });

    const assignedCounter: QueryCounter = { statements: [], total: 0 };
    const assigned = await listAssignedLeaveRequests(
      countQueries(pool, assignedCounter),
      context(ids.manager, ids.correlationApprove),
      { pageSize: 10 },
    );
    expect(assigned.every((item) => item.leaveRequestId !== ids.requestApproved)).toBe(true);
    expect(assignedCounter.total).toBeLessThanOrEqual(9);
    expect(assignedCounter.statements.join("\n")).toContain("WITH assigned_leave");

    const detailCounter: QueryCounter = { statements: [], total: 0 };
    const detail = await getLeaveRequestDetail(
      countQueries(pool, detailCounter),
      context(ids.employee, ids.correlationApprove),
      ids.requestApproved,
    );
    expect(detail?.request.status).toBe("approved");
    expect(detailCounter.total).toBeLessThanOrEqual(11);
    expect(detailCounter.statements.join("\n")).toContain("FROM evidence_events");
  });
});
