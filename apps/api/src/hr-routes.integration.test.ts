import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { evaluatePolicy, setServiceActivation, withTenantTransaction } from "@esbla/platform-core";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError, createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const now = new Date("2026-07-10T12:00:00.000Z");
const secret = "esbla-development-principal-test-secret-v1";

const ids = {
  adminA: "10000000-0000-4000-8000-000000000001",
  adminB: "10000000-0000-4000-8000-000000000005",
  employeeA: "10000000-0000-4000-8000-000000000004",
  employeeB: "10000000-0000-4000-8000-000000000007",
  managerA: "10000000-0000-4000-8000-000000000002",
  managerA2: "10000000-0000-4000-8000-000000000003",
  managerB: "10000000-0000-4000-8000-000000000006",
  membershipAdminA: "20000000-0000-4000-8000-000000000001",
  membershipAdminB: "20000000-0000-4000-8000-000000000005",
  membershipEmployeeA: "20000000-0000-4000-8000-000000000004",
  membershipEmployeeB: "20000000-0000-4000-8000-000000000007",
  membershipManagerA: "20000000-0000-4000-8000-000000000002",
  membershipManagerA2: "20000000-0000-4000-8000-000000000003",
  membershipManagerB: "20000000-0000-4000-8000-000000000006",
  tenantA: "00000000-0000-4000-8000-000000000001",
  tenantB: "00000000-0000-4000-8000-000000000002",
} as const;

interface SignedRequestOptions {
  readonly body?: object;
  readonly idempotencyKey?: string;
  readonly method: "GET" | "POST";
  readonly principalId: string;
  readonly requestId?: string;
  readonly signatureOverride?: string;
  readonly targetServer?: FastifyInstance;
  readonly tenantId: string;
  readonly timestamp?: string;
  readonly url: string;
}

interface LeaveResponse {
  readonly approverPrincipalId: string;
  readonly categoryCode: string;
  readonly employeePrincipalId: string;
  readonly leaveRequestId: string;
  readonly status: string;
  readonly tenantId: string;
  readonly version: number;
}

interface AssignedLeaveResponse {
  readonly categoryCode: string;
  readonly employeeDisplayName: string;
  readonly endDate: string;
  readonly leaveRequestId: string;
  readonly reason: string | null;
  readonly startDate: string;
  readonly submittedAt: string;
  readonly version: number;
  readonly workItemId: string;
}

interface LeaveDetailResponse {
  readonly history: Array<{
    readonly eventType: string;
    readonly newState: string;
    readonly occurredAt: string;
    readonly priorState: string | null;
  }>;
  readonly request: {
    readonly categoryCode: string;
    readonly decidedAt: string | null;
    readonly decisionNote: string | null;
    readonly employeeDisplayName: string;
    readonly endDate: string;
    readonly leaveRequestId: string;
    readonly reason: string | null;
    readonly startDate: string;
    readonly status: string;
    readonly submittedAt: string;
    readonly version: number;
  };
}

interface LeavePersistenceSnapshot {
  readonly evidence: readonly Record<string, unknown>[];
  readonly outbox: readonly Record<string, unknown>[];
  readonly requests: readonly Record<string, unknown>[];
  readonly work: readonly Record<string, unknown>[];
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

async function activateLeaveService(tenantId: string, adminPrincipalId: string): Promise<void> {
  await withTenantTransaction(pool, context(tenantId, adminPrincipalId), async (transaction) => {
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
  });
}

async function signedRequest(options: SignedRequestOptions) {
  const requestId = options.requestId ?? randomUUID();
  const timestamp = options.timestamp ?? String(Math.floor(now.getTime() / 1000));
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
    "x-esbla-auth-signature": options.signatureOverride ?? signature,
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
  const response: LightMyRequestResponse = await (options.targetServer ?? server).inject(
    requestOptions,
  );
  return { requestId, response };
}

async function submitLeave(
  options: {
    readonly categoryCode?: "annual" | "other" | "sick" | "unpaid";
    readonly endDate?: string;
    readonly idempotencyKey?: string;
    readonly reason?: string;
    readonly startDate?: string;
  } = {},
) {
  const body = {
    categoryCode: options.categoryCode ?? "annual",
    endDate: options.endDate ?? "2026-07-15",
    reason: options.reason ?? "Planned leave",
    startDate: options.startDate ?? "2026-07-14",
  };
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const result = await signedRequest({
    body,
    idempotencyKey,
    method: "POST",
    principalId: ids.employeeA,
    tenantId: ids.tenantA,
    url: "/v1/hr/leave-requests",
  });
  return { ...result, body, idempotencyKey };
}

async function setManagerARole(roleKey: string): Promise<void> {
  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      `UPDATE memberships
       SET role_key = $3
       WHERE tenant_id = $1 AND principal_id = $2`,
      [ids.tenantA, ids.managerA, roleKey],
    );
  } finally {
    client.release();
  }
}

async function snapshotLeavePersistence(leaveRequestId: string): Promise<LeavePersistenceSnapshot> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
    const requests = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM hr_leave_requests
       WHERE tenant_id = $1 AND leave_request_id = $2
       ORDER BY leave_request_id`,
      [ids.tenantA, leaveRequestId],
    );
    const work = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM work_items
       WHERE tenant_id = $1 AND subject_type = 'hr.leave_request' AND subject_id = $2
       ORDER BY work_item_id`,
      [ids.tenantA, leaveRequestId],
    );
    const evidence = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM evidence_events
       WHERE tenant_id = $1 AND subject_type = 'hr.leave_request' AND subject_id = $2
       ORDER BY occurred_at, evidence_event_id`,
      [ids.tenantA, leaveRequestId],
    );
    const outbox = await client.query<Record<string, unknown>>(
      `SELECT *
       FROM outbox_events
       WHERE tenant_id = $1 AND aggregate_type = 'hr.leave_request' AND aggregate_id = $2
       ORDER BY occurred_at, event_id`,
      [ids.tenantA, leaveRequestId],
    );
    await client.query("COMMIT");
    return {
      evidence: evidence.rows,
      outbox: outbox.rows,
      requests: requests.rows,
      work: work.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function expectSubmittedPersistence(
  snapshot: LeavePersistenceSnapshot,
  leaveRequestId: string,
): void {
  expect(snapshot.requests).toHaveLength(1);
  expect(snapshot.requests[0]).toMatchObject({
    approver_principal_id: ids.managerA,
    decided_at: null,
    decision_note: null,
    leave_request_id: leaveRequestId,
    status: "submitted",
    version: 1,
  });
  expect(snapshot.work).toHaveLength(1);
  expect(snapshot.work[0]).toMatchObject({
    assignee_principal_id: ids.managerA,
    completed_at: null,
    status: "open",
    subject_id: leaveRequestId,
  });
  expect(snapshot.evidence).toHaveLength(1);
  expect(snapshot.evidence[0]).toMatchObject({
    event_type: "evidence.hr.leave_request.submitted",
    new_state: "submitted",
    subject_id: leaveRequestId,
  });
  expect(snapshot.outbox).toHaveLength(1);
  expect(snapshot.outbox[0]).toMatchObject({
    aggregate_id: leaveRequestId,
    aggregate_version: 1,
    event_type: "hr.leave_request.submitted",
  });
}

function expectTerminalPersistence(
  snapshot: LeavePersistenceSnapshot,
  leaveRequestId: string,
  status: "approved" | "rejected",
): void {
  expect(snapshot.requests).toHaveLength(1);
  expect(snapshot.requests[0]).toMatchObject({
    approver_principal_id: ids.managerA,
    leave_request_id: leaveRequestId,
    status,
    version: 2,
  });
  expect(snapshot.work).toHaveLength(1);
  expect(snapshot.work[0]).toMatchObject({
    assignee_principal_id: ids.managerA,
    status: "completed",
    subject_id: leaveRequestId,
  });
  expect(snapshot.evidence).toHaveLength(2);
  expect(snapshot.evidence.map((row) => row.event_type)).toEqual([
    "evidence.hr.leave_request.submitted",
    `evidence.hr.leave_request.${status}`,
  ]);
  expect(snapshot.outbox).toHaveLength(2);
  expect(snapshot.outbox.map((row) => row.event_type)).toEqual([
    "hr.leave_request.submitted",
    `hr.leave_request.${status}`,
  ]);
}

function expectPolicyDenied(result: Awaited<ReturnType<typeof signedRequest>>): void {
  expect(result.response.statusCode).toBe(403);
  expect(result.response.headers["content-type"]).toContain("application/problem+json");
  expect(result.response.headers["x-request-id"]).toBe(result.requestId);
  expect(result.response.headers["idempotent-replayed"]).toBeUndefined();
  const problem = result.response.json<Record<string, unknown>>();
  expect(problem).toMatchObject({
    code: "POLICY_DENIED",
    requestId: result.requestId,
    status: 403,
  });
  expect(Object.keys(problem).sort()).toEqual(
    ["code", "detail", "instance", "requestId", "status", "title", "type"].sort(),
  );
  expect(problem).not.toHaveProperty("request");
  expect(problem).not.toHaveProperty("history");
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
     ON memberships, service_activations, work_items,
        outbox_events, hr_leave_requests
     TO ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT
     ON hr_workforce_profile_service_control, membership_capabilities, tenant_settings,
        hr_workforce_status_history
     TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE ON hr_worker_profiles TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT ON hr_reporting_relationships TO ${applicationRole}`,
  );

  pool = createDatabasePool(connectionString, { max: 8 });
  await pool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Admin A'), ($2, 'Manager A'), ($3, 'Manager A2'),
            ($4, 'Employee A'), ($5, 'Admin B'), ($6, 'Manager B'), ($7, 'Employee B')`,
    [
      ids.adminA,
      ids.managerA,
      ids.managerA2,
      ids.employeeA,
      ids.adminB,
      ids.managerB,
      ids.employeeB,
    ],
  );

  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'tenant_admin', NULL),
              ($4, $2, $5, 'manager', NULL),
              ($6, $2, $7, 'manager', NULL),
              ($8, $2, $9, 'employee', $5)`,
      [
        ids.membershipAdminA,
        ids.tenantA,
        ids.adminA,
        ids.membershipManagerA,
        ids.managerA,
        ids.membershipManagerA2,
        ids.managerA2,
        ids.membershipEmployeeA,
        ids.employeeA,
      ],
    );
    await seedTenantRow(
      client,
      ids.tenantB,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'tenant_admin', NULL),
              ($4, $2, $5, 'manager', NULL),
              ($6, $2, $7, 'employee', $5)`,
      [
        ids.membershipAdminB,
        ids.tenantB,
        ids.adminB,
        ids.membershipManagerB,
        ids.managerB,
        ids.membershipEmployeeB,
        ids.employeeB,
      ],
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

  await activateLeaveService(ids.tenantA, ids.adminA);
  await activateLeaveService(ids.tenantB, ids.adminB);
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ clock: () => now, secret }),
    logger: false,
    migrationReadPool: migrationPool,
    pool,
    runtimeEnvironment: "test",
  });
});

afterAll(async () => {
  await server.close();
  await pool.end();
  await migrationPool.end();
});

describe("Runtime environment boundary", () => {
  function runMain(nodeEnvironment: string | undefined) {
    const environment = { ...process.env };
    delete environment.DATABASE_MIGRATION_URL;
    delete environment.DATABASE_URL;
    delete environment.ESBLA_DEV_AUTH_SECRET;
    if (nodeEnvironment === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = nodeEnvironment;
    return spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
  }

  it.each([
    undefined,
    "production",
    "staging",
    "unknown",
  ])("fails mode %s closed before database or development-auth startup", (nodeEnvironment) => {
    const result = runMain(nodeEnvironment);
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Production identity verifier has not been selected or configured",
    );
  });

  it.each([
    "development",
    "test",
  ])("allows exact %s mode past the identity gate", (nodeEnvironment) => {
    const result = runMain(nodeEnvironment);
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(`${result.stdout}${result.stderr}`).toContain("DATABASE_URL is required");
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "Production identity verifier has not been selected or configured",
    );
  });

  it("bounds and strips control characters from typed Problem Details", async () => {
    const problemServer = createServer({
      authenticate: () => {
        throw new AuthError("AUTH_INVALID", `unsafe\u0000\u0080\u009f${"x".repeat(512)}`);
      },
      logger: false,
      pool: {} as Pool,
    });
    try {
      const response = await problemServer.inject({ method: "GET", url: "/v1/hr/leave-requests" });
      const problem = response.json<Record<string, unknown>>();
      expect(response.statusCode).toBe(401);
      expect(String(problem.detail).length).toBeLessThanOrEqual(256);
      expect(
        [...String(problem.detail)].some((character) => {
          const codePoint = character.codePointAt(0);
          return (
            codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
          );
        }),
      ).toBe(false);
    } finally {
      await problemServer.close();
    }
  });
});

describe("HR Leave Request API boundary", () => {
  it("denies absent, tampered, expired, and non-idempotent mutation credentials", async () => {
    const missing = await server.inject({ method: "GET", url: "/v1/hr/leave-requests" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(missing.headers["content-type"]).toContain("application/problem+json");

    const tampered = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      signatureOverride: "0".repeat(64),
      tenantId: ids.tenantA,
      url: "/v1/hr/leave-requests",
    });
    expect(tampered.response.statusCode).toBe(401);
    expect(tampered.response.json()).toMatchObject({ code: "AUTH_INVALID", status: 401 });

    const expired = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      timestamp: String(Math.floor(now.getTime() / 1000) - 301),
      url: "/v1/hr/leave-requests",
    });
    expect(expired.response.statusCode).toBe(401);
    expect(expired.response.json()).toMatchObject({ code: "AUTH_EXPIRED", status: 401 });

    const noIdempotencyKey = await signedRequest({
      body: {
        categoryCode: "annual",
        endDate: "2026-07-15",
        startDate: "2026-07-14",
      },
      method: "POST",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/leave-requests",
    });
    expect(noIdempotencyKey.response.statusCode).toBe(401);
    expect(noIdempotencyKey.response.json()).toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });

    const bodyRequestId = randomUUID();
    const bodyIdempotencyKey = randomUUID();
    const bodyTimestamp = String(Math.floor(now.getTime() / 1000));
    const signedBody = {
      categoryCode: "annual",
      endDate: "2026-07-15",
      startDate: "2026-07-14",
    };
    const bodySignature = signDevelopmentPrincipal(secret, {
      body: signedBody,
      idempotencyKey: bodyIdempotencyKey,
      method: "POST",
      principalId: ids.employeeA,
      requestId: bodyRequestId,
      tenantId: ids.tenantA,
      timestamp: bodyTimestamp,
      url: "/v1/hr/leave-requests",
    });
    const changedBody = await signedRequest({
      body: { ...signedBody, categoryCode: "sick" },
      idempotencyKey: bodyIdempotencyKey,
      method: "POST",
      principalId: ids.employeeA,
      requestId: bodyRequestId,
      signatureOverride: bodySignature,
      tenantId: ids.tenantA,
      timestamp: bodyTimestamp,
      url: "/v1/hr/leave-requests",
    });
    expect(changedBody.response.statusCode).toBe(401);
    expect(changedBody.response.json()).toMatchObject({ code: "AUTH_INVALID", status: 401 });
  });

  it("rejects client-supplied tenant identity and invalid domain input", async () => {
    const injectedTenant = await signedRequest({
      body: {
        categoryCode: "annual",
        endDate: "2026-07-15",
        startDate: "2026-07-14",
        tenantId: ids.tenantB,
      },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/leave-requests",
    });
    expect(injectedTenant.response.statusCode).toBe(400);
    expect(injectedTenant.response.json()).toMatchObject({
      code: "REQUEST_VALIDATION_FAILED",
      status: 400,
    });

    const invalidDates = await signedRequest({
      body: {
        categoryCode: "annual",
        endDate: "2026-07-14",
        startDate: "2026-07-15",
      },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/leave-requests",
    });
    expect(invalidDates.response.statusCode).toBe(400);
    expect(invalidDates.response.json()).toMatchObject({
      code: "LEAVE_INPUT_INVALID",
      status: 400,
    });
    expect(invalidDates.response.headers["x-request-id"]).toBe(invalidDates.requestId);
  });

  it("submits idempotently and exposes own, assigned, and evidence-backed detail reads", async () => {
    const submitted = await submitLeave();
    expect(submitted.response.statusCode).toBe(201);
    expect(submitted.response.headers["idempotent-replayed"]).toBe("false");
    expect(submitted.response.headers["cache-control"]).toBe("no-store");
    expect(submitted.response.headers["x-content-type-options"]).toBe("nosniff");
    const request = submitted.response.json<LeaveResponse>();
    expect(request).toMatchObject({
      approverPrincipalId: ids.managerA,
      categoryCode: "annual",
      employeePrincipalId: ids.employeeA,
      status: "submitted",
      tenantId: ids.tenantA,
      version: 1,
    });

    const replay = await signedRequest({
      body: submitted.body,
      idempotencyKey: submitted.idempotencyKey,
      method: "POST",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/leave-requests",
    });
    expect(replay.response.statusCode).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json<LeaveResponse>().leaveRequestId).toBe(request.leaveRequestId);

    const own = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/leave-requests?pageSize=10",
    });
    expect(own.response.statusCode).toBe(200);
    expect(
      own.response.json<{ items: LeaveResponse[] }>().items.map((item) => item.leaveRequestId),
    ).toContain(request.leaveRequestId);

    const assigned = await signedRequest({
      method: "GET",
      principalId: ids.managerA,
      tenantId: ids.tenantA,
      url: "/v1/hr/leave-requests/assigned?pageSize=10",
    });
    expect(assigned.response.statusCode).toBe(200);
    const assignedItem = assigned.response
      .json<{ items: AssignedLeaveResponse[] }>()
      .items.find((item) => item.leaveRequestId === request.leaveRequestId);
    expect(assignedItem).toMatchObject({
      categoryCode: "annual",
      employeeDisplayName: "Employee A",
      leaveRequestId: request.leaveRequestId,
      version: 1,
      workItemId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(Object.keys(assignedItem ?? {}).sort()).toEqual(
      [
        "categoryCode",
        "employeeDisplayName",
        "endDate",
        "leaveRequestId",
        "reason",
        "startDate",
        "submittedAt",
        "version",
        "workItemId",
      ].sort(),
    );

    const detail = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${request.leaveRequestId}`,
    });
    expect(detail.response.statusCode).toBe(200);
    const detailBody = detail.response.json<LeaveDetailResponse>();
    expect(detailBody).toMatchObject({
      history: [
        {
          eventType: "evidence.hr.leave_request.submitted",
          newState: "submitted",
          priorState: null,
        },
      ],
      request: {
        employeeDisplayName: "Employee A",
        leaveRequestId: request.leaveRequestId,
        status: "submitted",
      },
    });
    expect(Object.keys(detailBody.request).sort()).toEqual(
      [
        "categoryCode",
        "decidedAt",
        "decisionNote",
        "employeeDisplayName",
        "endDate",
        "leaveRequestId",
        "reason",
        "startDate",
        "status",
        "submittedAt",
        "version",
      ].sort(),
    );
    expect(Object.keys(detailBody.history[0] ?? {}).sort()).toEqual(
      ["eventType", "newState", "occurredAt", "priorState"].sort(),
    );
  });

  it("enforces assigned-manager and tenant boundaries without leaking records", async () => {
    const submitted = await submitLeave({ categoryCode: "sick" });
    const request = submitted.response.json<LeaveResponse>();

    const wrongManager = await signedRequest({
      method: "GET",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${request.leaveRequestId}`,
    });
    expect(wrongManager.response.statusCode).toBe(403);
    expect(wrongManager.response.json()).toMatchObject({ code: "POLICY_DENIED", status: 403 });

    const otherTenant = await signedRequest({
      method: "GET",
      principalId: ids.employeeB,
      tenantId: ids.tenantB,
      url: `/v1/hr/leave-requests/${request.leaveRequestId}`,
    });
    expect(otherTenant.response.statusCode).toBe(404);
    expect(otherTenant.response.json()).toMatchObject({ code: "LEAVE_NOT_FOUND", status: 404 });
    expect(otherTenant.response.body).not.toContain(ids.tenantA);
    expect(otherTenant.response.body).not.toContain("stack");
  });

  it("denies a demoted assigned manager direct detail without persistence changes", async () => {
    const submitted = await submitLeave({ categoryCode: "annual", reason: "Detail denial" });
    expect(submitted.response.statusCode).toBe(201);
    const request = submitted.response.json<LeaveResponse>();
    expect(request.approverPrincipalId).toBe(ids.managerA);
    const baseline = await snapshotLeavePersistence(request.leaveRequestId);
    expectSubmittedPersistence(baseline, request.leaveRequestId);

    try {
      await setManagerARole("employee");
      const detail = await signedRequest({
        method: "GET",
        principalId: ids.managerA,
        tenantId: ids.tenantA,
        url: `/v1/hr/leave-requests/${request.leaveRequestId}`,
      });
      expectPolicyDenied(detail);
      expect(await snapshotLeavePersistence(request.leaveRequestId)).toEqual(baseline);
    } finally {
      await setManagerARole("manager");
    }
  });

  it("denies a demoted assigned manager approval without persistence changes", async () => {
    const submitted = await submitLeave({ categoryCode: "other", reason: "Approval denial" });
    expect(submitted.response.statusCode).toBe(201);
    const request = submitted.response.json<LeaveResponse>();
    expect(request.approverPrincipalId).toBe(ids.managerA);
    const baseline = await snapshotLeavePersistence(request.leaveRequestId);
    expectSubmittedPersistence(baseline, request.leaveRequestId);

    try {
      await setManagerARole("employee");
      const approval = await signedRequest({
        body: { decisionNote: "Should be denied", expectedVersion: 1 },
        idempotencyKey: randomUUID(),
        method: "POST",
        principalId: ids.managerA,
        tenantId: ids.tenantA,
        url: `/v1/hr/leave-requests/${request.leaveRequestId}/approve`,
      });
      expectPolicyDenied(approval);
      expect(await snapshotLeavePersistence(request.leaveRequestId)).toEqual(baseline);
    } finally {
      await setManagerARole("manager");
    }
  });

  it("denies a demoted assigned manager rejection without persistence changes", async () => {
    const submitted = await submitLeave({ categoryCode: "sick", reason: "Rejection denial" });
    expect(submitted.response.statusCode).toBe(201);
    const request = submitted.response.json<LeaveResponse>();
    expect(request.approverPrincipalId).toBe(ids.managerA);
    const baseline = await snapshotLeavePersistence(request.leaveRequestId);
    expectSubmittedPersistence(baseline, request.leaveRequestId);

    try {
      await setManagerARole("employee");
      const rejection = await signedRequest({
        body: { decisionNote: "Required valid rejection note", expectedVersion: 1 },
        idempotencyKey: randomUUID(),
        method: "POST",
        principalId: ids.managerA,
        tenantId: ids.tenantA,
        url: `/v1/hr/leave-requests/${request.leaveRequestId}/reject`,
      });
      expectPolicyDenied(rejection);
      expect(await snapshotLeavePersistence(request.leaveRequestId)).toEqual(baseline);
    } finally {
      await setManagerARole("manager");
    }
  });

  it("denies a demoted assigned manager terminal approval replay", async () => {
    const submitted = await submitLeave({ categoryCode: "unpaid", reason: "Approval replay" });
    expect(submitted.response.statusCode).toBe(201);
    const request = submitted.response.json<LeaveResponse>();
    expect(request.approverPrincipalId).toBe(ids.managerA);
    const body = { decisionNote: "Approved before demotion", expectedVersion: 1 };
    const idempotencyKey = randomUUID();
    const initialDecision = await signedRequest({
      body,
      idempotencyKey,
      method: "POST",
      principalId: ids.managerA,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${request.leaveRequestId}/approve`,
    });
    expect(initialDecision.response.statusCode).toBe(200);
    expect(initialDecision.response.headers["idempotent-replayed"]).toBe("false");
    const baseline = await snapshotLeavePersistence(request.leaveRequestId);
    expectTerminalPersistence(baseline, request.leaveRequestId, "approved");

    try {
      await setManagerARole("employee");
      const replay = await signedRequest({
        body,
        idempotencyKey,
        method: "POST",
        principalId: ids.managerA,
        tenantId: ids.tenantA,
        url: `/v1/hr/leave-requests/${request.leaveRequestId}/approve`,
      });
      expectPolicyDenied(replay);
      expect(await snapshotLeavePersistence(request.leaveRequestId)).toEqual(baseline);
    } finally {
      await setManagerARole("manager");
    }
  });

  it("denies a demoted assigned manager terminal rejection replay", async () => {
    const submitted = await submitLeave({ categoryCode: "sick", reason: "Rejection replay" });
    expect(submitted.response.statusCode).toBe(201);
    const request = submitted.response.json<LeaveResponse>();
    expect(request.approverPrincipalId).toBe(ids.managerA);
    const body = { decisionNote: "Rejected before demotion", expectedVersion: 1 };
    const idempotencyKey = randomUUID();
    const initialDecision = await signedRequest({
      body,
      idempotencyKey,
      method: "POST",
      principalId: ids.managerA,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${request.leaveRequestId}/reject`,
    });
    expect(initialDecision.response.statusCode).toBe(200);
    expect(initialDecision.response.headers["idempotent-replayed"]).toBe("false");
    const baseline = await snapshotLeavePersistence(request.leaveRequestId);
    expectTerminalPersistence(baseline, request.leaveRequestId, "rejected");

    try {
      await setManagerARole("employee");
      const replay = await signedRequest({
        body,
        idempotencyKey,
        method: "POST",
        principalId: ids.managerA,
        tenantId: ids.tenantA,
        url: `/v1/hr/leave-requests/${request.leaveRequestId}/reject`,
      });
      expectPolicyDenied(replay);
      expect(await snapshotLeavePersistence(request.leaveRequestId)).toEqual(baseline);
    } finally {
      await setManagerARole("manager");
    }
  });

  it("approves and rejects through versioned, idempotent decision routes", async () => {
    const approvalSubmission = await submitLeave({ categoryCode: "other" });
    const approvalRequest = approvalSubmission.response.json<LeaveResponse>();
    const approvalKey = randomUUID();
    const approvalBody = { decisionNote: "Approved", expectedVersion: 1 };
    const approved = await signedRequest({
      body: approvalBody,
      idempotencyKey: approvalKey,
      method: "POST",
      principalId: ids.managerA,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${approvalRequest.leaveRequestId}/approve`,
    });
    expect(approved.response.statusCode).toBe(200);
    expect(approved.response.headers["idempotent-replayed"]).toBe("false");
    expect(approved.response.json<LeaveResponse>()).toMatchObject({
      status: "approved",
      version: 2,
    });

    const approvalReplay = await signedRequest({
      body: approvalBody,
      idempotencyKey: approvalKey,
      method: "POST",
      principalId: ids.managerA,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${approvalRequest.leaveRequestId}/approve`,
    });
    expect(approvalReplay.response.statusCode).toBe(200);
    expect(approvalReplay.response.headers["idempotent-replayed"]).toBe("true");

    const rejectionSubmission = await submitLeave({ categoryCode: "unpaid" });
    const rejectionRequest = rejectionSubmission.response.json<LeaveResponse>();
    const rejected = await signedRequest({
      body: { decisionNote: "Coverage unavailable", expectedVersion: 1 },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.managerA,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${rejectionRequest.leaveRequestId}/reject`,
    });
    expect(rejected.response.statusCode).toBe(200);
    expect(rejected.response.json<LeaveResponse>()).toMatchObject({
      status: "rejected",
      version: 2,
    });

    const detail = await signedRequest({
      method: "GET",
      principalId: ids.managerA,
      tenantId: ids.tenantA,
      url: `/v1/hr/leave-requests/${approvalRequest.leaveRequestId}`,
    });
    expect(detail.response.statusCode).toBe(200);
    expect(
      detail.response
        .json<{ history: { eventType: string }[] }>()
        .history.map((event) => event.eventType),
    ).toEqual(["evidence.hr.leave_request.submitted", "evidence.hr.leave_request.approved"]);
  });
});

describe("Workforce Profile service-control API boundary", () => {
  const url = "/v1/hr/workforce-profiles/service-control";

  it("enforces strict input and current tenant-admin authority before exact replay", async () => {
    const strictQuery = await signedRequest({
      method: "GET",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}?unexpected=true`,
    });
    expect(strictQuery.response.statusCode).toBe(400);
    expect(strictQuery.response.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED" });

    const denied = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url,
    });
    expectPolicyDenied(denied);
    const absent = await signedRequest({
      method: "GET",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url,
    });
    expect(absent.response.statusCode).toBe(404);
    expect(absent.response.json()).toMatchObject({
      code: "WORKFORCE_SERVICE_CONTROL_NOT_FOUND",
    });

    const invalidBody = { expectedVersion: "1" };
    const invalid = await signedRequest({
      body: invalidBody,
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}/activate`,
    });
    expect(invalid.response.statusCode).toBe(400);
    expect(invalid.response.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED" });

    const body = { expectedVersion: null };
    const idempotencyKey = randomUUID();
    const deniedMutation = await signedRequest({
      body,
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: `${url}/activate`,
    });
    expectPolicyDenied(deniedMutation);
    const authorityClient = await migrationPool.connect();
    try {
      await seedTenantRow(
        authorityClient,
        ids.tenantA,
        `DELETE FROM membership_capabilities
         WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = $3`,
        [ids.tenantA, ids.adminA, "hr.workforce.activate_service"],
      );
      expectPolicyDenied(
        await signedRequest({
          body,
          idempotencyKey: randomUUID(),
          method: "POST",
          principalId: ids.adminA,
          tenantId: ids.tenantA,
          url: `${url}/activate`,
        }),
      );
    } finally {
      await seedTenantRow(
        authorityClient,
        ids.tenantA,
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, $3)`,
        [ids.tenantA, ids.adminA, "hr.workforce.activate_service"],
      );
      authorityClient.release();
    }
    const activated = await signedRequest({
      body,
      idempotencyKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}/activate`,
    });
    expect(activated.response.statusCode).toBe(200);
    expect(activated.response.headers["idempotent-replayed"]).toBe("false");
    expect(activated.response.json()).toMatchObject({
      activationState: "active",
      activationVersion: 1,
      serviceKey: "workforce_profile",
      settingsVersion: 1,
      updatedAt: expect.any(String),
      version: 1,
    });
    const replay = await signedRequest({
      body,
      idempotencyKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}/activate`,
    });
    expect(replay.response.statusCode).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(activated.response.json());

    const activeView = await signedRequest({
      method: "GET",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url,
    });
    expect(activeView.response.statusCode).toBe(200);
    expect(activeView.response.json()).toEqual(activated.response.json());

    const conflict = await signedRequest({
      body,
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}/activate`,
    });
    expect(conflict.response.statusCode).toBe(409);
    expect(conflict.response.json()).toMatchObject({ code: "ACTIVATION_CONFLICT", status: 409 });

    const invalidDeactivate = await signedRequest({
      body: { expectedVersion: null },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}/deactivate`,
    });
    expect(invalidDeactivate.response.statusCode).toBe(400);
    expect(invalidDeactivate.response.json()).toMatchObject({
      code: "REQUEST_VALIDATION_FAILED",
      status: 400,
    });

    const deactivateBody = { expectedVersion: 1 };
    const deactivateKey = randomUUID();
    const deactivated = await signedRequest({
      body: deactivateBody,
      idempotencyKey: deactivateKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}/deactivate`,
    });
    expect(deactivated.response.statusCode).toBe(200);
    expect(deactivated.response.headers["idempotent-replayed"]).toBe("false");
    expect(deactivated.response.json()).toMatchObject({
      activationState: "inactive",
      activationVersion: 2,
      serviceKey: "workforce_profile",
      settingsVersion: 1,
      version: 2,
    });
    const deactivateReplay = await signedRequest({
      body: deactivateBody,
      idempotencyKey: deactivateKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: `${url}/deactivate`,
    });
    expect(deactivateReplay.response.statusCode).toBe(200);
    expect(deactivateReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(deactivateReplay.response.json()).toEqual(deactivated.response.json());

    const productionServer = createServer({
      authenticate: createDevelopmentAuthenticator({ clock: () => now, secret }),
      logger: false,
      migrationReadPool: migrationPool,
      pool,
      runtimeEnvironment: "production",
    });
    try {
      const sensitiveQuery = `private=${"secret".repeat(100)}`;
      const dependencyBlocked = await signedRequest({
        body: { expectedVersion: 2 },
        idempotencyKey: randomUUID(),
        method: "POST",
        principalId: ids.adminA,
        targetServer: productionServer,
        tenantId: ids.tenantA,
        url: `${url}/activate?${sensitiveQuery}`,
      });
      expect(dependencyBlocked.response.statusCode).toBe(503);
      const problem = dependencyBlocked.response.json<Record<string, unknown>>();
      expect(problem).toMatchObject({ code: "ACTIVATION_DEPENDENCY_BLOCKED", status: 503 });
      expect(Object.keys(problem).sort()).toEqual(
        ["code", "detail", "instance", "requestId", "status", "title", "type"].sort(),
      );
      expect(problem).not.toHaveProperty("reasons");
      expect(problem).not.toHaveProperty("details");
      expect(problem.instance).toBe("/v1/hr/workforce-profiles/service-control/activate");
      expect(dependencyBlocked.response.body).not.toContain("secret");
      for (const value of Object.values(problem)) {
        if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(256);
      }
    } finally {
      await productionServer.close();
    }
    const inactiveView = await signedRequest({
      method: "GET",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url,
    });
    expect(inactiveView.response.statusCode).toBe(200);
    expect(inactiveView.response.json()).toEqual(deactivated.response.json());
  });
});

describe("Workforce Profile onboarding API boundary", () => {
  it("creates a privacy-minimized draft through current HR-operator authority", async () => {
    const activated = await signedRequest({
      body: { expectedVersion: 2 },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/service-control/activate",
    });
    expect(activated.response.statusCode).toBe(200);

    const authorityClient = await migrationPool.connect();
    try {
      await seedTenantRow(
        authorityClient,
        ids.tenantA,
        `UPDATE memberships
         SET role_key = 'hr_operator'
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenantA, ids.managerA2],
      );
      await seedTenantRow(
        authorityClient,
        ids.tenantA,
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1, authority.principal_id, authority.capability_id
         FROM unnest($2::uuid[], $3::text[])
              AS authority(principal_id, capability_id)`,
        [
          ids.tenantA,
          [ids.managerA2, ids.managerA2, ids.managerA2, ids.employeeA],
          [
            "hr.workforce.create_profile",
            "hr.workforce.link_principal",
            "hr.workforce.change_status",
            "hr.workforce.view_own",
          ],
        ],
      );
    } finally {
      authorityClient.release();
    }

    const idempotencyKey = randomUUID();
    const requestId = randomUUID();
    const created = await signedRequest({
      body: { employeeNumber: " EMP-API-001 " },
      idempotencyKey,
      method: "POST",
      principalId: ids.managerA2,
      requestId,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(created.response.statusCode).toBe(201);
    expect(created.response.headers["idempotent-replayed"]).toBe("false");
    expect(created.response.json()).toEqual({
      employeeNumber: " EMP-API-001 ",
      principalLinked: false,
      version: 1,
      workerProfileId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      workforceStatus: "draft",
    });

    const profile = created.response.json<{
      employeeNumber: string;
      principalLinked: boolean;
      version: number;
      workerProfileId: string;
      workforceStatus: string;
    }>();
    const replay = await signedRequest({
      body: { employeeNumber: " EMP-API-001 " },
      idempotencyKey,
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(replay.response.statusCode).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(profile);

    const conflict = await signedRequest({
      body: { employeeNumber: "EMP-DIFFERENT" },
      idempotencyKey,
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(conflict.response.statusCode).toBe(409);
    expect(conflict.response.headers["idempotent-replayed"]).toBeUndefined();
    expect(conflict.response.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });

    const denied = await signedRequest({
      body: { employeeNumber: "EMP-DENIED" },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expectPolicyDenied(denied);
    const invalidCreate = await signedRequest({
      body: { employeeNumber: 1 },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(invalidCreate.response.statusCode).toBe(400);
    expect(invalidCreate.response.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED" });
    const blankCreate = await signedRequest({
      body: { employeeNumber: "" },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(blankCreate.response.statusCode).toBe(400);
    expect(blankCreate.response.json()).toMatchObject({ code: "WORKFORCE_INPUT_INVALID" });

    const linked = await signedRequest({
      body: { expectedVersion: 1, principalId: ids.employeeA },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${profile.workerProfileId}/principal-link`,
    });
    expect(linked.response.statusCode).toBe(200);
    expect(linked.response.json()).toMatchObject({ principalLinked: true, version: 2 });
    const statusKey = randomUUID();
    const statusBody = { expectedVersion: 2, status: "active" };
    const active = await signedRequest({
      body: statusBody,
      idempotencyKey: statusKey,
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${profile.workerProfileId}/status`,
    });
    expect(active.response.statusCode).toBe(200);
    expect(active.response.json()).toMatchObject({ version: 3, workforceStatus: "active" });
    const statusReplay = await signedRequest({
      body: statusBody,
      idempotencyKey: statusKey,
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${profile.workerProfileId}/status`,
    });
    expect(statusReplay.response.statusCode).toBe(200);
    expect(statusReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(statusReplay.response.json()).toEqual(active.response.json());

    const own = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expect(own.response.statusCode).toBe(200);
    expect(own.response.headers["idempotent-replayed"]).toBeUndefined();
    expect(own.response.json()).toEqual(active.response.json());
    const invalidOwn = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own?tenantId=private",
    });
    expect(invalidOwn.response.statusCode).toBe(400);

    const second = await signedRequest({
      body: { employeeNumber: null },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(second.response.statusCode, second.response.body).toBe(201);
    const secondId = second.response.json<{ workerProfileId: string }>().workerProfileId;
    const ineligible = await signedRequest({
      body: { expectedVersion: 1, principalId: ids.managerB },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${secondId}/principal-link`,
    });
    expect(ineligible.response.statusCode).toBe(422);
    expect(ineligible.response.json()).toMatchObject({
      code: "WORKFORCE_PRINCIPAL_INELIGIBLE",
      status: 422,
    });
    const missing = await signedRequest({
      body: { expectedVersion: 1, principalId: ids.employeeA },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.managerA2,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${randomUUID()}/principal-link`,
    });
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.json()).toMatchObject({ code: "WORKFORCE_PROFILE_NOT_FOUND" });

    const deactivated = await signedRequest({
      body: { expectedVersion: 3 },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/service-control/deactivate",
    });
    expect(deactivated.response.statusCode).toBe(200);
    const inactive = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expect(inactive.response.statusCode).toBe(503);
    expect(inactive.response.json()).toMatchObject({
      code: "WORKFORCE_SERVICE_INACTIVE",
      status: 503,
    });
  });
});
