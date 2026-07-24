import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const secret = "esbla-attendance-manual-api-integration-secret-v1";
const ids = {
  admin: "92000000-0000-4000-8000-000000000004",
  adminMembership: "93000000-0000-4000-8000-000000000004",
  operator: "92000000-0000-4000-8000-000000000001",
  operatorMembership: "93000000-0000-4000-8000-000000000001",
  otherOperator: "92000000-0000-4000-8000-000000000003",
  otherOperatorMembership: "93000000-0000-4000-8000-000000000003",
  otherTenant: "94000000-0000-4000-8000-000000000002",
  tenant: "94000000-0000-4000-8000-000000000001",
  worker: "92000000-0000-4000-8000-000000000002",
  workerMembership: "93000000-0000-4000-8000-000000000002",
} as const;
interface SignedPostOptions {
  readonly body: NonNullable<InjectOptions["payload"]>;
  readonly idempotencyKey?: string;
  readonly principalId?: string;
  readonly tenantId?: string;
}
let migrationPool: Pool;
let pool: Pool;
let server: FastifyInstance;
let workerProfileId = "";
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
async function governed<T>(
  operation: (tenantClient: PoolClient) => Promise<T>,
  actorPrincipalId: string = ids.operator,
  tenantId: string = ids.tenant,
): Promise<T> {
  const client = await migrationPool.connect();
  try {
    return await tenantTransaction(client, tenantId, actorPrincipalId, operation);
  } finally {
    client.release();
  }
}
async function governedMutation(query: string, values: unknown[]): Promise<void> {
  await governed((tenantClient) => tenantClient.query(query, values));
}
async function signedPost({
  body,
  idempotencyKey,
  principalId = ids.operator,
  tenantId = ids.tenant,
}: SignedPostOptions) {
  const method = "POST";
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const url = "/v1/hr/attendance-observations";
  const headers: Record<string, string> = {
    "x-esbla-auth-signature": signDevelopmentPrincipal(secret, {
      body,
      method,
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
  return {
    requestId,
    response: await server.inject({ headers, method, payload: body, url }),
  };
}
async function counts(tenantId: string = ids.tenant) {
  const result = await governed(
    (client) =>
      client.query<{ evidence: string; observations: string; outbox: string; work: string }>(
        `SELECT
       (SELECT count(*) FROM hr_attendance_observations WHERE tenant_id=$1)::text observations,
       (SELECT count(*) FROM evidence_events
        WHERE tenant_id=$1 AND event_type LIKE 'hr.attendance.%')::text evidence,
       (SELECT count(*) FROM outbox_events
        WHERE tenant_id=$1 AND event_type LIKE 'hr.attendance.%')::text outbox,
       (SELECT count(*) FROM work_items WHERE tenant_id=$1)::text work`,
        [tenantId],
      ),
    tenantId === ids.otherTenant ? ids.otherOperator : ids.operator,
    tenantId,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Attendance persistence counts are unavailable");
  return {
    evidence: Number(row.evidence),
    observations: Number(row.observations),
    outbox: Number(row.outbox),
    work: Number(row.work),
  };
}
function expectProblem(
  result: Awaited<ReturnType<typeof signedPost>>,
  status: number,
  code: string,
): void {
  expect(result.response.statusCode, result.response.body).toBe(status);
  expect(result.response.headers["content-type"]).toContain("application/problem+json");
  expect(result.response.json()).toMatchObject({ code, requestId: result.requestId, status });
  expect(Object.keys(result.response.json())).toHaveLength(7);
}
const body = (observationKind: "presence_end" | "presence_start" = "presence_start") => ({
  observationKind,
  observedAt: "2026-07-24T08:30:00+05:00",
  workerProfileId,
});
beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL Attendance API harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings,hr_attendance_service_control TO ${applicationRole};
     GRANT SELECT,UPDATE ON hr_worker_profiles,service_activations TO ${applicationRole};
     GRANT SELECT,INSERT ON hr_attendance_observations,evidence_events,outbox_events TO ${applicationRole}`,
  );
  pool = createDatabasePool(runtimeUrl, { max: 8 });
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Attendance Tenant'),($2,'Other Attendance Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Attendance Operator'),($2,'Attendance Worker'),
            ($3,'Other Attendance Operator'),($4,'Attendance Administrator')`,
    [ids.operator, ids.worker, ids.otherOperator, ids.admin],
  );
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, ids.tenant, ids.operator, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'hr_operator'),($4,$2,$5,'employee'),($6,$2,$7,'tenant_admin')`,
        [
          ids.operatorMembership,
          ids.tenant,
          ids.operator,
          ids.workerMembership,
          ids.worker,
          ids.adminMembership,
          ids.admin,
        ],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.attendance.record_manual'),
                ($1,$3,'hr.attendance.configure_service')`,
        [ids.tenant, ids.operator, ids.admin],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),($1,'attendance','active',1)`,
        [ids.tenant],
      );
      const profile = await tenantClient.query<{ worker_profile_id: string }>(
        "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id",
        [ids.tenant],
      );
      workerProfileId = String(profile.rows[0]?.worker_profile_id);
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, workerProfileId, ids.worker],
      );
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, workerProfileId],
      );
    });
    await tenantTransaction(client, ids.otherTenant, ids.otherOperator, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'hr_operator')`,
        [ids.otherOperatorMembership, ids.otherTenant, ids.otherOperator],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.attendance.record_manual')`,
        [ids.otherTenant, ids.otherOperator],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),($1,'attendance','active',1)`,
        [ids.otherTenant],
      );
    });
  } finally {
    client.release();
  }
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ secret }),
    logger: false,
    migrationReadPool: migrationPool,
    pool,
    runtimeEnvironment: "test",
  });
  await server.ready();
});
afterAll(async () => {
  await server?.close();
  await pool?.end();
  await migrationPool?.end();
});
describe("Attendance manual observation API", () => {
  it("records once with atomic evidence, outbox and explicit non-billing replay", async () => {
    const key = randomUUID();
    const before = await counts();
    const first = await signedPost({ body: body(), idempotencyKey: key });
    expect(first.response.statusCode, first.response.body).toBe(201);
    expect(first.response.json()).toMatchObject({
      observationKind: "presence_start",
      observedAt: "2026-07-24T03:30:00.000Z",
      sourceKind: "manual",
      version: 1,
      workerProfileId,
    });
    const replay = await signedPost({ body: body(), idempotencyKey: key });
    expect(replay.response.statusCode, replay.response.body).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(first.response.json());
    expect(await counts()).toEqual({
      evidence: before.evidence + 2,
      observations: before.observations + 1,
      outbox: before.outbox + 1,
      work: before.work,
    });
    const proof = await governed((client) =>
      client.query(
        `SELECT evidence.prior_state,evidence.new_state,outbox.aggregate_version,outbox.payload
       FROM evidence_events evidence
       JOIN outbox_events outbox USING (tenant_id,correlation_id)
      WHERE evidence.tenant_id=$1 AND evidence.event_type='hr.attendance.record_manual'`,
        [ids.tenant],
      ),
    );
    expect(proof.rows[0]).toMatchObject({
      aggregate_version: 1,
      new_state: "recorded",
      prior_state: null,
      payload: { action: "record_manual", billingState: "non_billable" },
    });
    const conflict = await signedPost({
      body: body("presence_end"),
      idempotencyKey: key,
    });
    expectProblem(conflict, 409, "IDEMPOTENCY_CONFLICT");
    expect(await counts()).toEqual({
      evidence: before.evidence + 2,
      observations: before.observations + 1,
      outbox: before.outbox + 1,
      work: before.work,
    });
  });
  it("fails current role, capability and cross-tenant authority closed without movement", async () => {
    const baseline = await counts();
    await governedMutation(
      "UPDATE memberships SET role_key='employee' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenant, ids.operator],
    );
    expectProblem(
      await signedPost({ body: body(), idempotencyKey: randomUUID() }),
      403,
      "POLICY_DENIED",
    );
    await governedMutation(
      "UPDATE memberships SET role_key='hr_operator' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenant, ids.operator],
    );
    await governedMutation(
      `DELETE FROM membership_capabilities WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='hr.attendance.record_manual'`,
      [ids.tenant, ids.operator],
    );
    expectProblem(
      await signedPost({ body: body(), idempotencyKey: randomUUID() }),
      403,
      "POLICY_DENIED",
    );
    await governedMutation(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id) VALUES ($1,$2,'hr.attendance.record_manual')`,
      [ids.tenant, ids.operator],
    );
    expectProblem(
      await signedPost({
        body: body(),
        idempotencyKey: randomUUID(),
        principalId: ids.otherOperator,
        tenantId: ids.otherTenant,
      }),
      404,
      "ATTENDANCE_WORKER_UNAVAILABLE",
    );
    expect(await counts()).toEqual(baseline);
    expect(await counts(ids.otherTenant)).toEqual({
      evidence: 0,
      observations: 0,
      outbox: 0,
      work: 0,
    });
  });
  it("enforces activation, active-worker and exact registered setting state", async () => {
    const baseline = await counts();
    await governedMutation(
      `UPDATE service_activations SET state='inactive',version=version+1 WHERE tenant_id=$1 AND service_key='attendance'`,
      [ids.tenant],
    );
    expectProblem(
      await signedPost({ body: body(), idempotencyKey: randomUUID() }),
      503,
      "ATTENDANCE_SERVICE_INACTIVE",
    );
    await governedMutation(
      `UPDATE service_activations SET state='active',version=version+1 WHERE tenant_id=$1 AND service_key='attendance'`,
      [ids.tenant],
    );
    await governedMutation(
      `UPDATE service_activations SET state='inactive',version=version+1 WHERE tenant_id=$1 AND service_key='workforce_profile'`,
      [ids.tenant],
    );
    expectProblem(
      await signedPost({ body: body(), idempotencyKey: randomUUID() }),
      503,
      "ATTENDANCE_DEPENDENCY_INACTIVE",
    );
    await governedMutation(
      `UPDATE service_activations SET state='active',version=version+1 WHERE tenant_id=$1 AND service_key='workforce_profile'`,
      [ids.tenant],
    );
    await governedMutation(
      `UPDATE hr_worker_profiles SET workforce_status='suspended',row_version=row_version+1 WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId],
    );
    expectProblem(
      await signedPost({ body: body(), idempotencyKey: randomUUID() }),
      404,
      "ATTENDANCE_WORKER_UNAVAILABLE",
    );
    await governedMutation(
      `UPDATE hr_worker_profiles SET workforce_status='active',row_version=row_version+1 WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId],
    );
    const configClient = await migrationPool.connect();
    let committed = false;
    try {
      await configClient.query("BEGIN");
      await configClient.query(
        `SELECT set_config('app.tenant_id',$1,true),
                set_config('app.actor_principal_id',$2,true),
                set_config('app.correlation_id',$3,true)`,
        [ids.tenant, ids.admin, randomUUID()],
      );
      await configClient.query(
        "SELECT public.esbla_configure_hr_attendance_settings(1,'presence_start',true)",
      );
      const denied = signedPost({ body: body("presence_end"), idempotencyKey: randomUUID() });
      expect(
        await Promise.race([
          denied.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
        ]),
      ).toBe(true);
      await configClient.query("COMMIT");
      committed = true;
      expectProblem(await denied, 403, "POLICY_DENIED");
    } finally {
      if (!committed) await configClient.query("ROLLBACK");
      configClient.release();
    }
    expect(await counts()).toEqual(baseline);
  });
  it("requires a UUID idempotency key and rejects source or authority injection", async () => {
    const missing = await signedPost({ body: body() });
    expect(missing.response.json()).toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(missing.response.json().requestId).not.toBe(missing.requestId);
    expectProblem(
      await signedPost({
        body: { ...body(), sourceKind: "synthetic" },
        idempotencyKey: randomUUID(),
      }),
      400,
      "REQUEST_VALIDATION_FAILED",
    );
    expectProblem(
      await signedPost({
        body: { ...body(), actorPrincipalId: ids.admin },
        idempotencyKey: randomUUID(),
      }),
      400,
      "REQUEST_VALIDATION_FAILED",
    );
  });
});
