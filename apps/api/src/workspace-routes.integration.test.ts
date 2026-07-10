import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { evaluatePolicy, setServiceActivation, withTenantTransaction } from "@esbla/platform-core";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const now = new Date("2026-07-10T12:00:00.000Z");
const secret = "esbla-development-principal-test-secret-v1";
const serviceKey = "workspace.task";

const ids = {
  adminA: "10000000-0000-4000-8000-000000000101",
  adminB: "10000000-0000-4000-8000-000000000105",
  assigneeA: "10000000-0000-4000-8000-000000000103",
  assigneeB: "10000000-0000-4000-8000-000000000107",
  correlationActivateA: "50000000-0000-4000-8000-000000000101",
  correlationActivateB: "50000000-0000-4000-8000-000000000102",
  creatorA: "10000000-0000-4000-8000-000000000102",
  creatorB: "10000000-0000-4000-8000-000000000106",
  membershipAdminA: "20000000-0000-4000-8000-000000000101",
  membershipAdminB: "20000000-0000-4000-8000-000000000105",
  membershipAssigneeA: "20000000-0000-4000-8000-000000000103",
  membershipAssigneeB: "20000000-0000-4000-8000-000000000107",
  membershipCreatorA: "20000000-0000-4000-8000-000000000102",
  membershipCreatorB: "20000000-0000-4000-8000-000000000106",
  tenantA: "00000000-0000-4000-8000-000000000101",
  tenantB: "00000000-0000-4000-8000-000000000102",
} as const;

interface SignedRequestOptions {
  readonly body?: object;
  readonly idempotencyKey?: string;
  readonly method: "GET" | "POST";
  readonly principalId: string;
  readonly requestId?: string;
  readonly tenantId: string;
  readonly url: string;
}

interface WorkspaceTaskResponse {
  readonly completedAt: string | null;
  readonly status: "completed" | "open";
  readonly taskId: string;
  readonly tenantId: string;
  readonly title: string;
  readonly version: number;
}

interface AssignedWorkspaceTaskResponse {
  readonly createdByDisplayName: string;
  readonly taskId: string;
  readonly title: string;
  readonly version: number;
  readonly workItemId: string;
}

interface WorkspaceTaskDetailResponse {
  readonly history: Array<{
    readonly eventType: string;
    readonly newState: string;
    readonly priorState: string | null;
  }>;
  readonly task: WorkspaceTaskResponse;
}

let migrationPool: Pool;
let pool: Pool;
let server: FastifyInstance;

function context(tenantId: string, actorPrincipalId: string, correlationId = randomUUID()) {
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

async function activateWorkspaceService(tenantId: string, adminPrincipalId: string): Promise<void> {
  await withTenantTransaction(pool, context(tenantId, adminPrincipalId), async (transaction) => {
    const authorization = evaluatePolicy(
      {
        actionKey: "platform.service_activation.activate",
        input: { serviceKey },
        resourceKey: serviceKey,
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
      serviceKey,
      targetState: "active",
    });
  });
}

async function signedRequest(options: SignedRequestOptions) {
  const requestId = options.requestId ?? randomUUID();
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = signDevelopmentPrincipal(secret, {
    body: options.body,
    method: options.method,
    principalId: options.principalId,
    requestId,
    tenantId: options.tenantId,
    timestamp,
    url: options.url,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  });
  const headers: Record<string, string> = {
    "x-esbla-auth-signature": signature,
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": options.principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": options.tenantId,
  };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const requestOptions: InjectOptions = {
    headers,
    method: options.method,
    url: options.url,
  };
  if (options.body !== undefined) requestOptions.payload = options.body;
  const response: LightMyRequestResponse = await server.inject(requestOptions);
  return { requestId, response };
}

async function createTask() {
  const body = {
    assigneePrincipalId: ids.assigneeA,
    description: "API route proof",
    dueOn: "2026-07-20",
    title: "Workspace API proof",
  };
  const idempotencyKey = randomUUID();
  const result = await signedRequest({
    body,
    idempotencyKey,
    method: "POST",
    principalId: ids.creatorA,
    tenantId: ids.tenantA,
    url: "/v1/workspace/tasks",
  });
  return { ...result, body, idempotencyKey };
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
        outbox_events, hr_leave_requests, workspace_tasks
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

  await activateWorkspaceService(ids.tenantA, ids.adminA);
  await activateWorkspaceService(ids.tenantB, ids.adminB);
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ clock: () => now, secret }),
    logger: false,
    pool,
  });
});

afterAll(async () => {
  if (server) await server.close();
  if (pool) await pool.end();
  if (migrationPool) await migrationPool.end();
});

describe("Workspace Task API boundary", () => {
  it("rejects non-idempotent mutation credentials", async () => {
    const response = await signedRequest({
      body: {
        assigneePrincipalId: ids.assigneeA,
        title: "Missing idempotency key",
      },
      method: "POST",
      principalId: ids.creatorA,
      tenantId: ids.tenantA,
      url: "/v1/workspace/tasks",
    });
    expect(response.response.statusCode).toBe(401);
    expect(response.response.json()).toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
  });

  it("creates idempotently and exposes assigned plus evidence-backed detail reads", async () => {
    const created = await createTask();
    expect(created.response.statusCode).toBe(201);
    expect(created.response.headers["idempotent-replayed"]).toBe("false");
    expect(created.response.headers["cache-control"]).toBe("no-store");
    const task = created.response.json<WorkspaceTaskResponse>();
    expect(task).toMatchObject({
      completedAt: null,
      status: "open",
      tenantId: ids.tenantA,
      title: "Workspace API proof",
      version: 1,
    });

    const replay = await signedRequest({
      body: created.body,
      idempotencyKey: created.idempotencyKey,
      method: "POST",
      principalId: ids.creatorA,
      tenantId: ids.tenantA,
      url: "/v1/workspace/tasks",
    });
    expect(replay.response.statusCode).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json<WorkspaceTaskResponse>().taskId).toBe(task.taskId);

    const assigned = await signedRequest({
      method: "GET",
      principalId: ids.assigneeA,
      tenantId: ids.tenantA,
      url: "/v1/workspace/tasks/assigned?pageSize=10",
    });
    expect(assigned.response.statusCode).toBe(200);
    const assignedItem = assigned.response
      .json<{ items: AssignedWorkspaceTaskResponse[] }>()
      .items.find((item) => item.taskId === task.taskId);
    expect(assignedItem).toMatchObject({
      createdByDisplayName: "Creator A",
      taskId: task.taskId,
      title: "Workspace API proof",
      version: 1,
      workItemId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });

    const detail = await signedRequest({
      method: "GET",
      principalId: ids.creatorA,
      tenantId: ids.tenantA,
      url: `/v1/workspace/tasks/${task.taskId}`,
    });
    expect(detail.response.statusCode).toBe(200);
    expect(detail.response.json<WorkspaceTaskDetailResponse>()).toMatchObject({
      history: [
        {
          eventType: "evidence.workspace.task.created",
          newState: "open",
          priorState: null,
        },
      ],
      task: {
        status: "open",
        taskId: task.taskId,
      },
    });

    const otherTenant = await signedRequest({
      method: "GET",
      principalId: ids.assigneeB,
      tenantId: ids.tenantB,
      url: `/v1/workspace/tasks/${task.taskId}`,
    });
    expect(otherTenant.response.statusCode).toBe(404);
    expect(otherTenant.response.json()).toMatchObject({
      code: "WORKSPACE_TASK_NOT_FOUND",
      status: 404,
    });
  });

  it("lets the assignee complete a task and removes it from assigned work", async () => {
    const created = await createTask();
    const task = created.response.json<WorkspaceTaskResponse>();

    const denied = await signedRequest({
      body: { completionNote: "Creator cannot close this", expectedVersion: 1 },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.creatorA,
      tenantId: ids.tenantA,
      url: `/v1/workspace/tasks/${task.taskId}/complete`,
    });
    expect(denied.response.statusCode).toBe(403);
    expect(denied.response.json()).toMatchObject({ code: "POLICY_DENIED", status: 403 });

    const completionBody = { completionNote: "Done through API", expectedVersion: 1 };
    const completionKey = randomUUID();
    const completed = await signedRequest({
      body: completionBody,
      idempotencyKey: completionKey,
      method: "POST",
      principalId: ids.assigneeA,
      tenantId: ids.tenantA,
      url: `/v1/workspace/tasks/${task.taskId}/complete`,
    });
    expect(completed.response.statusCode).toBe(200);
    expect(completed.response.headers["idempotent-replayed"]).toBe("false");
    expect(completed.response.json<WorkspaceTaskResponse>()).toMatchObject({
      completedAt: expect.any(String),
      status: "completed",
      taskId: task.taskId,
      version: 2,
    });

    const replay = await signedRequest({
      body: completionBody,
      idempotencyKey: completionKey,
      method: "POST",
      principalId: ids.assigneeA,
      tenantId: ids.tenantA,
      url: `/v1/workspace/tasks/${task.taskId}/complete`,
    });
    expect(replay.response.statusCode).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");

    const assigned = await signedRequest({
      method: "GET",
      principalId: ids.assigneeA,
      tenantId: ids.tenantA,
      url: "/v1/workspace/tasks/assigned?pageSize=10",
    });
    expect(
      assigned.response
        .json<{ items: AssignedWorkspaceTaskResponse[] }>()
        .items.map((item) => item.taskId),
    ).not.toContain(task.taskId);
  });
});
