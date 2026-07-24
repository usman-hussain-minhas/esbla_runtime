import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { assignShift, createShiftRoster, publishShiftRoster } from "@esbla/hr";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const secret = "esbla-shift-read-api-integration-secret-v1";
const ids = {
  admin: "81000000-0000-4000-8000-000000000005",
  adminMembership: "82000000-0000-4000-8000-000000000005",
  employee: "81000000-0000-4000-8000-000000000003",
  employeeMembership: "82000000-0000-4000-8000-000000000003",
  manager: "81000000-0000-4000-8000-000000000004",
  managerMembership: "82000000-0000-4000-8000-000000000004",
  operator: "81000000-0000-4000-8000-000000000001",
  operatorMembership: "82000000-0000-4000-8000-000000000001",
  otherTenant: "80000000-0000-4000-8000-000000000002",
  tenant: "80000000-0000-4000-8000-000000000001",
} as const;
interface SignedRequestOptions {
  readonly principalId: string;
  readonly tenantId?: string;
  readonly url: string;
}
interface SignedMutationOptions extends SignedRequestOptions {
  readonly body: NonNullable<InjectOptions["payload"]>;
  readonly idempotencyKey?: string;
}
interface PersistenceCounts {
  readonly assignments: number;
  readonly evidence: number;
  readonly outbox: number;
  readonly work: number;
}
let assignmentId = "";
let migrationPool: Pool;
let pool: Pool;
let rosterVersionId = "";
let server: FastifyInstance;
let workerProfileId = "";
async function restoreShiftRuntimeAuthority(applicationRole: string): Promise<void> {
  const readOnly =
    "tenant_settings,hr_workforce_profile_service_control,membership_capabilities," +
    "hr_workforce_status_history,memberships,hr_shift_assignment_service_control";
  const readInsert = "hr_reporting_relationships,evidence_events,outbox_events";
  const readWrite =
    "hr_worker_profiles,service_activations,hr_shift_assignments,hr_shift_roster_versions";
  await migrationPool.query(
    `REVOKE ALL PRIVILEGES ON TABLE ${readOnly},${readInsert},${readWrite}
     FROM ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT ON TABLE ${readOnly} TO ${applicationRole}`);
  await migrationPool.query(`GRANT SELECT,INSERT ON TABLE ${readInsert} TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT,INSERT,UPDATE ON TABLE ${readWrite} TO ${applicationRole}`,
  );
}
async function tenantTransaction<T>(
  client: PoolClient,
  tenantId: string,
  actorPrincipalId: string,
  operation: (tenantClient: PoolClient) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true),
              set_config('app.actor_principal_id',$2,true),
              set_config('app.correlation_id',$3,true)`,
      [tenantId, actorPrincipalId, randomUUID()],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  tenantId: string,
  actorPrincipalId: string,
  query: string,
  values: readonly unknown[],
): Promise<QueryResult<Row>> {
  return await tenantTransaction(client, tenantId, actorPrincipalId, (tenantClient) =>
    tenantClient.query<Row>(query, [...values]),
  );
}
async function signedGet({ principalId, tenantId = ids.tenant, url }: SignedRequestOptions) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "x-esbla-auth-signature": signDevelopmentPrincipal(secret, {
      method: "GET",
      principalId,
      requestId,
      tenantId,
      timestamp,
      url,
    }),
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": tenantId,
  };
  const request: InjectOptions = { headers, method: "GET", url };
  return { requestId, response: await server.inject(request) };
}
async function signedPost({
  body,
  idempotencyKey,
  principalId,
  tenantId = ids.tenant,
  url,
}: SignedMutationOptions) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "x-esbla-auth-signature": signDevelopmentPrincipal(secret, {
      body,
      method: "POST",
      principalId,
      requestId,
      tenantId,
      timestamp,
      url,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": tenantId,
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const request: InjectOptions = { headers, method: "POST", payload: body, url };
  return { requestId, response: await server.inject(request) };
}
async function signedPatch({
  body,
  idempotencyKey,
  principalId,
  tenantId = ids.tenant,
  url,
}: SignedMutationOptions) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "x-esbla-auth-signature": signDevelopmentPrincipal(secret, {
      body,
      method: "PATCH",
      principalId,
      requestId,
      tenantId,
      timestamp,
      url,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": tenantId,
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const request: InjectOptions = { headers, method: "PATCH", payload: body, url };
  return { requestId, response: await server.inject(request) };
}
async function setActivation(
  serviceKey: "shift_assignment" | "workforce_profile",
  state: "active" | "inactive",
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await tenantQuery(
      client,
      ids.tenant,
      ids.operator,
      `UPDATE service_activations SET state=$3,version=version+1
       WHERE tenant_id=$1 AND service_key=$2`,
      [ids.tenant, serviceKey, state],
    );
  } finally {
    client.release();
  }
}
async function replaceReadCapabilities(
  principalId: string,
  capabilities: readonly string[],
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await tenantQuery(
      client,
      ids.tenant,
      principalId,
      `DELETE FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2 AND capability_id LIKE 'hr.shift.%'`,
      [ids.tenant, principalId],
    );
    if (capabilities.length > 0) {
      await tenantQuery(
        client,
        ids.tenant,
        principalId,
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
        [ids.tenant, principalId, capabilities],
      );
    }
  } finally {
    client.release();
  }
}
async function persistenceCounts(): Promise<PersistenceCounts> {
  const result = await migrationPool.query<{
    assignments: string;
    evidence: string;
    outbox: string;
    work: string;
  }>(
    `SELECT
       (SELECT count(*) FROM hr_shift_assignments WHERE tenant_id=$1)::text assignments,
       (SELECT count(*) FROM evidence_events WHERE tenant_id=$1)::text evidence,
       (SELECT count(*) FROM outbox_events WHERE tenant_id=$1)::text outbox,
       (SELECT count(*) FROM work_items WHERE tenant_id=$1)::text work`,
    [ids.tenant],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Shift read persistence counts are unavailable");
  return {
    assignments: Number(row.assignments),
    evidence: Number(row.evidence),
    outbox: Number(row.outbox),
    work: Number(row.work),
  };
}
function expectProblem(
  result: Awaited<ReturnType<typeof signedGet>>,
  status: number,
  code: string,
): void {
  expect(result.response.statusCode, result.response.body).toBe(status);
  expect(result.response.headers["content-type"]).toContain("application/problem+json");
  expect(result.response.json()).toMatchObject({ code, requestId: result.requestId, status });
  expect(Object.keys(result.response.json()).sort()).toEqual(
    ["code", "detail", "instance", "requestId", "status", "title", "type"].sort(),
  );
}
beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL Shift read API harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  await restoreShiftRuntimeAuthority(applicationRole);
  pool = createDatabasePool(runtimeUrl, { max: 8 });
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings TO ${applicationRole};
     GRANT SELECT,INSERT ON hr_reporting_relationships TO ${applicationRole};
     GRANT SELECT,UPDATE ON service_activations,hr_worker_profiles TO ${applicationRole};
     GRANT SELECT,INSERT ON evidence_events,outbox_events TO ${applicationRole}`,
  );
  await migrationPool.query(`INSERT INTO tenants (tenant_id,name) VALUES ($1,'Shift API Tenant')`, [
    ids.tenant,
  ]);
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Shift Operator'),($2,'Shift Employee'),($3,'Shift Manager'),
            ($4,'Shift Administrator')`,
    [ids.operator, ids.employee, ids.manager, ids.admin],
  );
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, ids.tenant, ids.operator, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'hr_operator'),($4,$2,$5,'employee'),($6,$2,$7,'manager'),
                ($8,$2,$9,'tenant_admin')`,
        [
          ids.operatorMembership,
          ids.tenant,
          ids.operator,
          ids.employeeMembership,
          ids.employee,
          ids.managerMembership,
          ids.manager,
          ids.adminMembership,
          ids.admin,
        ],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
        [
          ids.tenant,
          ids.admin,
          [
            "hr.shift.activate_service",
            "hr.shift.configure_service",
            "hr.shift.deactivate_service",
            "hr.shift.view_service_control",
          ],
        ],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         SELECT $1,principal_id,capability FROM unnest($2::uuid[]) principal_id
         CROSS JOIN unnest($3::text[]) capability`,
        [ids.tenant, [ids.employee, ids.manager], ["hr.shift.list_roster", "hr.shift.view_detail"]],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
        [
          ids.tenant,
          ids.operator,
          [
            "hr.shift.assign",
            "hr.shift.cancel",
            "hr.shift.create_roster",
            "hr.shift.list_roster",
            "hr.shift.publish",
            "hr.shift.view_detail",
          ],
        ],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),($1,'shift_assignment','active',1)`,
        [ids.tenant],
      );
      const worker = await tenantClient.query<{ worker_profile_id: string }>(
        `INSERT INTO hr_worker_profiles (tenant_id)
         VALUES ($1) RETURNING worker_profile_id::text`,
        [ids.tenant],
      );
      workerProfileId = worker.rows[0]?.worker_profile_id ?? "";
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, workerProfileId, ids.employee],
      );
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, workerProfileId],
      );
      const manager = await tenantClient.query<{ worker_profile_id: string }>(
        `INSERT INTO hr_worker_profiles (tenant_id)
         VALUES ($1) RETURNING worker_profile_id::text`,
        [ids.tenant],
      );
      const managerProfileId = manager.rows[0]?.worker_profile_id ?? "";
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, managerProfileId, ids.manager],
      );
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, managerProfileId],
      );
      const relationship = await tenantClient.query<{ reporting_relationship_id: string }>(
        `INSERT INTO hr_reporting_relationships
           (tenant_id,worker_profile_id,manager_worker_profile_id,relationship_status,
            relationship_version)
         VALUES ($1,$2,$3,'assigned',1)
         RETURNING reporting_relationship_id::text`,
        [ids.tenant, workerProfileId, managerProfileId],
      );
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3,row_version=4
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, workerProfileId, relationship.rows[0]?.reporting_relationship_id],
      );
    });
  } finally {
    client.release();
  }
  const roster = await createShiftRoster(
    pool,
    { actorPrincipalId: ids.operator, correlationId: randomUUID(), tenantId: ids.tenant },
    {
      idempotencyKey: randomUUID(),
      periodEnd: "2028-08-14",
      periodStart: "2028-08-01",
    },
  );
  rosterVersionId = roster.roster.rosterVersionId;
  const assignment = await assignShift(
    pool,
    { actorPrincipalId: ids.operator, correlationId: randomUUID(), tenantId: ids.tenant },
    {
      endsAt: "2028-08-03T12:00:00Z",
      ianaTimezone: "Asia/Karachi",
      idempotencyKey: randomUUID(),
      rosterVersionId,
      startsAt: "2028-08-03T04:00:00Z",
      workerProfileId,
    },
  );
  assignmentId = assignment.assignment.shiftAssignmentId;
  await publishShiftRoster(
    pool,
    { actorPrincipalId: ids.operator, correlationId: randomUUID(), tenantId: ids.tenant },
    {
      expectedVersion: roster.roster.version,
      idempotencyKey: randomUUID(),
      rosterVersionId,
    },
  );
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ secret }),
    logger: false,
    migrationReadPool: migrationPool,
    pool,
    runtimeEnvironment: "test",
  });
}, 30_000);
afterAll(async () => {
  await server?.close();
  await pool?.end();
  await migrationPool?.end();
});
describe("Shift Assignment authorized read APIs", () => {
  it("serves strict employee, manager and HR reads without mutating persistence", async () => {
    const before = await persistenceCounts();
    const ownQuery = new URLSearchParams({
      mode: "own",
      pageSize: "1",
      rangeEnd: "2028-09-01T00:00:00Z",
      rangeStart: "2028-08-01T00:00:00Z",
    });
    const own = await signedGet({
      principalId: ids.employee,
      url: `/v1/hr/shift-assignments?${ownQuery}`,
    });
    expect(own.response.statusCode, own.response.body).toBe(200);
    expect(own.response.headers["x-esbla-shift-actions"]).toBe('["list_roster","view_detail"]');
    expect(own.response.json()).toMatchObject({
      accessScope: "own",
      items: [{ shiftAssignmentId: assignmentId, status: "active", workerProfileId }],
    });
    const ownCursor = own.response.json().nextCursor as {
      shiftAssignmentId: string;
      startsAt: string;
    };
    expect(ownCursor).toEqual({
      shiftAssignmentId: assignmentId,
      startsAt: "2028-08-03T04:00:00.000Z",
    });
    const tailQuery = new URLSearchParams({
      cursorShiftAssignmentId: ownCursor.shiftAssignmentId,
      cursorStartsAt: ownCursor.startsAt,
      mode: "own",
      pageSize: "1",
      rangeEnd: "2028-09-01T00:00:00Z",
      rangeStart: "2028-08-01T00:00:00Z",
    });
    expect(
      (
        await signedGet({
          principalId: ids.employee,
          url: `/v1/hr/shift-assignments?${tailQuery}`,
        })
      ).response.json(),
    ).toEqual({ accessScope: "own", items: [], nextCursor: null });

    for (const [principalId, accessScope] of [
      [ids.manager, "assigned"],
      [ids.operator, "tenant"],
    ] as const) {
      const rosterQuery = new URLSearchParams({
        mode: "roster",
        rosterVersionId,
        status: "active",
      });
      const result = await signedGet({
        principalId,
        url: `/v1/hr/shift-assignments?${rosterQuery}`,
      });
      expect(result.response.statusCode, result.response.body).toBe(200);
      expect(result.response.headers["x-esbla-shift-actions"]).toBe(
        principalId === ids.manager
          ? '["list_roster","view_detail"]'
          : '["assign","cancel","create_roster","list_roster","publish","view_detail"]',
      );
      expect(result.response.json()).toMatchObject({
        accessScope,
        items: [{ shiftAssignmentId: assignmentId }],
        nextCursor: null,
      });
    }

    for (const principalId of [ids.employee, ids.manager, ids.operator]) {
      const detail = await signedGet({
        principalId,
        url: `/v1/hr/shift-assignments/by-id/${assignmentId}`,
      });
      expect(detail.response.statusCode, detail.response.body).toBe(200);
      expect(detail.response.headers["x-esbla-shift-actions"]).toBe(
        principalId === ids.operator
          ? '["assign","cancel","create_roster","list_roster","publish","view_detail"]'
          : '["list_roster","view_detail"]',
      );
      expect(detail.response.json()).toMatchObject({
        assignment: { shiftAssignmentId: assignmentId, status: "active" },
        history: [
          {
            eventType: "hr.shift_assignment.assign_shift",
            newState: "active",
            priorState: null,
          },
        ],
      });
    }
    expect(await persistenceCounts()).toEqual(before);
  }, 20_000);
  it("authenticates first and rejects malformed or authority-bearing input", async () => {
    const unauthenticated = await server.inject({
      method: "GET",
      url: "/v1/hr/shift-assignments/by-id/not-a-uuid?tenantId=foreign",
    });
    expect(unauthenticated.statusCode).toBe(401);
    for (const url of [
      "/v1/hr/shift-assignments?mode=own&rangeStart=2028-08-01T00%3A00%3A00Z",
      `/v1/hr/shift-assignments?mode=roster&rosterVersionId=${rosterVersionId}&status=active&cursorShiftAssignmentId=${assignmentId}`,
      `/v1/hr/shift-assignments?mode=roster&rosterVersionId=${rosterVersionId}&status=active&pageSize=51`,
      `/v1/hr/shift-assignments?mode=roster&rosterVersionId=${rosterVersionId}&status=active&tenantId=${ids.otherTenant}`,
      `/v1/hr/shift-assignments/by-id/${assignmentId}?mode=own`,
      "/v1/hr/shift-assignments/by-id/not-a-uuid",
    ]) {
      expectProblem(
        await signedGet({ principalId: ids.operator, url }),
        400,
        "REQUEST_VALIDATION_FAILED",
      );
    }
  });
  it("fails closed for missing authority, cross-tenant access and inactive services", async () => {
    const detailUrl = `/v1/hr/shift-assignments/by-id/${assignmentId}`;
    await replaceReadCapabilities(ids.employee, []);
    try {
      const denied = await signedGet({ principalId: ids.employee, url: detailUrl });
      expectProblem(denied, 403, "POLICY_DENIED");
      expect(denied.response.body).not.toContain(ids.employee);
      expect(denied.response.body).not.toContain(ids.tenant);
    } finally {
      await replaceReadCapabilities(ids.employee, ["hr.shift.list_roster", "hr.shift.view_detail"]);
    }
    expectProblem(
      await signedGet({
        principalId: ids.employee,
        tenantId: ids.otherTenant,
        url: detailUrl,
      }),
      403,
      "ACTOR_NOT_ACTIVE_MEMBER",
    );
    await setActivation("shift_assignment", "inactive");
    try {
      expectProblem(
        await signedGet({ principalId: ids.employee, url: detailUrl }),
        503,
        "SHIFT_SERVICE_INACTIVE",
      );
    } finally {
      await setActivation("shift_assignment", "active");
    }
    await setActivation("workforce_profile", "inactive");
    try {
      expectProblem(
        await signedGet({ principalId: ids.employee, url: detailUrl }),
        503,
        "SHIFT_DEPENDENCY_INACTIVE",
      );
    } finally {
      await setActivation("workforce_profile", "active");
    }
    expectProblem(
      await signedGet({
        principalId: ids.operator,
        url: `/v1/hr/shift-assignments/by-id/${randomUUID()}`,
      }),
      404,
      "SHIFT_NOT_FOUND",
    );
  }, 20_000);
});
describe("Shift Assignment authorized lifecycle APIs", () => {
  it("creates, assigns, publishes and cancels with strict replay-safe responses", async () => {
    const createUrl = "/v1/hr/shift-rosters";
    const createBody = { periodEnd: "2028-09-14", periodStart: "2028-09-01" };
    const createKey = randomUUID();
    const created = await signedPost({
      body: createBody,
      idempotencyKey: createKey,
      principalId: ids.operator,
      url: createUrl,
    });
    expect(created.response.statusCode, created.response.body).toBe(201);
    expect(created.response.headers["idempotent-replayed"]).toBe("false");
    const roster = created.response.json();
    expect(roster).toEqual({
      ...createBody,
      periodVersion: 1,
      publishedAt: null,
      rosterVersionId: expect.any(String),
      status: "draft",
      supersedesRosterVersionId: null,
      version: 1,
    });
    const createReplay = await signedPost({
      body: createBody,
      idempotencyKey: createKey,
      principalId: ids.operator,
      url: createUrl,
    });
    expect(createReplay.response.statusCode, createReplay.response.body).toBe(200);
    expect(createReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(createReplay.response.json()).toEqual(roster);

    const assignUrl = `/v1/hr/shift-rosters/${roster.rosterVersionId}/assignments`;
    const assignBody = {
      endsAt: "2028-09-03T12:00:00Z",
      ianaTimezone: "Asia/Karachi",
      startsAt: "2028-09-03T04:00:00Z",
      workerProfileId,
    };
    const assignKey = randomUUID();
    const assigned = await signedPost({
      body: assignBody,
      idempotencyKey: assignKey,
      principalId: ids.operator,
      url: assignUrl,
    });
    expect(assigned.response.statusCode, assigned.response.body).toBe(201);
    expect(assigned.response.headers["idempotent-replayed"]).toBe("false");
    const assignmentResponse = assigned.response.json();
    expect(assignmentResponse).toEqual({
      assignment: {
        ...assignBody,
        endsAt: "2028-09-03T12:00:00.000Z",
        rosterVersionId: roster.rosterVersionId,
        shiftAssignmentId: expect.any(String),
        startsAt: "2028-09-03T04:00:00.000Z",
        status: "active",
        version: 1,
      },
      history: [
        {
          eventType: "hr.shift_assignment.assign_shift",
          newState: "active",
          occurredAt: expect.any(String),
          priorState: null,
        },
      ],
    });
    const publishUrl = `/v1/hr/shift-rosters/${roster.rosterVersionId}/publish`;
    const publishBody = { expectedVersion: roster.version };
    const publishKey = randomUUID();
    const published = await signedPost({
      body: publishBody,
      idempotencyKey: publishKey,
      principalId: ids.operator,
      url: publishUrl,
    });
    expect(published.response.statusCode, published.response.body).toBe(200);
    expect(published.response.headers["idempotent-replayed"]).toBe("false");
    const publishedRoster = published.response.json();
    expect(publishedRoster).toEqual({
      ...roster,
      publishedAt: expect.any(String),
      status: "published",
      version: 2,
    });
    const publishReplay = await signedPost({
      body: publishBody,
      idempotencyKey: publishKey,
      principalId: ids.operator,
      url: publishUrl,
    });
    expect(publishReplay.response.statusCode, publishReplay.response.body).toBe(200);
    expect(publishReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(publishReplay.response.json()).toEqual(publishedRoster);

    const assignmentId = assignmentResponse.assignment.shiftAssignmentId;
    const cancelUrl = `/v1/hr/shift-assignments/${assignmentId}/cancel`;
    const cancelBody = { expectedVersion: assignmentResponse.assignment.version };
    const cancelKey = randomUUID();
    const cancelled = await signedPost({
      body: cancelBody,
      idempotencyKey: cancelKey,
      principalId: ids.operator,
      url: cancelUrl,
    });
    expect(cancelled.response.statusCode, cancelled.response.body).toBe(200);
    expect(cancelled.response.headers["idempotent-replayed"]).toBe("false");
    expect(cancelled.response.json()).toEqual({
      assignment: { ...assignmentResponse.assignment, status: "cancelled", version: 2 },
      history: [
        assignmentResponse.history[0],
        {
          eventType: "hr.shift_assignment.cancel_assignment",
          newState: "cancelled",
          occurredAt: expect.any(String),
          priorState: "active",
        },
      ],
    });
    const cancelReplay = await signedPost({
      body: cancelBody,
      idempotencyKey: cancelKey,
      principalId: ids.operator,
      url: cancelUrl,
    });
    expect(cancelReplay.response.statusCode, cancelReplay.response.body).toBe(200);
    expect(cancelReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(cancelReplay.response.json()).toEqual(cancelled.response.json());

    const assignReplay = await signedPost({
      body: assignBody,
      idempotencyKey: assignKey,
      principalId: ids.operator,
      url: assignUrl,
    });
    expect(assignReplay.response.statusCode, assignReplay.response.body).toBe(200);
    expect(assignReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(assignReplay.response.json()).toEqual(assignmentResponse);
  }, 20_000);

  it("authenticates before validation and rejects unusable mutation keys without domain access", async () => {
    const before = await persistenceCounts();
    const unauthenticated = await server.inject({
      method: "POST",
      payload: { unexpected: true },
      url: "/v1/hr/shift-rosters/not-a-uuid/assignments",
    });
    expect(unauthenticated.statusCode).toBe(401);
    for (const idempotencyKey of [undefined, "not-a-uuid"]) {
      const result = await signedPost({
        body: { unexpected: true },
        ...(idempotencyKey ? { idempotencyKey } : {}),
        principalId: ids.operator,
        url: "/v1/hr/shift-rosters",
      });
      const problem = result.response.json();
      expect(result.response.statusCode, result.response.body).toBe(401);
      expect(problem).toMatchObject({
        code: "AUTH_REQUIRED",
        requestId: expect.any(String),
        status: 401,
      });
      expect(problem.requestId).not.toBe(result.requestId);
      expect(Object.keys(problem).sort()).toEqual(
        ["code", "detail", "instance", "requestId", "status", "title", "type"].sort(),
      );
    }
    expect(await persistenceCounts()).toEqual(before);
  });
});
describe("Shift Assignment service-control APIs", () => {
  it("returns exact full controls for configure, deactivate, reactivate and replay", async () => {
    const controlUrl = "/v1/hr/shift-rosters/service-control";
    const initial = await signedGet({ principalId: ids.admin, url: controlUrl });
    expect(initial.response.statusCode, initial.response.body).toBe(200);
    expect(initial.response.headers["x-esbla-shift-actions"]).toBe(
      '["activate_service","configure_service","deactivate_service","view_service_control"]',
    );
    const initialControl = initial.response.json();
    expect(initialControl).toEqual({
      activationState: "active",
      activationVersion: expect.any(Number),
      serviceKey: "shift_assignment",
      settings: { overlapAllowed: false, rosterHorizonDays: 14 },
      settingsVersion: 1,
      updatedAt: expect.any(String),
      version: expect.any(Number),
    });

    const unchanged = await persistenceCounts();
    expectProblem(
      await signedGet({ principalId: ids.admin, url: `${controlUrl}?tenantId=${ids.otherTenant}` }),
      400,
      "REQUEST_VALIDATION_FAILED",
    );
    expectProblem(
      await signedGet({ principalId: ids.operator, url: controlUrl }),
      403,
      "POLICY_DENIED",
    );
    const invalidConfigure = await signedPatch({
      body: {
        expectedSettingsVersion: 1,
        settings: {
          employeeNumberRequired: false,
          managerVisibility: "none",
          unlinkedWorkerCreationAllowed: false,
        },
      },
      idempotencyKey: randomUUID(),
      principalId: ids.admin,
      url: `${controlUrl}/settings`,
    });
    expectProblem(invalidConfigure, 400, "REQUEST_VALIDATION_FAILED");
    expect(await persistenceCounts()).toEqual(unchanged);

    const configureBody = {
      expectedSettingsVersion: initialControl.settingsVersion,
      settings: { overlapAllowed: false, rosterHorizonDays: 21 },
    };
    const configureKey = randomUUID();
    const configured = await signedPatch({
      body: configureBody,
      idempotencyKey: configureKey,
      principalId: ids.admin,
      url: `${controlUrl}/settings`,
    });
    expect(configured.response.statusCode, configured.response.body).toBe(200);
    expect(configured.response.json()).toMatchObject({
      activationState: "active",
      activationVersion: initialControl.activationVersion,
      serviceKey: "shift_assignment",
      settings: configureBody.settings,
      settingsVersion: initialControl.settingsVersion + 1,
      version: initialControl.version + 1,
    });

    const deactivateKey = randomUUID();
    const deactivated = await signedPost({
      body: { expectedVersion: initialControl.activationVersion },
      idempotencyKey: deactivateKey,
      principalId: ids.admin,
      url: `${controlUrl}/deactivate`,
    });
    expect(deactivated.response.statusCode, deactivated.response.body).toBe(200);
    expect(deactivated.response.json()).toMatchObject({
      activationState: "inactive",
      activationVersion: initialControl.activationVersion + 1,
      settings: configureBody.settings,
      settingsVersion: initialControl.settingsVersion + 1,
      version: initialControl.version + 2,
    });
    const deactivateReplay = await signedPost({
      body: { expectedVersion: initialControl.activationVersion },
      idempotencyKey: deactivateKey,
      principalId: ids.admin,
      url: `${controlUrl}/deactivate`,
    });
    expect(deactivateReplay.response.json()).toEqual(deactivated.response.json());

    const activateKey = randomUUID();
    const activated = await signedPost({
      body: { expectedVersion: deactivated.response.json().activationVersion },
      idempotencyKey: activateKey,
      principalId: ids.admin,
      url: `${controlUrl}/activate`,
    });
    expect(activated.response.statusCode, activated.response.body).toBe(200);
    expect(activated.response.headers["idempotent-replayed"]).toBe("false");
    expect(activated.response.json()).toMatchObject({
      activationState: "active",
      activationVersion: initialControl.activationVersion + 2,
      settings: configureBody.settings,
      settingsVersion: initialControl.settingsVersion + 1,
      version: initialControl.version + 3,
    });
    const activateReplay = await signedPost({
      body: { expectedVersion: deactivated.response.json().activationVersion },
      idempotencyKey: activateKey,
      principalId: ids.admin,
      url: `${controlUrl}/activate`,
    });
    expect(activateReplay.response.json()).toEqual(activated.response.json());

    const configureReplay = await signedPatch({
      body: configureBody,
      idempotencyKey: configureKey,
      principalId: ids.admin,
      url: `${controlUrl}/settings`,
    });
    expect(configureReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(configureReplay.response.json()).toEqual(configured.response.json());
    expect((await signedGet({ principalId: ids.admin, url: controlUrl })).response.json()).toEqual(
      activated.response.json(),
    );
  }, 20_000);

  it("requires a signed UUID idempotency key before mutation validation", async () => {
    const before = await persistenceCounts();
    for (const idempotencyKey of [undefined, "not-a-uuid"]) {
      const result = await signedPatch({
        body: { unexpected: true },
        ...(idempotencyKey ? { idempotencyKey } : {}),
        principalId: ids.admin,
        url: "/v1/hr/shift-rosters/service-control/settings",
      });
      expect(result.response.statusCode, result.response.body).toBe(401);
    }
    expect(await persistenceCounts()).toEqual(before);
  });
});
