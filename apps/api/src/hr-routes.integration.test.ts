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
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);

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

  await activateLeaveService(ids.tenantA, ids.adminA);
  await activateLeaveService(ids.tenantB, ids.adminB);
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ clock: () => now, secret }),
    logger: false,
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
