import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { activateTimesheetService } from "@esbla/hr";
import { workspaceManifest } from "@esbla/workspace";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const secret = "esbla-timesheet-service-control-integration-secret-v1";
const ids = {
  admin: "aa000000-0000-4000-8000-000000000001",
  adminMembership: "ab000000-0000-4000-8000-000000000001",
  employee: "aa000000-0000-4000-8000-000000000002",
  employeeMembership: "ab000000-0000-4000-8000-000000000002",
  otherAdmin: "aa000000-0000-4000-8000-000000000003",
  otherAdminMembership: "ab000000-0000-4000-8000-000000000003",
  otherTenant: "ac000000-0000-4000-8000-000000000002",
  tenant: "ac000000-0000-4000-8000-000000000001",
} as const;
const controlUrl = "/v1/hr/timesheets/service-control";
const retentionInsert = `INSERT INTO evidence_events
 (tenant_id,event_type,subject_type,subject_id,actor_principal_id,correlation_id,prior_state,new_state)
 VALUES ($1,'hr.timesheet.retention.qualified','hr.timesheet.retention_qualification','ce2fb833-0dff-8e0b-a54e-29b33022ac26',$2,$3,NULL,'qualified')`;
interface SignedRequestOptions {
  readonly body?: NonNullable<InjectOptions["payload"]>;
  readonly idempotencyKey?: string;
  readonly method?: "GET" | "PATCH" | "POST";
  readonly principalId?: string;
  readonly target?: FastifyInstance;
  readonly tenantId?: string;
  readonly url: string;
}
let migrationPool: Pool;
let pool: Pool;
let server: FastifyInstance;
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
async function governed<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await migrationPool.connect();
  try {
    return await tenantTransaction(client, ids.tenant, ids.admin, operation);
  } finally {
    client.release();
  }
}
async function setActivation(serviceKey: string, state: "active" | "inactive", version: number) {
  return governed((client) =>
    client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,service_key) DO UPDATE SET state=EXCLUDED.state,version=EXCLUDED.version`,
      [ids.tenant, serviceKey, state, version],
    ),
  );
}
async function setAdminRole(role: "employee" | "tenant_admin") {
  return governed((client) =>
    client.query("UPDATE memberships SET role_key=$3 WHERE tenant_id=$1 AND principal_id=$2", [
      ids.tenant,
      ids.admin,
      role,
    ]),
  );
}
function domainActivate(
  mode: "non_production" | "production",
  expectedVersion: number | null,
  runtimePool = pool,
) {
  return activateTimesheetService(
    runtimePool,
    migrationPool,
    { actorPrincipalId: ids.admin, correlationId: randomUUID(), tenantId: ids.tenant },
    { expectedVersion },
    mode,
    workspaceManifest,
  );
}
async function expectActivationBlocked(
  activation: ReturnType<typeof domainActivate>,
  reasons: string[],
) {
  await expect(activation).rejects.toMatchObject({
    code: "ACTIVATION_DEPENDENCY_BLOCKED",
    details: { reasons },
  });
}
async function signedRequest({
  body,
  idempotencyKey,
  method = "GET",
  principalId = ids.admin,
  target = server,
  tenantId = ids.tenant,
  url,
}: SignedRequestOptions) {
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
      ...(body === undefined ? {} : { body }),
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
    response: await target.inject({
      headers,
      method,
      url,
      ...(body === undefined ? {} : { payload: body }),
    }),
  };
}
async function signedGet(
  url: string,
  principalId: string = ids.admin,
  tenantId: string = ids.tenant,
  target = server,
) {
  return signedRequest({ method: "GET", principalId, target, tenantId, url });
}
async function mutate(
  operation: "activate" | "deactivate" | "settings",
  body: Record<string, unknown>,
  idempotencyKey = randomUUID(),
  overrides: Partial<Omit<SignedRequestOptions, "body" | "idempotencyKey" | "url">> = {},
) {
  return await signedRequest({
    body,
    idempotencyKey,
    method: operation === "settings" ? "PATCH" : "POST",
    url: `${controlUrl}/${operation}`,
    ...overrides,
  });
}
function expectProblem(
  result: Awaited<ReturnType<typeof signedRequest>>,
  status: number,
  code: string,
): void {
  expect(result.response.statusCode, result.response.body).toBe(status);
  expect(result.response.headers["content-type"]).toContain("application/problem+json");
  expect(result.response.json()).toMatchObject({ code, requestId: result.requestId, status });
  expect(Object.keys(result.response.json())).toHaveLength(7);
}
async function proofCounts() {
  const result = await governed((client) =>
    client.query<{ evidence: number; nonBillable: number; outbox: number; settings: number }>(
      `SELECT
         (SELECT count(*)::integer FROM evidence_events WHERE tenant_id=$1 AND subject_type LIKE 'hr.timesheet.service_control%') evidence,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1 AND aggregate_type='hr.timesheet.service_control') outbox,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1 AND aggregate_type='hr.timesheet.service_control' AND payload->>'billingState'='non_billable') "nonBillable",
         (SELECT count(*)::integer FROM tenant_settings WHERE tenant_id=$1 AND setting_key LIKE 'hr.timesheet.%') settings`,
      [ids.tenant],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error("Timesheet proof counts are unavailable");
  return row;
}
beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL Timesheet API harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings,hr_timesheet_service_control TO ${applicationRole};
     GRANT SELECT,INSERT,UPDATE ON service_activations TO ${applicationRole}; GRANT SELECT,INSERT ON evidence_events,outbox_events TO ${applicationRole}`,
  );
  pool = createDatabasePool(runtimeUrl, { max: 6 });
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Timesheet Tenant'),($2,'Other Timesheet Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Timesheet Administrator'),($2,'Timesheet Employee'),($3,'Other Timesheet Administrator')`,
    [ids.admin, ids.employee, ids.otherAdmin],
  );
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, ids.tenant, ids.admin, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key) VALUES ($1,$2,$3,'tenant_admin'),($4,$2,$5,'employee')`,
        [ids.adminMembership, ids.tenant, ids.admin, ids.employeeMembership, ids.employee],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.timesheet.activate_service'),($1,$2,'hr.timesheet.configure_service'),($1,$2,'hr.timesheet.deactivate_service'),($1,$2,'hr.timesheet.view_service_control')`,
        [ids.tenant, ids.admin],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version) VALUES ($1,'workforce_profile','active',1),($1,'workspace.task','active',1)`,
        [ids.tenant],
      );
    });
    await tenantTransaction(client, ids.otherTenant, ids.otherAdmin, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key) VALUES ($1,$2,$3,'tenant_admin')`,
        [ids.otherAdminMembership, ids.otherTenant, ids.otherAdmin],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version) VALUES ($1,'workforce_profile','active',1)`,
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
describe("Timesheet service-control API", () => {
  it("fails activation until eligible and returns only registered control state", async () => {
    expectProblem(await signedGet(controlUrl), 404, "TIMESHEET_SERVICE_CONTROL_NOT_FOUND");
    const before = await proofCounts();
    const blocked = await mutate("activate", { expectedVersion: null });
    expectProblem(blocked, 503, "ACTIVATION_DEPENDENCY_BLOCKED");
    await expectActivationBlocked(domainActivate("non_production", null), ["service_not_eligible"]);
    expect(await proofCounts()).toEqual(before);
    await setActivation("timesheet", "active", 1);
    const current = await signedGet(controlUrl);
    expect(current.response.statusCode, current.response.body).toBe(200);
    expect(current.response.json()).toEqual({
      activationState: "active",
      activationVersion: 1,
      serviceKey: "timesheet",
      settings: {
        maxDailyMinutes: 1440,
        periodCadence: "weekly",
        rejectionNoteRequired: true,
      },
      settingsVersion: 1,
      updatedAt: expect.any(String),
      version: 1,
    });
    expect(current.response.headers["x-esbla-timesheet-actions"]).toBe(
      '["activate_service","configure_service","deactivate_service","view_service_control"]',
    );
  });
  it("configures one exact bounded replacement with deterministic replay", async () => {
    const before = await proofCounts();
    const key = randomUUID();
    const body = {
      expectedSettingsVersion: 1,
      settings: {
        maxDailyMinutes: 720,
        periodCadence: "weekly",
        rejectionNoteRequired: false,
      },
    };
    const first = await mutate("settings", body, key);
    expect(first.response.statusCode, first.response.body).toBe(200);
    expect(first.response.headers["idempotent-replayed"]).toBe("false");
    expect(first.response.json()).toMatchObject({
      activationState: "active",
      settings: body.settings,
      settingsVersion: 2,
      version: 2,
    });
    const replay = await mutate("settings", body, key);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(first.response.json());
    expect(await proofCounts()).toEqual({
      evidence: before.evidence + 1,
      nonBillable: before.nonBillable + 1,
      outbox: before.outbox + 1,
      settings: 3,
    });
    const conflict = await mutate(
      "settings",
      { ...body, settings: { ...body.settings, maxDailyMinutes: 1440 } },
      key,
    );
    expectProblem(conflict, 409, "IDEMPOTENCY_CONFLICT");
    for (const settings of [
      { ...body.settings, maxDailyMinutes: 0 },
      { ...body.settings, periodCadence: "monthly" },
      { ...body.settings, rejectionNoteRequired: "false" },
      { ...body.settings, projectRequired: true },
    ]) {
      const invalid = await mutate("settings", { expectedSettingsVersion: 2, settings });
      expectProblem(invalid, 400, "REQUEST_VALIDATION_FAILED");
    }
  });
  it("fails closed for stale authority, other tenants, inactivity and production retention", async () => {
    const before = await proofCounts();
    await setAdminRole("employee");
    expectProblem(await signedGet(controlUrl), 403, "POLICY_DENIED");
    await setAdminRole("tenant_admin");
    expectProblem(
      await signedGet(controlUrl, ids.otherAdmin, ids.otherTenant),
      403,
      "POLICY_DENIED",
    );
    expect(await proofCounts()).toEqual(before);
    const stopped = await mutate("deactivate", { expectedVersion: 1 });
    expect(stopped.response.statusCode, stopped.response.body).toBe(200);
    expect(stopped.response.json()).toMatchObject({
      activationState: "inactive",
      activationVersion: 2,
      settingsVersion: 2,
      version: 3,
    });
    const inactiveSettings = await mutate("settings", {
      expectedSettingsVersion: 2,
      settings: stopped.response.json().settings,
    });
    expectProblem(inactiveSettings, 503, "TIMESHEET_SERVICE_INACTIVE");
    await setActivation("workspace.task", "inactive", 2);
    expectProblem(
      await mutate("activate", { expectedVersion: 2 }),
      503,
      "TIMESHEET_DEPENDENCY_INACTIVE",
    );
    await setActivation("workspace.task", "active", 3);
    const ownerRuntime = createDatabasePool(process.env.DATABASE_MIGRATION_URL ?? "", { max: 2 });
    try {
      await expectActivationBlocked(domainActivate("non_production", 2, ownerRuntime), [
        "runtime_projection_privileges_not_current",
      ]);
    } finally {
      await ownerRuntime.end();
    }
    for (const [setup, cleanup] of [
      [
        "ALTER TABLE workspace_tasks DISABLE TRIGGER workspace_tasks_enforce_state",
        "ALTER TABLE workspace_tasks ENABLE TRIGGER workspace_tasks_enforce_state",
      ],
      [
        "ALTER TABLE evidence_events DISABLE TRIGGER evidence_events_protect_hr_timesheet_retention",
        "ALTER TABLE evidence_events ENABLE TRIGGER evidence_events_protect_hr_timesheet_retention",
      ],
      [
        "CREATE POLICY workspace_tasks_permissive_bypass ON workspace_tasks FOR ALL USING (true) WITH CHECK (true)",
        "DROP POLICY workspace_tasks_permissive_bypass ON workspace_tasks",
      ],
      [
        "CREATE FUNCTION public.esbla_test_rewrite_timesheet_retention() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS 'BEGIN NEW.subject_type=''hr.timesheet.retention_qualification''; NEW.subject_id=''ce2de1f7-f65d-5c50-af5b-37638a593e95''; NEW.event_type=''hr.timesheet.retention.qualified''; NEW.prior_state=NULL; NEW.new_state=''qualified''; RETURN NEW; END'; CREATE TRIGGER zzz_timesheet_retention_rewrite BEFORE INSERT ON evidence_events FOR EACH ROW EXECUTE FUNCTION public.esbla_test_rewrite_timesheet_retention()",
        "DROP TRIGGER zzz_timesheet_retention_rewrite ON evidence_events; DROP FUNCTION public.esbla_test_rewrite_timesheet_retention()",
      ],
    ] as const) {
      await migrationPool.query(setup);
      try {
        await expectActivationBlocked(domainActivate("non_production", 2), [
          "service_not_eligible",
          "non_soft_dependency_not_eligible",
        ]);
      } finally {
        await migrationPool.query(cleanup);
      }
    }
    const production = createServer({
      authenticate: createDevelopmentAuthenticator({ secret }),
      logger: false,
      migrationReadPool: migrationPool,
      pool,
      runtimeEnvironment: "production",
    });
    await production.ready();
    try {
      const missing = await mutate("activate", { expectedVersion: 2 }, randomUUID(), {
        target: production,
      });
      expectProblem(missing, 503, "ACTIVATION_DEPENDENCY_BLOCKED");
      await expectActivationBlocked(domainActivate("production", 2), [
        "service_not_eligible",
        "qualified_retention_evidence_unavailable",
      ]);
      const app = await pool.connect();
      try {
        await expect(
          tenantTransaction(app, ids.tenant, ids.admin, (client) =>
            client.query(retentionInsert, [ids.tenant, ids.admin, randomUUID()]),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        app.release();
      }
      await governed((client) =>
        client.query(retentionInsert, [ids.tenant, ids.admin, randomUUID()]),
      );
      await expectActivationBlocked(domainActivate("production", 2), ["service_not_eligible"]);
    } finally {
      await production.close();
    }
    const activation = await governed((client) =>
      client.query(
        "SELECT state,version FROM service_activations WHERE tenant_id=$1 AND service_key='timesheet'",
        [ids.tenant],
      ),
    );
    expect(activation.rows[0]).toEqual({ state: "inactive", version: 2 });
  });
});
