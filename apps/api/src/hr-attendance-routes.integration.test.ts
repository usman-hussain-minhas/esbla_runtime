import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import {
  createAttendanceSyntheticTestMarker,
  recordSyntheticTestAttendanceObservation,
} from "@esbla/hr";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const secret = "esbla-attendance-manual-api-integration-secret-v1";
const ids = {
  admin: "92000000-0000-4000-8000-000000000004",
  adminMembership: "93000000-0000-4000-8000-000000000004",
  manager: "92000000-0000-4000-8000-000000000005",
  managerMembership: "93000000-0000-4000-8000-000000000005",
  operator: "92000000-0000-4000-8000-000000000001",
  operatorMembership: "93000000-0000-4000-8000-000000000001",
  otherOperator: "92000000-0000-4000-8000-000000000003",
  otherOperatorMembership: "93000000-0000-4000-8000-000000000003",
  otherTenant: "94000000-0000-4000-8000-000000000002",
  system: "92000000-0000-4000-8000-000000000006",
  systemMembership: "93000000-0000-4000-8000-000000000006",
  tenant: "94000000-0000-4000-8000-000000000001",
  worker: "92000000-0000-4000-8000-000000000002",
  workerMembership: "93000000-0000-4000-8000-000000000002",
} as const;
interface SignedPostOptions {
  readonly body: NonNullable<InjectOptions["payload"]>;
  readonly idempotencyKey?: string;
  readonly method?: "PATCH" | "POST";
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly url?: string;
}
type SignedGetOptions = Pick<SignedPostOptions, "principalId" | "tenantId"> & {
  readonly url: string;
};
let migrationPool: Pool;
let managerProfileId = "";
let otherWorkerProfileId = "";
let pool: Pool;
let relationshipId = "";
let server: FastifyInstance;
let workerProfileId = "";
let afterReportCandidate: (() => Promise<void>) | null = null;
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
function observeReportCandidate(source: Pool): Pool {
  return new Proxy(source, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "connect") return typeof value === "function" ? value.bind(target) : value;
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, clientProperty) {
            const member = Reflect.get(connection, clientProperty, connection);
            if (clientProperty !== "query")
              return typeof member === "function" ? member.bind(connection) : member;
            return async (text: string, values?: unknown[]) => {
              const result = await connection.query(text, values);
              if (text.includes("SELECT observation.attendance_observation_id")) {
                const step = afterReportCandidate;
                afterReportCandidate = null;
                await step?.();
              }
              return result;
            };
          },
        });
      };
    },
  });
}
async function signedPost({
  body,
  idempotencyKey,
  method = "POST",
  principalId = ids.operator,
  tenantId = ids.tenant,
  url = "/v1/hr/attendance-observations",
}: SignedPostOptions) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1_000));
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
async function signedGet({
  principalId = ids.worker,
  tenantId = ids.tenant,
  url,
}: SignedGetOptions) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1_000));
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
  return {
    requestId,
    response: await server.inject({ headers, method: "GET", url }),
  };
}
async function correctionCounts(tenantId: string = ids.tenant) {
  const result = await governed(
    (client) =>
      client.query<{
        corrections: string;
        evidence: string;
        observations: string;
        outbox: string;
        work: string;
      }>(
        `SELECT
       (SELECT count(*) FROM hr_attendance_observations WHERE tenant_id=$1)::text observations,
       (SELECT count(*) FROM hr_attendance_corrections WHERE tenant_id=$1)::text corrections,
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
  if (!row) throw new Error("Attendance correction counts are unavailable");
  return {
    corrections: Number(row.corrections),
    evidence: Number(row.evidence),
    observations: Number(row.observations),
    outbox: Number(row.outbox),
    work: Number(row.work),
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
const body = (
  observationKind: "presence_end" | "presence_start" = "presence_start",
  observedAt = "2026-07-24T08:30:00+05:00",
) => ({
  observationKind,
  observedAt,
  workerProfileId,
});
const correctionBody = (
  expectedCurrentCorrectionId: string | null = null,
  expectedCurrentCorrectionVersion: number | null = null,
) => ({
  correctedObservationKind: "presence_end",
  correctedObservedAt: "2026-07-24T08:45:00+05:00",
  expectedCurrentCorrectionId,
  expectedCurrentCorrectionVersion,
  reason: "Clock corrected",
});
async function createObservation(observedAt?: string) {
  const result = await signedPost({
    body: body("presence_start", observedAt),
    idempotencyKey: randomUUID(),
  });
  expect(result.response.statusCode, result.response.body).toBe(201);
  return result.response.json() as { attendanceObservationId: string };
}
async function createActiveWorkerProfile(
  client: PoolClient,
  tenantId: string,
  principalId: string,
): Promise<string> {
  const profile = await client.query<{ worker_profile_id: string }>(
    "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id",
    [tenantId],
  );
  const profileId = String(profile.rows[0]?.worker_profile_id);
  await client.query(
    `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, profileId, principalId],
  );
  await client.query(
    `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, profileId],
  );
  return profileId;
}
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
    `GRANT SELECT ON membership_capabilities,tenant_settings,hr_attendance_service_control,
       hr_reporting_relationships TO ${applicationRole};
     GRANT SELECT,UPDATE ON hr_worker_profiles,service_activations TO ${applicationRole};
     GRANT SELECT,INSERT ON hr_attendance_corrections,hr_attendance_observations,evidence_events,outbox_events TO ${applicationRole}`,
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
            ($3,'Other Attendance Operator'),($4,'Attendance Administrator'),
            ($5,'Attendance Manager'),($6,'Attendance Synthetic System')`,
    [ids.operator, ids.worker, ids.otherOperator, ids.admin, ids.manager, ids.system],
  );
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, ids.tenant, ids.operator, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'hr_operator'),($4,$2,$5,'employee'),
                ($6,$2,$7,'tenant_admin'),($8,$2,$9,'manager'),
                ($10,$2,$11,'system')`,
        [
          ids.operatorMembership,
          ids.tenant,
          ids.operator,
          ids.workerMembership,
          ids.worker,
          ids.adminMembership,
          ids.admin,
          ids.managerMembership,
          ids.manager,
          ids.systemMembership,
          ids.system,
        ],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.attendance.record_manual'),
                ($1,$2,'hr.attendance.correct'),
                ($1,$2,'hr.attendance.list_reports'),
                ($1,$2,'hr.attendance.view_detail'),
                ($1,$3,'hr.attendance.activate_service'),
                ($1,$3,'hr.attendance.configure_service'),
                ($1,$3,'hr.attendance.deactivate_service'),
                ($1,$3,'hr.attendance.view_service_control'),
                ($1,$4,'hr.attendance.list_own'),
                ($1,$4,'hr.attendance.view_detail'),
                ($1,$5,'hr.attendance.list_reports'),
                ($1,$5,'hr.attendance.view_detail'),
                ($1,$6,'hr.attendance.record_synthetic_test')`,
        [ids.tenant, ids.operator, ids.admin, ids.worker, ids.manager, ids.system],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),($1,'attendance','active',1)`,
        [ids.tenant],
      );
      workerProfileId = await createActiveWorkerProfile(tenantClient, ids.tenant, ids.worker);
      managerProfileId = await createActiveWorkerProfile(tenantClient, ids.tenant, ids.manager);
      const relationship = await tenantClient.query<{ reporting_relationship_id: string }>(
        `INSERT INTO hr_reporting_relationships
           (tenant_id,worker_profile_id,manager_worker_profile_id,relationship_status,
            relationship_version)
         VALUES ($1,$2,$3,'assigned',1)
         RETURNING reporting_relationship_id`,
        [ids.tenant, workerProfileId, managerProfileId],
      );
      relationshipId = String(relationship.rows[0]?.reporting_relationship_id);
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3,row_version=4
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, workerProfileId, relationshipId],
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
         VALUES ($1,$2,'hr.attendance.record_manual'),
                ($1,$2,'hr.attendance.correct'),
                ($1,$2,'hr.attendance.view_detail')`,
        [ids.otherTenant, ids.otherOperator],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),($1,'attendance','active',1)`,
        [ids.otherTenant],
      );
      otherWorkerProfileId = await createActiveWorkerProfile(
        tenantClient,
        ids.otherTenant,
        ids.otherOperator,
      );
    });
  } finally {
    client.release();
  }
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ secret }),
    logger: false,
    migrationReadPool: migrationPool,
    pool: observeReportCandidate(pool),
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
describe("Attendance internal synthetic-test action", () => {
  const syntheticInput = (
    idempotencyKey: string,
    observationKind: "presence_end" | "presence_start" = "presence_start",
  ) => ({
    idempotencyKey,
    observationKind,
    observedAt: "2026-07-23T09:00:00+05:00",
    workerProfileId,
  });
  const syntheticContext = (correlationId: string) => ({
    actorPrincipalId: ids.system,
    correlationId,
    tenantId: ids.tenant,
  });
  const callSynthetic = (
    key: string,
    marker = createAttendanceSyntheticTestMarker(),
    input = syntheticInput(key),
    correlationId = key,
  ) =>
    recordSyntheticTestAttendanceObservation(pool, syntheticContext(correlationId), input, marker);
  const expectDeniedWhile = async (
    denySql: string,
    restoreSql: string,
    values: unknown[],
    code: string,
    marker: ReturnType<typeof createAttendanceSyntheticTestMarker>,
  ) => {
    await governedMutation(denySql, values);
    try {
      await expect(callSynthetic(randomUUID(), marker)).rejects.toMatchObject({ code });
    } finally {
      await governedMutation(restoreSql, values);
    }
  };

  it("records and replays one synthetic fact with atomic evidence, outbox and no billing", async () => {
    const key = randomUUID();
    const marker = createAttendanceSyntheticTestMarker();
    const before = await counts();
    const first = await callSynthetic(key, marker);
    expect(first).toMatchObject({
      billingState: "non_billable",
      observation: {
        observationKind: "presence_start",
        observedAt: "2026-07-23T04:00:00.000Z",
        sourceKind: "synthetic",
        version: 1,
        workerProfileId,
      },
      replayed: false,
    });
    expect(await callSynthetic(key, marker, syntheticInput(key), randomUUID())).toEqual({
      ...first,
      replayed: true,
    });
    expect(await counts()).toEqual({
      evidence: before.evidence + 2,
      observations: before.observations + 1,
      outbox: before.outbox + 1,
      work: before.work,
    });
    const proof = await governed((client) =>
      client.query(
        `SELECT evidence.tenant_id,evidence.actor_principal_id,
                evidence.subject_type,evidence.subject_id,
                evidence.correlation_id,evidence.prior_state,evidence.new_state,
                outbox.event_type AS outbox_event_type,
                outbox.aggregate_type,outbox.aggregate_id,
                outbox.aggregate_version,outbox.payload,observation.source_kind
         FROM evidence_events evidence
         JOIN outbox_events outbox USING (tenant_id,correlation_id)
         JOIN hr_attendance_observations observation
           ON observation.tenant_id=evidence.tenant_id
          AND observation.attendance_observation_id=evidence.subject_id
         WHERE evidence.tenant_id=$1
           AND evidence.event_type='hr.attendance.record_synthetic_test'`,
        [ids.tenant],
      ),
    );
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]).toMatchObject({
      actor_principal_id: ids.system,
      aggregate_id: first.observation.attendanceObservationId,
      aggregate_type: "hr.attendance.observation",
      aggregate_version: 1,
      correlation_id: key,
      new_state: "recorded",
      outbox_event_type: "hr.attendance.record_synthetic_test",
      prior_state: null,
      source_kind: "synthetic",
      subject_id: first.observation.attendanceObservationId,
      subject_type: "hr.attendance.observation",
      tenant_id: ids.tenant,
      payload: {
        action: "record_synthetic_test",
        afterVersion: 1,
        beforeVersion: null,
        billingState: "non_billable",
      },
    });
    await expect(
      callSynthetic(key, marker, syntheticInput(key, "presence_end")),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(await counts()).toEqual({
      evidence: before.evidence + 2,
      observations: before.observations + 1,
      outbox: before.outbox + 1,
      work: before.work,
    });
  });

  it("fails forged markers, current authority, activation and cross-tenant input closed", async () => {
    const baseline = await counts();
    const validMarker = createAttendanceSyntheticTestMarker();
    await expect(
      callSynthetic(randomUUID(), { kind: "hr.attendance.synthetic_test.v1" }),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await expectDeniedWhile(
      "UPDATE memberships SET role_key='hr_operator' WHERE tenant_id=$1 AND principal_id=$2",
      "UPDATE memberships SET role_key='system' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenant, ids.system],
      "POLICY_DENIED",
      validMarker,
    );
    await expectDeniedWhile(
      `DELETE FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2
         AND capability_id='hr.attendance.record_synthetic_test'`,
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'hr.attendance.record_synthetic_test')`,
      [ids.tenant, ids.system],
      "POLICY_DENIED",
      validMarker,
    );
    await expectDeniedWhile(
      `UPDATE service_activations SET state='inactive',version=version+1
       WHERE tenant_id=$1 AND service_key='attendance'`,
      `UPDATE service_activations SET state='active',version=version+1
       WHERE tenant_id=$1 AND service_key='attendance'`,
      [ids.tenant],
      "ATTENDANCE_SERVICE_INACTIVE",
      validMarker,
    );
    await expectDeniedWhile(
      `UPDATE service_activations SET state='inactive',version=version+1
       WHERE tenant_id=$1 AND service_key='workforce_profile'`,
      `UPDATE service_activations SET state='active',version=version+1
       WHERE tenant_id=$1 AND service_key='workforce_profile'`,
      [ids.tenant],
      "ATTENDANCE_DEPENDENCY_INACTIVE",
      validMarker,
    );
    const otherBaseline = await counts(ids.otherTenant);
    const crossTenantKey = randomUUID();
    await expect(
      callSynthetic(crossTenantKey, validMarker, {
        ...syntheticInput(crossTenantKey),
        workerProfileId: otherWorkerProfileId,
      }),
    ).rejects.toMatchObject({ code: "ATTENDANCE_WORKER_UNAVAILABLE" });
    expect(await counts()).toEqual(baseline);
    expect(await counts(ids.otherTenant)).toEqual(otherBaseline);
  });

  it("requires the supported test environment and stays unreachable from product HTTP", async () => {
    const marker = createAttendanceSyntheticTestMarker();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => createAttendanceSyntheticTestMarker()).toThrow(
        "Synthetic Attendance is test-only",
      );
      await expect(callSynthetic(randomUUID(), marker)).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    const response = await server.inject({
      method: "POST",
      payload: body(),
      url: "/v1/hr/attendance-observations/synthetic-test",
    });
    expect(response.statusCode).toBe(404);
  });
});
describe("Attendance correction API", () => {
  it("appends one immutable correction with atomic proof and semantic replay", async () => {
    const observation = await createObservation();
    const url = `/v1/hr/attendance-observations/${observation.attendanceObservationId}/corrections`;
    const baseline = await correctionCounts();
    const key = randomUUID();
    const first = await signedPost({ body: correctionBody(), idempotencyKey: key, url });
    expect(first.response.statusCode, first.response.body).toBe(201);
    expect(first.response.headers["idempotent-replayed"]).toBe("false");
    expect(first.response.json()).toMatchObject({
      attendanceObservationId: observation.attendanceObservationId,
      correctedObservationKind: "presence_end",
      correctedObservedAt: "2026-07-24T03:45:00.000Z",
      reason: "Clock corrected",
      supersedesAttendanceCorrectionId: null,
      version: 1,
    });
    expect(Object.keys(first.response.json()).sort()).toEqual([
      "attendanceCorrectionId",
      "attendanceObservationId",
      "correctedObservationKind",
      "correctedObservedAt",
      "createdAt",
      "reason",
      "supersedesAttendanceCorrectionId",
      "version",
    ]);
    const replay = await signedPost({ body: correctionBody(), idempotencyKey: key, url });
    expect(replay.response.statusCode, replay.response.body).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(first.response.json());
    expect(await correctionCounts()).toEqual({
      corrections: baseline.corrections + 1,
      evidence: baseline.evidence + 2,
      observations: baseline.observations,
      outbox: baseline.outbox + 1,
      work: baseline.work,
    });
    const stored = await governed((client) =>
      client.query(
        `SELECT correction.actor_principal_id::text,correction.correction_version,
                correction.supersedes_attendance_correction_id,
                observation.observed_at,observation.observation_kind,observation.row_version
         FROM hr_attendance_corrections correction
         JOIN hr_attendance_observations observation
           ON observation.tenant_id=correction.tenant_id
          AND observation.attendance_observation_id=correction.attendance_observation_id
         WHERE correction.tenant_id=$1 AND correction.attendance_correction_id=$2`,
        [ids.tenant, first.response.json().attendanceCorrectionId],
      ),
    );
    expect(stored.rows[0]).toMatchObject({
      actor_principal_id: ids.operator,
      correction_version: 1,
      observation_kind: "presence_start",
      row_version: 1,
      supersedes_attendance_correction_id: null,
    });
    const proof = await governed((client) =>
      client.query(
        `SELECT evidence.prior_state,evidence.new_state,
                outbox.aggregate_version,outbox.payload
         FROM evidence_events evidence
         JOIN outbox_events outbox USING (tenant_id,correlation_id)
         WHERE evidence.tenant_id=$1
           AND evidence.event_type='hr.attendance.correct'
           AND evidence.subject_id=$2`,
        [ids.tenant, first.response.json().attendanceCorrectionId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({
      aggregate_version: 1,
      new_state: "recorded",
      prior_state: null,
      payload: {
        action: "correct",
        beforeVersion: null,
        billingState: "non_billable",
      },
    });
    const conflict = await signedPost({
      body: { ...correctionBody(), reason: "Different correction" },
      idempotencyKey: key,
      url,
    });
    expectProblem(conflict, 409, "IDEMPOTENCY_CONFLICT");
    expect(await correctionCounts()).toEqual({
      corrections: baseline.corrections + 1,
      evidence: baseline.evidence + 2,
      observations: baseline.observations,
      outbox: baseline.outbox + 1,
      work: baseline.work,
    });
  });
  it("serializes one successor and rejects a concurrent stale correction unchanged", async () => {
    const observation = await createObservation();
    const url = `/v1/hr/attendance-observations/${observation.attendanceObservationId}/corrections`;
    const first = await signedPost({
      body: correctionBody(),
      idempotencyKey: randomUUID(),
      url,
    });
    expect(first.response.statusCode, first.response.body).toBe(201);
    const predecessor = String(first.response.json().attendanceCorrectionId);
    const baseline = await correctionCounts();
    const inputs = ["First concurrent successor", "Second concurrent successor"].map((reason) =>
      signedPost({
        body: { ...correctionBody(predecessor, 1), reason },
        idempotencyKey: randomUUID(),
        url,
      }),
    );
    const results = await Promise.all(inputs);
    expect(results.map(({ response }) => response.statusCode).sort()).toEqual([201, 409]);
    const denied = results.find(({ response }) => response.statusCode === 409);
    expectProblem(denied as Awaited<ReturnType<typeof signedPost>>, 409, "ATTENDANCE_CONFLICT");
    const winner = results.find(({ response }) => response.statusCode === 201);
    expect(winner?.response.json()).toMatchObject({
      supersedesAttendanceCorrectionId: predecessor,
      version: 2,
    });
    expect(await correctionCounts()).toEqual({
      corrections: baseline.corrections + 1,
      evidence: baseline.evidence + 2,
      observations: baseline.observations,
      outbox: baseline.outbox + 1,
      work: baseline.work,
    });
    const chain = await governed((client) =>
      client.query(
        `SELECT attendance_correction_id::text,correction_version,
                supersedes_attendance_correction_id::text
         FROM hr_attendance_corrections
         WHERE tenant_id=$1 AND attendance_observation_id=$2
         ORDER BY correction_version`,
        [ids.tenant, observation.attendanceObservationId],
      ),
    );
    expect(chain.rows).toMatchObject([
      { attendance_correction_id: predecessor, correction_version: 1 },
      {
        correction_version: 2,
        supersedes_attendance_correction_id: predecessor,
      },
    ]);
  });
  it("fails current authority, tenant, activation and strict input closed without movement", async () => {
    const observation = await createObservation();
    const url = `/v1/hr/attendance-observations/${observation.attendanceObservationId}/corrections`;
    const baseline = await correctionCounts();
    await governedMutation(
      "UPDATE memberships SET role_key='employee' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenant, ids.operator],
    );
    expectProblem(
      await signedPost({ body: correctionBody(), idempotencyKey: randomUUID(), url }),
      403,
      "POLICY_DENIED",
    );
    await governedMutation(
      "UPDATE memberships SET role_key='hr_operator' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenant, ids.operator],
    );
    await governedMutation(
      "UPDATE memberships SET status='suspended' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenant, ids.operator],
    );
    expectProblem(
      await signedPost({ body: correctionBody(), idempotencyKey: randomUUID(), url }),
      403,
      "ACTOR_NOT_ACTIVE_MEMBER",
    );
    await governedMutation(
      "UPDATE memberships SET status='active' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenant, ids.operator],
    );
    await governedMutation(
      `DELETE FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='hr.attendance.correct'`,
      [ids.tenant, ids.operator],
    );
    expectProblem(
      await signedPost({ body: correctionBody(), idempotencyKey: randomUUID(), url }),
      403,
      "POLICY_DENIED",
    );
    await governedMutation(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'hr.attendance.correct'),($1,$3,'hr.attendance.correct')`,
      [ids.tenant, ids.operator, ids.admin],
    );
    expectProblem(
      await signedPost({
        body: correctionBody(),
        idempotencyKey: randomUUID(),
        principalId: ids.admin,
        url,
      }),
      403,
      "POLICY_DENIED",
    );
    expectProblem(
      await signedPost({
        body: correctionBody(),
        idempotencyKey: randomUUID(),
        principalId: ids.otherOperator,
        tenantId: ids.otherTenant,
        url,
      }),
      404,
      "ATTENDANCE_OBSERVATION_NOT_FOUND",
    );
    await governedMutation(
      `UPDATE service_activations SET state='inactive',version=version+1
       WHERE tenant_id=$1 AND service_key='attendance'`,
      [ids.tenant],
    );
    expectProblem(
      await signedPost({ body: correctionBody(), idempotencyKey: randomUUID(), url }),
      503,
      "ATTENDANCE_SERVICE_INACTIVE",
    );
    await governedMutation(
      `UPDATE service_activations SET state='active',version=version+1
       WHERE tenant_id=$1 AND service_key='attendance'`,
      [ids.tenant],
    );
    await governedMutation(
      `UPDATE service_activations SET state='inactive',version=version+1
       WHERE tenant_id=$1 AND service_key='workforce_profile'`,
      [ids.tenant],
    );
    expectProblem(
      await signedPost({ body: correctionBody(), idempotencyKey: randomUUID(), url }),
      503,
      "ATTENDANCE_DEPENDENCY_INACTIVE",
    );
    await governedMutation(
      `UPDATE service_activations SET state='active',version=version+1
       WHERE tenant_id=$1 AND service_key='workforce_profile'`,
      [ids.tenant],
    );
    for (const injected of [
      { actorPrincipalId: ids.admin },
      { providerPayload: "forbidden" },
      { sourceKind: "synthetic" },
      { tenantId: ids.otherTenant },
    ]) {
      expectProblem(
        await signedPost({
          body: { ...correctionBody(), ...injected },
          idempotencyKey: randomUUID(),
          url,
        }),
        400,
        "REQUEST_VALIDATION_FAILED",
      );
    }
    const missing = await signedPost({ body: correctionBody(), url });
    expect(missing.response.json()).toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(await correctionCounts()).toEqual(baseline);
    expect(await correctionCounts(ids.otherTenant)).toEqual({
      corrections: 0,
      evidence: 0,
      observations: 0,
      outbox: 0,
      work: 0,
    });
  });
});
const rangeQuery = "rangeStart=2026-07-24T00%3A00%3A00.000Z&rangeEnd=2026-07-25T00%3A00%3A00.000Z";
const detailUrl = (id: string, query = "") => `/v1/hr/attendance-observations/by-id/${id}${query}`;
const ownUrl = (query = "") => `/v1/hr/attendance-observations/own?${rangeQuery}${query}`;
const reportsUrl = (query = "") => `/v1/hr/attendance-observations/reports?${rangeQuery}${query}`;
async function expectReadProblem(
  url: string,
  status: number,
  code: string,
  principalId: string = ids.worker,
  tenantId: string = ids.tenant,
): Promise<void> {
  expectProblem(await signedGet({ principalId, tenantId, url }), status, code);
}
async function setCapability(
  principalId: string,
  capabilityId: string,
  enabled: boolean,
): Promise<void> {
  await governedMutation(
    enabled
      ? `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,$3)`
      : `DELETE FROM membership_capabilities
         WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [ids.tenant, principalId, capabilityId],
  );
}
async function setMembership(
  principalId: string,
  field: "role_key" | "status",
  value: string,
): Promise<void> {
  await governedMutation(
    `UPDATE memberships SET ${field}=$3 WHERE tenant_id=$1 AND principal_id=$2`,
    [ids.tenant, principalId, value],
  );
}
async function setProfileStatus(profileId: string, status: "active" | "suspended"): Promise<void> {
  await governedMutation(
    `UPDATE hr_worker_profiles SET workforce_status=$3,row_version=row_version+1
     WHERE tenant_id=$1 AND worker_profile_id=$2 AND workforce_status<>$3`,
    [ids.tenant, profileId, status],
  );
}
async function setActivation(serviceKey: string, state: "active" | "inactive"): Promise<void> {
  await governedMutation(
    `UPDATE service_activations SET state=$3,version=version+1
     WHERE tenant_id=$1 AND service_key=$2`,
    [ids.tenant, serviceKey, state],
  );
}

describe("Attendance read APIs", () => {
  it("serves cursor-stable own, report and detail history without private fields", async () => {
    await createObservation();
    const observation = await createObservation("2026-07-24T08:31:00+05:00");
    const correctionUrl = `/v1/hr/attendance-observations/${observation.attendanceObservationId}/corrections`;
    const first = await signedPost({
      body: correctionBody(),
      idempotencyKey: randomUUID(),
      url: correctionUrl,
    });
    const second = await signedPost({
      body: {
        ...correctionBody(first.response.json().attendanceCorrectionId, 1),
        reason: "Second correction",
      },
      idempotencyKey: randomUUID(),
      url: correctionUrl,
    });
    const own = await signedGet({ url: ownUrl("&pageSize=1") });
    expect(own.response.headers["x-esbla-attendance-actions"]).toBe('["list_own","view_detail"]');
    expect(own.response.json().accessScope).toBe("own");
    const ownCursor = own.response.json().nextCursor;
    const ownNext = await signedGet({
      url: ownUrl(
        `&pageSize=1&cursorObservedAt=${encodeURIComponent(ownCursor.observedAt)}` +
          `&cursorAttendanceObservationId=${ownCursor.attendanceObservationId}`,
      ),
    });
    expect(ownNext.response.json().items[0]?.attendanceObservationId).not.toBe(
      own.response.json().items[0].attendanceObservationId,
    );
    const reports = await signedGet({ principalId: ids.manager, url: reportsUrl("&pageSize=1") });
    expect(reports.response.headers["x-esbla-attendance-actions"]).toBe(
      '["list_reports","view_detail"]',
    );
    expect(reports.response.json().accessScope).toBe("assigned");
    expect(reports.response.json().items[0]?.attendanceObservationId).toBe(
      observation.attendanceObservationId,
    );
    const reportCursor = reports.response.json().nextCursor;
    const reportNext = await signedGet({
      principalId: ids.manager,
      url: reportsUrl(
        `&pageSize=1&cursorObservedAt=${encodeURIComponent(reportCursor.observedAt)}` +
          `&cursorAttendanceObservationId=${reportCursor.attendanceObservationId}`,
      ),
    });
    expect(reportNext.response.json().items[0]?.attendanceObservationId).not.toBe(
      reports.response.json().items[0].attendanceObservationId,
    );
    const tenantReports = await signedGet({ principalId: ids.operator, url: reportsUrl() });
    expect(tenantReports.response.headers["x-esbla-attendance-actions"]).toBe(
      '["correct","list_reports","record_manual","view_detail"]',
    );
    expect(tenantReports.response.json().accessScope).toBe("tenant");

    const detail = await signedGet({
      url: detailUrl(observation.attendanceObservationId, "?pageSize=1"),
    });
    expect(detail.response.json().corrections.items[0]?.attendanceCorrectionId).toBe(
      second.response.json().attendanceCorrectionId,
    );
    const cursor = detail.response.json().corrections.nextCursor;
    const history = await signedGet({
      url: detailUrl(
        observation.attendanceObservationId,
        `?pageSize=1&cursorCorrectionVersion=${cursor.version}` +
          `&cursorAttendanceCorrectionId=${cursor.attendanceCorrectionId}`,
      ),
    });
    expect(history.response.json().corrections.items[0]?.attendanceCorrectionId).toBe(
      first.response.json().attendanceCorrectionId,
    );
    for (const principalId of [ids.manager, ids.operator]) {
      const authorized = await signedGet({
        principalId,
        url: detailUrl(observation.attendanceObservationId),
      });
      expect(authorized.response.statusCode, authorized.response.body).toBe(200);
    }
  });
  it("fails a concurrently invalidated report page closed without hiding older reports", async () => {
    const older = await governed(async (client) => {
      const profile = await client.query<{ worker_profile_id: string }>(
        "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id",
        [ids.tenant],
      );
      const profileId = profile.rows[0]?.worker_profile_id ?? "";
      await client.query(
        `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, profileId, ids.admin],
      );
      await client.query(
        `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, profileId],
      );
      const relationship = await client.query<{ reporting_relationship_id: string }>(
        `INSERT INTO hr_reporting_relationships
           (tenant_id,worker_profile_id,manager_worker_profile_id,
            relationship_status,relationship_version)
         VALUES ($1,$2,$3,'assigned',1) RETURNING reporting_relationship_id`,
        [ids.tenant, profileId, managerProfileId],
      );
      await client.query(
        `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3,row_version=4
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, profileId, relationship.rows[0]?.reporting_relationship_id],
      );
      return (
        await client.query<{ id: string }>(
          `INSERT INTO hr_attendance_observations
             (tenant_id,worker_profile_id,observed_at,observation_kind,source_kind)
           VALUES ($1,$2,'2026-07-24T03:29:00Z','presence_start','manual')
           RETURNING attendance_observation_id id`,
          [ids.tenant, profileId],
        )
      ).rows[0]?.id;
    });
    await createObservation();
    try {
      afterReportCandidate = () => setProfileStatus(workerProfileId, "suspended");
      expectProblem(
        await signedGet({ principalId: ids.manager, url: reportsUrl("&pageSize=1") }),
        409,
        "ATTENDANCE_CONFLICT",
      );
      const retry = await signedGet({ principalId: ids.manager, url: reportsUrl("&pageSize=1") });
      expect(retry.response.json().items[0]?.attendanceObservationId).toBe(older);
    } finally {
      afterReportCandidate = null;
      await setProfileStatus(workerProfileId, "active");
    }
  });

  it("re-reads manager role, assigned relationship, membership and capability", async () => {
    const observation = await createObservation();
    const detail = detailUrl(observation.attendanceObservationId);
    await setMembership(ids.manager, "role_key", "employee");
    await expectReadProblem(reportsUrl(), 403, "POLICY_DENIED", ids.manager);
    await setMembership(ids.manager, "role_key", "manager");
    await setProfileStatus(managerProfileId, "suspended");
    await expectReadProblem(reportsUrl(), 403, "POLICY_DENIED", ids.manager);
    await setProfileStatus(managerProfileId, "active");
    await setCapability(ids.manager, "hr.attendance.list_reports", false);
    await expectReadProblem(reportsUrl(), 403, "POLICY_DENIED", ids.manager);
    await setCapability(ids.manager, "hr.attendance.list_reports", true);
    await setMembership(ids.worker, "status", "suspended");
    await expectReadProblem(detail, 403, "ACTOR_NOT_ACTIVE_MEMBER");
    await setMembership(ids.worker, "status", "active");
    await setProfileStatus(workerProfileId, "suspended");
    await expectReadProblem(ownUrl(), 403, "POLICY_DENIED");
    await setProfileStatus(workerProfileId, "active");
    await setCapability(ids.worker, "hr.attendance.list_own", false);
    await expectReadProblem(ownUrl(), 403, "POLICY_DENIED");
    await setCapability(ids.worker, "hr.attendance.list_own", true);
    await setCapability(ids.worker, "hr.attendance.view_detail", false);
    await expectReadProblem(detail, 403, "POLICY_DENIED");
    await setCapability(ids.worker, "hr.attendance.view_detail", true);
    const unassigned = await governed((client) =>
      client.query<{ id: string }>(
        `INSERT INTO hr_reporting_relationships
           (tenant_id,worker_profile_id,relationship_status,relationship_version,
            supersedes_reporting_relationship_id)
         VALUES ($1,$2,'unassigned',2,$3) RETURNING reporting_relationship_id id`,
        [ids.tenant, workerProfileId, relationshipId],
      ),
    );
    await governedMutation(
      `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3,
              row_version=row_version+1 WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId, unassigned.rows[0]?.id],
    );
    await expectReadProblem(detail, 403, "POLICY_DENIED", ids.manager);
  });

  it("fails cross-tenant and inactive service/dependency reads closed without movement", async () => {
    const detail = detailUrl((await createObservation()).attendanceObservationId);
    const baseline = await correctionCounts();
    await expectReadProblem(
      detail,
      404,
      "ATTENDANCE_OBSERVATION_NOT_FOUND",
      ids.otherOperator,
      ids.otherTenant,
    );
    await setActivation("attendance", "inactive");
    await expectReadProblem(detail, 503, "ATTENDANCE_SERVICE_INACTIVE");
    await setActivation("attendance", "active");
    await setActivation("workforce_profile", "inactive");
    await expectReadProblem(detail, 503, "ATTENDANCE_DEPENDENCY_INACTIVE");
    await setActivation("workforce_profile", "active");
    expect(await correctionCounts()).toEqual(baseline);
  });
});

const attendanceControlUrl = "/v1/hr/attendance-observations/service-control";
async function serviceControlCounts() {
  const result = await governed((client) =>
    client.query<{ evidence: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM evidence_events
          WHERE tenant_id=$1 AND subject_type IN (
            'hr.attendance.service_control',
            'hr.attendance.service_control.idempotency'
          ))::text evidence,
         (SELECT count(*) FROM outbox_events
          WHERE tenant_id=$1 AND aggregate_type='hr.attendance.service_control')::text outbox`,
      [ids.tenant],
    ),
  );
  return {
    evidence: Number(result.rows[0]?.evidence),
    outbox: Number(result.rows[0]?.outbox),
  };
}
async function attendanceControl() {
  return await signedGet({ principalId: ids.admin, url: attendanceControlUrl });
}
async function controlMutation(
  operation: "activate" | "deactivate" | "settings",
  payload: Record<string, unknown>,
  idempotencyKey = randomUUID(),
) {
  return await signedPost({
    body: payload,
    idempotencyKey,
    method: operation === "settings" ? "PATCH" : "POST",
    principalId: ids.admin,
    url: `${attendanceControlUrl}/${operation}`,
  });
}

describe("Attendance service-control APIs", () => {
  it("returns exact current activation and registered settings only", async () => {
    const current = await attendanceControl();
    expect(current.response.statusCode, current.response.body).toBe(200);
    expect(current.response.headers["x-esbla-attendance-actions"]).toBe(
      '["activate_service","configure_service","deactivate_service","view_service_control"]',
    );
    expect(current.response.json()).toMatchObject({
      activationState: "active",
      serviceKey: "attendance",
      settings: {
        correctionNoteRequired: true,
        manualObservationKinds: "presence_start",
      },
      settingsVersion: 2,
    });
    expect(Object.keys(current.response.json()).sort()).toEqual([
      "activationState",
      "activationVersion",
      "serviceKey",
      "settings",
      "settingsVersion",
      "updatedAt",
      "version",
    ]);
  });

  it("configures the exact setting replacement once and replays evidence-bound", async () => {
    const current = (await attendanceControl()).response.json();
    const baseline = await serviceControlCounts();
    const key = randomUUID();
    const payload = {
      expectedSettingsVersion: current.settingsVersion,
      settings: {
        correctionNoteRequired: true,
        manualObservationKinds: "presence_start,presence_end",
      },
    };
    const first = await controlMutation("settings", payload, key);
    expect(first.response.statusCode, first.response.body).toBe(200);
    expect(first.response.headers["idempotent-replayed"]).toBe("false");
    expect(first.response.json()).toMatchObject({
      activationState: "active",
      settings: payload.settings,
      settingsVersion: current.settingsVersion + 1,
      version: current.version + 1,
    });
    const replay = await controlMutation("settings", payload, key);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(first.response.json());
    expect(await serviceControlCounts()).toEqual({
      evidence: baseline.evidence + 2,
      outbox: baseline.outbox + 1,
    });
    expectProblem(
      await controlMutation(
        "settings",
        { ...payload, settings: { ...payload.settings, manualObservationKinds: "presence_start" } },
        key,
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    for (const settings of [
      { ...payload.settings, correctionNoteRequired: false },
      { ...payload.settings, manualObservationKinds: "gps" },
      { ...payload.settings, providerPayload: "forbidden" },
    ]) {
      expectProblem(
        await controlMutation("settings", {
          expectedSettingsVersion: first.response.json().settingsVersion,
          settings,
        }),
        400,
        "REQUEST_VALIDATION_FAILED",
      );
    }
  });

  it("deactivates reachability, replays unchanged, then activates with dependency proof", async () => {
    const current = (await attendanceControl()).response.json();
    const baseline = await serviceControlCounts();
    const key = randomUUID();
    const stopped = await controlMutation(
      "deactivate",
      {
        expectedVersion: current.activationVersion,
      },
      key,
    );
    expect(stopped.response.json()).toMatchObject({
      activationState: "inactive",
      activationVersion: current.activationVersion + 1,
      settings: current.settings,
    });
    expectProblem(
      await controlMutation("deactivate", { expectedVersion: current.activationVersion }, key),
      503,
      "ATTENDANCE_SERVICE_INACTIVE",
    );
    expectProblem(
      await signedPost({ body: body(), idempotencyKey: randomUUID() }),
      503,
      "ATTENDANCE_SERVICE_INACTIVE",
    );
    expectProblem(
      await controlMutation("settings", {
        expectedSettingsVersion: current.settingsVersion,
        settings: current.settings,
      }),
      503,
      "ATTENDANCE_SERVICE_INACTIVE",
    );
    const started = await controlMutation("activate", {
      expectedVersion: stopped.response.json().activationVersion,
    });
    expect(started.response.json()).toMatchObject({
      activationState: "active",
      activationVersion: stopped.response.json().activationVersion + 1,
      settings: current.settings,
    });
    expect(await serviceControlCounts()).toEqual({
      evidence: baseline.evidence + 4,
      outbox: baseline.outbox + 2,
    });
  });

  it("re-reads exact tenant-admin role and capability without cross-tenant movement", async () => {
    const baseline = await serviceControlCounts();
    await setMembership(ids.admin, "role_key", "employee");
    expectProblem(await attendanceControl(), 403, "POLICY_DENIED");
    await setMembership(ids.admin, "role_key", "tenant_admin");
    await setCapability(ids.admin, "hr.attendance.view_service_control", false);
    expectProblem(await attendanceControl(), 403, "POLICY_DENIED");
    await setCapability(ids.admin, "hr.attendance.view_service_control", true);
    expectProblem(
      await signedGet({
        principalId: ids.otherOperator,
        tenantId: ids.otherTenant,
        url: attendanceControlUrl,
      }),
      403,
      "POLICY_DENIED",
    );
    expect(await serviceControlCounts()).toEqual(baseline);
  });
});
