import { randomUUID } from "node:crypto";
import type { HrWorkforceProfile, HrWorkforceServiceControl } from "@esbla/contracts";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { evaluatePolicy, setServiceActivation, withTenantTransaction } from "@esbla/platform-core";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
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
  operatorA: "10000000-0000-4000-8000-000000000008",
  membershipAdminA: "20000000-0000-4000-8000-000000000001",
  membershipAdminB: "20000000-0000-4000-8000-000000000005",
  membershipEmployeeA: "20000000-0000-4000-8000-000000000004",
  membershipEmployeeB: "20000000-0000-4000-8000-000000000007",
  membershipManagerA: "20000000-0000-4000-8000-000000000002",
  membershipManagerA2: "20000000-0000-4000-8000-000000000003",
  membershipManagerB: "20000000-0000-4000-8000-000000000006",
  membershipOperatorA: "20000000-0000-4000-8000-000000000008",
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

interface WorkforcePersistenceSnapshot {
  readonly evidence: readonly Record<string, unknown>[];
  readonly outbox: readonly Record<string, unknown>[];
  readonly profiles: readonly Record<string, unknown>[];
  readonly statusHistory: readonly Record<string, unknown>[];
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
  const response: LightMyRequestResponse = await server.inject(requestOptions);
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

async function setMembership(
  principalId: string,
  changes: { readonly roleKey?: string; readonly status?: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      `UPDATE memberships
       SET role_key = COALESCE($3, role_key), status = COALESCE($4, status)
       WHERE tenant_id = $1 AND principal_id = $2`,
      [ids.tenantA, principalId, changes.roleKey ?? null, changes.status ?? null],
    );
  } finally {
    client.release();
  }
}

async function snapshotWorkforcePersistence(
  workerProfileId: string,
): Promise<WorkforcePersistenceSnapshot> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
    const profiles = await client.query<Record<string, unknown>>(
      `SELECT * FROM hr_worker_profiles
       WHERE tenant_id = $1 AND worker_profile_id = $2
       ORDER BY worker_profile_id`,
      [ids.tenantA, workerProfileId],
    );
    const statusHistory = await client.query<Record<string, unknown>>(
      `SELECT * FROM hr_workforce_status_history
       WHERE tenant_id = $1 AND worker_profile_id = $2
       ORDER BY effective_at, workforce_status_history_id`,
      [ids.tenantA, workerProfileId],
    );
    const evidence = await client.query<Record<string, unknown>>(
      `SELECT * FROM evidence_events
       WHERE tenant_id = $1 AND subject_type = 'hr.workforce_profile' AND subject_id = $2
       ORDER BY occurred_at, evidence_event_id`,
      [ids.tenantA, workerProfileId],
    );
    const outbox = await client.query<Record<string, unknown>>(
      `SELECT * FROM outbox_events
       WHERE tenant_id = $1 AND aggregate_type = 'hr.workforce_profile'
         AND aggregate_id = $2
       ORDER BY aggregate_version, event_id`,
      [ids.tenantA, workerProfileId],
    );
    await client.query("COMMIT");
    return {
      evidence: evidence.rows,
      outbox: outbox.rows,
      profiles: profiles.rows,
      statusHistory: statusHistory.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
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

function expectProblem(
  result: Awaited<ReturnType<typeof signedRequest>>,
  status: number,
  code: string,
): void {
  expect(result.response.statusCode).toBe(status);
  expect(result.response.headers["content-type"]).toContain("application/problem+json");
  expect(result.response.headers["x-request-id"]).toBe(result.requestId);
  expect(result.response.headers["idempotent-replayed"]).toBeUndefined();
  expect(result.response.json()).toEqual({
    code,
    detail: expect.any(String),
    instance: expect.any(String),
    requestId: result.requestId,
    status,
    title: expect.any(String),
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  });
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
        outbox_events, hr_leave_requests
     TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE
     ON hr_worker_profiles, hr_workforce_profile_service_control
     TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT
     ON evidence_events, hr_workforce_status_history
     TO ${applicationRole}`,
  );

  pool = createDatabasePool(connectionString, { max: 8 });
  await pool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Admin A'), ($2, 'Manager A'), ($3, 'Manager A2'),
            ($4, 'Employee A'), ($5, 'Admin B'), ($6, 'Manager B'),
            ($7, 'Employee B'), ($8, 'HR Operator A')`,
    [
      ids.adminA,
      ids.managerA,
      ids.managerA2,
      ids.employeeA,
      ids.adminB,
      ids.managerB,
      ids.employeeB,
      ids.operatorA,
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
              ($8, $2, $9, 'employee', $5),
              ($10, $2, $11, 'hr_operator', NULL)`,
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
        ids.membershipOperatorA,
        ids.operatorA,
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

  await activateLeaveService(ids.tenantA, ids.adminA);
  await activateLeaveService(ids.tenantB, ids.adminB);
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ clock: () => now, secret }),
    logger: false,
    migrationReadPool: migrationPool,
    pool,
  });
});

afterAll(async () => {
  await server.close();
  await pool.end();
  await migrationPool.end();
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

describe("HR Workforce Profile API boundary", () => {
  it("enforces inactive, operator, self-service, replay, CAS, and tenant boundaries", async () => {
    const inactiveOwn = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expectProblem(inactiveOwn, 503, "WORKFORCE_PROFILE_SERVICE_INACTIVE");

    const activationKey = randomUUID();
    const activationBody = { expectedVersion: null };
    const activated = await signedRequest({
      body: activationBody,
      idempotencyKey: activationKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/service-control/activate",
    });
    expect(activated.response.statusCode, activated.response.body).toBe(200);
    expect(activated.response.headers["idempotent-replayed"]).toBe("false");
    const activeControl = activated.response.json<HrWorkforceServiceControl>();
    expect(Object.keys(activeControl).sort()).toEqual(
      [
        "activationState",
        "activationVersion",
        "serviceKey",
        "settingsVersion",
        "updatedAt",
        "version",
      ].sort(),
    );
    expect(activeControl).toMatchObject({
      activationState: "active",
      activationVersion: 1,
      serviceKey: "workforce_profile",
    });

    const activationReplay = await signedRequest({
      body: activationBody,
      idempotencyKey: activationKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/service-control/activate",
    });
    expect(activationReplay.response.statusCode).toBe(200);
    expect(activationReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(activationReplay.response.json()).toEqual(activeControl);

    const control = await signedRequest({
      method: "GET",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/service-control",
    });
    expect(control.response.statusCode).toBe(200);
    expect(control.response.json()).toEqual(activeControl);

    const adminCreate = await signedRequest({
      body: { employeeNumber: "EMP-ADMIN" },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expectProblem(adminCreate, 403, "POLICY_DENIED");

    const clientScopedCreate = await signedRequest({
      body: {
        actorPrincipalId: ids.operatorA,
        employeeNumber: "EMP-SPOOFED-SCOPE",
        tenantId: ids.tenantB,
      },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(clientScopedCreate.response.statusCode).toBe(400);
    expect(clientScopedCreate.response.headers["content-type"]).toContain(
      "application/problem+json",
    );
    const validationProblem = clientScopedCreate.response.json<Record<string, unknown>>();
    expect(clientScopedCreate.response.headers["x-request-id"]).toBe(validationProblem.requestId);
    expect(validationProblem).toEqual({
      code: "REQUEST_VALIDATION_FAILED",
      detail: "Request did not match the API contract.",
      instance: "/v1/hr/workforce-profiles",
      requestId: expect.any(String),
      status: 400,
      title: "Bad Request",
      type: "urn:esbla:problem:request_validation_failed",
    });

    const createKey = randomUUID();
    const createBody = { employeeNumber: "EMP-0001" };
    const created = await signedRequest({
      body: createBody,
      idempotencyKey: createKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(created.response.statusCode).toBe(201);
    expect(created.response.headers["idempotent-replayed"]).toBe("false");
    const draft = created.response.json<HrWorkforceProfile>();
    expect(Object.keys(draft).sort()).toEqual(
      [
        "createdAt",
        "employeeNumber",
        "principalLinked",
        "updatedAt",
        "version",
        "workerProfileId",
        "workforceStatus",
      ].sort(),
    );
    expect(draft).toMatchObject({
      employeeNumber: "EMP-0001",
      principalLinked: false,
      version: 1,
      workforceStatus: "draft",
    });

    const createReplay = await signedRequest({
      body: createBody,
      idempotencyKey: createKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles",
    });
    expect(createReplay.response.statusCode).toBe(200);
    expect(createReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(createReplay.response.json()).toEqual(draft);

    const unlinkedOwn = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expectProblem(unlinkedOwn, 403, "POLICY_DENIED");

    const missing = await signedRequest({
      body: { expectedVersion: 1, targetStatus: "active" },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/30000000-0000-4000-8000-000000000010/status",
    });
    expectProblem(missing, 404, "WORKFORCE_PROFILE_NOT_FOUND");

    const crossTenantLink = await signedRequest({
      body: { expectedVersion: 1, principalId: ids.employeeB },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${draft.workerProfileId}/principal-link`,
    });
    expectProblem(crossTenantLink, 422, "WORKFORCE_PROFILE_PRINCIPAL_UNAVAILABLE");

    const linkKey = randomUUID();
    const linkBody = { expectedVersion: 1, principalId: ids.employeeA };
    const linked = await signedRequest({
      body: linkBody,
      idempotencyKey: linkKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${draft.workerProfileId}/principal-link`,
    });
    expect(linked.response.statusCode).toBe(200);
    expect(linked.response.headers["idempotent-replayed"]).toBe("false");
    expect(linked.response.json<HrWorkforceProfile>()).toMatchObject({
      principalLinked: true,
      version: 2,
      workforceStatus: "draft",
    });

    const linkReplay = await signedRequest({
      body: linkBody,
      idempotencyKey: linkKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${draft.workerProfileId}/principal-link`,
    });
    expect(linkReplay.response.statusCode).toBe(200);
    expect(linkReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(linkReplay.response.json()).toEqual(linked.response.json());

    const draftOwn = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expectProblem(draftOwn, 403, "POLICY_DENIED");

    const staleStatus = await signedRequest({
      body: { expectedVersion: 1, targetStatus: "active" },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${draft.workerProfileId}/status`,
    });
    expectProblem(staleStatus, 409, "WORKFORCE_PROFILE_VERSION_CONFLICT");

    const statusKey = randomUUID();
    const statusBody = { expectedVersion: 2, targetStatus: "active" } as const;
    const activatedProfile = await signedRequest({
      body: statusBody,
      idempotencyKey: statusKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${draft.workerProfileId}/status`,
    });
    expect(activatedProfile.response.statusCode).toBe(200);
    expect(activatedProfile.response.headers["idempotent-replayed"]).toBe("false");
    const activeProfile = activatedProfile.response.json<HrWorkforceProfile>();
    expect(activeProfile).toMatchObject({
      principalLinked: true,
      version: 3,
      workforceStatus: "active",
    });

    const own = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expect(own.response.statusCode).toBe(200);
    expect(own.response.json()).toEqual(activeProfile);
    expect(own.response.json()).not.toHaveProperty("tenantId");
    expect(own.response.json()).not.toHaveProperty("principalId");

    const persistence = await snapshotWorkforcePersistence(draft.workerProfileId);
    expect(persistence.profiles).toHaveLength(1);
    expect(persistence.profiles[0]).toMatchObject({
      employee_number: "EMP-0001",
      principal_id: ids.employeeA,
      row_version: 3,
      workforce_status: "active",
    });
    expect(persistence.statusHistory).toHaveLength(2);
    expect(persistence.statusHistory.map((row) => row.new_status)).toEqual(["draft", "active"]);
    expect(persistence.evidence.map((row) => row.event_type)).toEqual([
      "hr.workforce_profile.create_profile",
      "hr.workforce_profile.link_principal",
      "hr.workforce_profile.change_status",
    ]);
    expect(persistence.outbox.map((row) => row.aggregate_version)).toEqual([1, 2, 3]);

    const statusReplay = await signedRequest({
      body: statusBody,
      idempotencyKey: statusKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${draft.workerProfileId}/status`,
    });
    expect(statusReplay.response.statusCode).toBe(200);
    expect(statusReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(statusReplay.response.json()).toEqual(activeProfile);

    const forgedTenant = await signedRequest({
      method: "GET",
      principalId: ids.employeeB,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expectProblem(forgedTenant, 403, "ACTOR_NOT_ACTIVE_MEMBER");

    const adminOwn = await signedRequest({
      method: "GET",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expectProblem(adminOwn, 403, "POLICY_DENIED");

    await setMembership(ids.operatorA, { roleKey: "employee" });
    const demotedOperator = await signedRequest({
      body: { expectedVersion: 3, targetStatus: "suspended" },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `/v1/hr/workforce-profiles/${draft.workerProfileId}/status`,
    });
    expectProblem(demotedOperator, 403, "POLICY_DENIED");
    expect(await snapshotWorkforcePersistence(draft.workerProfileId)).toEqual(persistence);

    const deactivationKey = randomUUID();
    const deactivated = await signedRequest({
      body: { expectedVersion: 1 },
      idempotencyKey: deactivationKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/service-control/deactivate",
    });
    expect(deactivated.response.statusCode).toBe(200);
    expect(deactivated.response.headers["idempotent-replayed"]).toBe("false");
    const inactiveControl = deactivated.response.json<HrWorkforceServiceControl>();
    expect(inactiveControl).toMatchObject({ activationState: "inactive", activationVersion: 2 });

    const deactivationReplay = await signedRequest({
      body: { expectedVersion: 1 },
      idempotencyKey: deactivationKey,
      method: "POST",
      principalId: ids.adminA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/service-control/deactivate",
    });
    expect(deactivationReplay.response.statusCode).toBe(200);
    expect(deactivationReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(deactivationReplay.response.json()).toEqual(inactiveControl);

    const blockedAfterDeactivation = await signedRequest({
      method: "GET",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: "/v1/hr/workforce-profiles/own",
    });
    expectProblem(blockedAfterDeactivation, 503, "WORKFORCE_PROFILE_SERVICE_INACTIVE");
    expect(await snapshotWorkforcePersistence(draft.workerProfileId)).toEqual(persistence);
  });
});
