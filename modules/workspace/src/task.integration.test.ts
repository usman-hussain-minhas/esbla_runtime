import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { evaluatePolicy, setServiceActivation, withTenantTransaction } from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  completeWorkspaceTask,
  createWorkspaceTask,
  getWorkspaceTask,
  getWorkspaceTaskDetail,
  listAssignedWorkspaceTasks,
  WORKSPACE_TASK_BILLING_STATE,
  WORKSPACE_TASK_SERVICE_KEY,
} from "./index.js";

const ids = {
  adminA: "10000000-0000-4000-8000-000000000001",
  adminB: "10000000-0000-4000-8000-000000000009",
  assigneeA: "10000000-0000-4000-8000-000000000003",
  assigneeB: "10000000-0000-4000-8000-000000000011",
  correlationActivateA: "50000000-0000-4000-8000-000000000001",
  correlationActivateB: "50000000-0000-4000-8000-000000000002",
  correlationComplete1: "50000000-0000-4000-8000-000000000011",
  correlationCompleteReplay: "50000000-0000-4000-8000-000000000011",
  correlationCreate1: "50000000-0000-4000-8000-000000000021",
  correlationCreate2: "50000000-0000-4000-8000-000000000022",
  correlationCreateB: "50000000-0000-4000-8000-000000000023",
  creatorA: "10000000-0000-4000-8000-000000000002",
  creatorB: "10000000-0000-4000-8000-000000000010",
  membershipAdminA: "20000000-0000-4000-8000-000000000001",
  membershipAdminB: "20000000-0000-4000-8000-000000000009",
  membershipAssigneeA: "20000000-0000-4000-8000-000000000003",
  membershipAssigneeB: "20000000-0000-4000-8000-000000000011",
  membershipCreatorA: "20000000-0000-4000-8000-000000000002",
  membershipCreatorB: "20000000-0000-4000-8000-000000000010",
  task1: "30000000-0000-4000-8000-000000000001",
  task2: "30000000-0000-4000-8000-000000000002",
  taskB: "30000000-0000-4000-8000-000000000003",
  tenantA: "00000000-0000-4000-8000-000000000001",
  tenantB: "00000000-0000-4000-8000-000000000002",
} as const;

let migrationPool: Pool;
let pool: Pool;

function context(tenantId: string, actorPrincipalId: string, correlationId: string) {
  return { actorPrincipalId, correlationId, tenantId };
}

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

async function activateWorkspaceService(
  tenantId: string,
  adminPrincipalId: string,
  correlationId: string,
): Promise<void> {
  await withTenantTransaction(
    pool,
    context(tenantId, adminPrincipalId, correlationId),
    async (transaction) => {
      const authorization = evaluatePolicy(
        {
          actionKey: "platform.service_activation.activate",
          input: { serviceKey: WORKSPACE_TASK_SERVICE_KEY },
          resourceKey: WORKSPACE_TASK_SERVICE_KEY,
          transaction,
        },
        [
          {
            effect: "allow",
            id: "tenant_admin_activate_workspace_task",
            matches: (_input, actor) => actor.roleKey === "tenant_admin",
          },
        ],
      );
      await setServiceActivation(transaction, {
        authorization,
        evidenceEventType: "evidence.workspace.task_service.activated",
        expectedVersion: null,
        outboxEventType: "workspace.task_service.activated",
        preflight: async () => ({ current: true, reasons: [] }),
        serviceKey: WORKSPACE_TASK_SERVICE_KEY,
        targetState: "active",
      });
    },
  );
}

async function setCompletionNoteRequired(tenantId: string, value: boolean): Promise<void> {
  await withTenantTransaction(
    pool,
    context(tenantId, ids.adminA, ids.correlationCreate2),
    async ({ client }) => {
      await client.query(
        `INSERT INTO tenant_settings (tenant_id, setting_key, value_type, value)
         VALUES ($1, 'workspace.task.completion_note_required', 'boolean', $2::jsonb)
         ON CONFLICT (tenant_id, setting_key)
         DO UPDATE SET value_type = 'boolean',
                       value = EXCLUDED.value,
                       version = tenant_settings.version + 1`,
        [tenantId, JSON.stringify(value)],
      );
    },
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
     ON memberships, service_activations, tenant_settings, work_items,
        outbox_events, workspace_tasks
     TO ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);

  pool = createDatabasePool(connectionString, { max: 8 });
  await pool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Admin A'), ($2, 'Creator A'), ($3, 'Assignee A'),
            ($4, 'Admin B'), ($5, 'Creator B'), ($6, 'Assignee B')`,
    [ids.adminA, ids.creatorA, ids.assigneeA, ids.adminB, ids.creatorB, ids.assigneeB],
  );

  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'tenant_admin'),
              ($4, $2, $5, 'employee'),
              ($6, $2, $7, 'employee')`,
      [
        ids.membershipAdminA,
        ids.tenantA,
        ids.adminA,
        ids.membershipCreatorA,
        ids.creatorA,
        ids.membershipAssigneeA,
        ids.assigneeA,
      ],
    );
    await seedTenantRow(
      client,
      ids.tenantB,
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'tenant_admin'),
              ($4, $2, $5, 'employee'),
              ($6, $2, $7, 'employee')`,
      [
        ids.membershipAdminB,
        ids.tenantB,
        ids.adminB,
        ids.membershipCreatorB,
        ids.creatorB,
        ids.membershipAssigneeB,
        ids.assigneeB,
      ],
    );
  } finally {
    client.release();
  }
  await activateWorkspaceService(ids.tenantA, ids.adminA, ids.correlationActivateA);
  await activateWorkspaceService(ids.tenantB, ids.adminB, ids.correlationActivateB);
});

afterAll(async () => {
  await pool.end();
  await migrationPool.end();
});

describe("Workspace Task domain", () => {
  it("applies schema with forced RLS, partial assigned index, and terminal-state guards", async () => {
    const migrations = await migrationPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
    );
    expect(migrations.rows[0]?.count).toBe("5");

    const table = await migrationPool.query<{
      force_row_security: boolean;
      row_security: boolean;
    }>(
      `SELECT c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'workspace_tasks'`,
    );
    expect(table.rows).toEqual([{ force_row_security: true, row_security: true }]);

    const indexes = await migrationPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'workspace_tasks'
       ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "workspace_tasks_assignee_open_idx",
        "workspace_tasks_pkey",
        "workspace_tasks_tenant_creator_idempotency_uq",
        "workspace_tasks_tenant_task_id_uq",
      ]),
    );

    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.creatorA, ids.correlationCreate1),
        async ({ client }) =>
          await client.query(
            `INSERT INTO workspace_tasks
               (task_id, tenant_id, created_by_principal_id, assignee_principal_id,
                title, status, completed_at, idempotency_key, correlation_id)
             VALUES ($1, $2, $3, $4, 'Illegal completed insert', 'completed',
                     now(), 'bad-terminal-insert', $5)`,
            [ids.task2, ids.tenantA, ids.creatorA, ids.assigneeA, ids.correlationCreate1],
          ),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.creatorA, ids.correlationCreate1),
        async ({ client }) =>
          await client.query(
            `INSERT INTO workspace_tasks
               (task_id, tenant_id, created_by_principal_id, assignee_principal_id,
                title, idempotency_key, correlation_id)
             VALUES ($1, $2, $3, $4, 'Cross tenant probe', 'cross-tenant-probe', $5)`,
            [ids.taskB, ids.tenantB, ids.creatorB, ids.assigneeB, ids.correlationCreate1],
          ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("creates a non-billable assigned task with evidence, worklist, idempotency, and tenant isolation", async () => {
    const created = await createWorkspaceTask(
      pool,
      context(ids.tenantA, ids.creatorA, ids.correlationCreate1),
      {
        assigneePrincipalId: ids.assigneeA,
        description: "Prepare the Workspace Task passenger proof",
        dueOn: "2026-07-20",
        idempotencyKey: "workspace-task-create-1",
        taskId: ids.task1,
        title: "Prepare Workspace proof",
      },
    );

    expect(created.replayed).toBe(false);
    expect(created.billingState).toBe(WORKSPACE_TASK_BILLING_STATE);
    expect(created.task).toMatchObject({
      assigneePrincipalId: ids.assigneeA,
      createdByPrincipalId: ids.creatorA,
      status: "open",
      taskId: ids.task1,
      tenantId: ids.tenantA,
      title: "Prepare Workspace proof",
      version: 1,
    });

    const replay = await createWorkspaceTask(
      pool,
      context(ids.tenantA, ids.creatorA, ids.correlationCreate1),
      {
        assigneePrincipalId: ids.assigneeA,
        description: "Prepare the Workspace Task passenger proof",
        dueOn: "2026-07-20",
        idempotencyKey: "workspace-task-create-1",
        taskId: ids.task1,
        title: "Prepare Workspace proof",
      },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.task.taskId).toBe(ids.task1);

    const assigned = await listAssignedWorkspaceTasks(
      pool,
      context(ids.tenantA, ids.assigneeA, ids.correlationCreate2),
    );
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({
      createdByDisplayName: "Creator A",
      taskId: ids.task1,
      title: "Prepare Workspace proof",
      version: 1,
    });

    const creatorList = await listAssignedWorkspaceTasks(
      pool,
      context(ids.tenantA, ids.creatorA, ids.correlationCreate2),
    );
    expect(creatorList).toEqual([]);

    const detail = await getWorkspaceTaskDetail(
      pool,
      context(ids.tenantA, ids.assigneeA, ids.correlationCreate2),
      ids.task1,
    );
    expect(detail?.history).toHaveLength(1);
    expect(detail?.history[0]).toMatchObject({
      eventType: "evidence.workspace.task.created",
      newState: "open",
      priorState: null,
    });

    const workItems = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.creatorA, ids.correlationCreate2),
      async ({ client }) =>
        await client.query<{ status: string; tenant_id: string }>(
          `SELECT tenant_id, status FROM work_items
           WHERE subject_type = 'workspace.task' AND subject_id = $1`,
          [ids.task1],
        ),
    );
    expect(workItems.rows).toEqual([{ status: "open", tenant_id: ids.tenantA }]);

    expect(
      await getWorkspaceTask(
        pool,
        context(ids.tenantB, ids.assigneeB, ids.correlationCreateB),
        ids.task1,
      ),
    ).toBeNull();
  });

  it("allows only the assignee to complete and records completed evidence plus closed worklist", async () => {
    await expect(
      completeWorkspaceTask(pool, context(ids.tenantA, ids.creatorA, ids.correlationComplete1), {
        completionNote: "Creator cannot close assigned work",
        expectedVersion: 1,
        taskId: ids.task1,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const completed = await completeWorkspaceTask(
      pool,
      context(ids.tenantA, ids.assigneeA, ids.correlationComplete1),
      {
        completionNote: "Workspace proof completed",
        expectedVersion: 1,
        taskId: ids.task1,
      },
    );
    expect(completed.replayed).toBe(false);
    expect(completed.billingState).toBe("non_billable");
    expect(completed.task).toMatchObject({
      completedAt: expect.any(String),
      completionNote: "Workspace proof completed",
      status: "completed",
      version: 2,
    });

    const replay = await completeWorkspaceTask(
      pool,
      context(ids.tenantA, ids.assigneeA, ids.correlationCompleteReplay),
      {
        completionNote: "Workspace proof completed",
        expectedVersion: 1,
        taskId: ids.task1,
      },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.task.status).toBe("completed");

    const assignedAfterCompletion = await listAssignedWorkspaceTasks(
      pool,
      context(ids.tenantA, ids.assigneeA, ids.correlationCreate2),
    );
    expect(assignedAfterCompletion).toEqual([]);

    const detail = await getWorkspaceTaskDetail(
      pool,
      context(ids.tenantA, ids.creatorA, ids.correlationCreate2),
      ids.task1,
    );
    expect(detail?.history.map((event) => event.eventType)).toEqual([
      "evidence.workspace.task.created",
      "evidence.workspace.task.completed",
    ]);

    const workItems = await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.creatorA, ids.correlationCreate2),
      async ({ client }) =>
        await client.query<{ status: string }>(
          `SELECT status FROM work_items
           WHERE subject_type = 'workspace.task' AND subject_id = $1`,
          [ids.task1],
        ),
    );
    expect(workItems.rows).toEqual([{ status: "completed" }]);
  });

  it("uses tenant setting to require completion notes", async () => {
    await createWorkspaceTask(pool, context(ids.tenantA, ids.creatorA, ids.correlationCreate2), {
      assigneePrincipalId: ids.assigneeA,
      idempotencyKey: "workspace-task-create-2",
      taskId: ids.task2,
      title: "Prove settings gate",
    });
    await setCompletionNoteRequired(ids.tenantA, true);

    await expect(
      completeWorkspaceTask(pool, context(ids.tenantA, ids.assigneeA, ids.correlationCreate2), {
        expectedVersion: 1,
        taskId: ids.task2,
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_TASK_INPUT_INVALID",
    });
  });
});
