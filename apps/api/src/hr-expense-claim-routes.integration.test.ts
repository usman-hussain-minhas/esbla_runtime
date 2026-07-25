import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { activateExpenseClaimService } from "@esbla/hr";
import { workspaceManifest } from "@esbla/workspace";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const secret = "esbla-expense-service-control-integration-secret-v1";
const ids = {
  admin: "aa000000-0000-4000-8000-000000000001",
  adminMembership: "ab000000-0000-4000-8000-000000000001",
  employee: "aa000000-0000-4000-8000-000000000002",
  employeeMembership: "ab000000-0000-4000-8000-000000000002",
  manager: "aa000000-0000-4000-8000-000000000004",
  managerMembership: "ab000000-0000-4000-8000-000000000004",
  otherAdmin: "aa000000-0000-4000-8000-000000000003",
  otherAdminMembership: "ab000000-0000-4000-8000-000000000003",
  otherEmployee: "aa000000-0000-4000-8000-000000000005",
  otherEmployeeMembership: "ab000000-0000-4000-8000-000000000005",
  otherTenant: "ac000000-0000-4000-8000-000000000002",
  tenant: "ac000000-0000-4000-8000-000000000001",
  unassignedManager: "aa000000-0000-4000-8000-000000000006",
  unassignedManagerMembership: "ab000000-0000-4000-8000-000000000006",
} as const;
const controlUrl = "/v1/hr/expense-claims/service-control";
const retentionInsert = `INSERT INTO evidence_events
 (tenant_id,event_type,subject_type,subject_id,actor_principal_id,correlation_id,prior_state,new_state)
 VALUES ($1,'hr.expense.retention.qualified','hr.expense.retention_qualification','3f0ee29f-3b49-4749-98b0-42d06bd52d66',$2,$3,NULL,'qualified')`;
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
let managerProfileId = "";
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
async function governed<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await migrationPool.connect();
  try {
    return await tenantTransaction(client, ids.tenant, ids.admin, operation);
  } finally {
    client.release();
  }
}
async function governedOther<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await migrationPool.connect();
  try {
    return await tenantTransaction(client, ids.otherTenant, ids.otherAdmin, operation);
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
async function activeProfile(
  client: PoolClient,
  tenantId: string,
  principalId: string,
): Promise<string> {
  const created = await client.query<{ worker_profile_id: string }>(
    "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id::text",
    [tenantId],
  );
  const workerProfileId = created.rows[0]?.worker_profile_id;
  if (!workerProfileId) throw new Error("Expense Claim worker profile creation failed");
  await client.query(
    `UPDATE hr_worker_profiles
     SET principal_id=$3,row_version=2
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, workerProfileId, principalId],
  );
  await client.query(
    `UPDATE hr_worker_profiles
     SET workforce_status='active',row_version=3
     WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, workerProfileId],
  );
  return workerProfileId;
}
function domainActivate(
  mode: "non_production" | "production",
  expectedVersion: number | null,
  runtimePool = pool,
) {
  return activateExpenseClaimService(
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
async function claimMutation(
  method: "PATCH" | "POST",
  url: string,
  body: Record<string, unknown>,
  idempotencyKey = randomUUID(),
  principalId: string = ids.employee,
  tenantId: string = ids.tenant,
) {
  return signedRequest({
    body,
    idempotencyKey,
    method,
    principalId,
    tenantId,
    url,
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
         (SELECT count(*)::integer FROM evidence_events WHERE tenant_id=$1 AND subject_type LIKE 'hr.expense.service_control%') evidence,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1 AND aggregate_type='hr.expense.service_control') outbox,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1 AND aggregate_type='hr.expense.service_control' AND payload->>'billingState'='non_billable') "nonBillable",
         (SELECT count(*)::integer FROM tenant_settings WHERE tenant_id=$1 AND setting_key LIKE 'hr.expense.%') settings`,
      [ids.tenant],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error("Expense Claim proof counts are unavailable");
  return row;
}
async function claimProofCounts() {
  const result = await governed((client) =>
    client.query<{
      approvals: number;
      completedWork: number;
      evidence: number;
      forbidden: number;
      lines: number;
      nonBillable: number;
      openWork: number;
      outbox: number;
      roots: number;
      versions: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM hr_expense_claims WHERE tenant_id=$1) roots,
         (SELECT count(*)::integer FROM hr_expense_claim_versions WHERE tenant_id=$1) versions,
         (SELECT count(*)::integer FROM hr_expense_claim_lines WHERE tenant_id=$1) lines,
         (SELECT count(*)::integer FROM hr_expense_claim_approvals WHERE tenant_id=$1) approvals,
         (SELECT count(*)::integer FROM work_items WHERE tenant_id=$1
            AND work_type='hr.expense.approval' AND status='open') "openWork",
         (SELECT count(*)::integer FROM work_items WHERE tenant_id=$1
            AND work_type='hr.expense.approval' AND status='completed') "completedWork",
         (SELECT count(*)::integer FROM evidence_events WHERE tenant_id=$1
            AND (subject_type='hr.expense.version' OR subject_type='hr.expense.idempotency')) evidence,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1
            AND aggregate_type='hr.expense.version') outbox,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1
            AND aggregate_type='hr.expense.version'
            AND payload->>'billingState'='non_billable') "nonBillable",
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1
            AND aggregate_type='hr.expense.version'
            AND payload::text ~* '(receipt[_-]?url|attachment|reimburse|settle|payment|finance|tax)') forbidden`,
      [ids.tenant],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error("Expense Claim lifecycle proof counts are unavailable");
  return row;
}
beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL Expense Claim API harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings,hr_expense_claim_service_control,hr_reporting_relationships TO ${applicationRole};
     GRANT SELECT,UPDATE ON hr_worker_profiles,service_activations TO ${applicationRole};
     GRANT SELECT,INSERT,UPDATE,DELETE ON hr_expense_claims,hr_expense_claim_versions,hr_expense_claim_lines TO ${applicationRole};
     GRANT SELECT,INSERT ON hr_expense_claim_approvals TO ${applicationRole};
     GRANT SELECT,INSERT ON evidence_events,outbox_events TO ${applicationRole};
     GRANT SELECT,INSERT,UPDATE ON work_items TO ${applicationRole}`,
  );
  pool = createDatabasePool(runtimeUrl, { max: 6 });
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Expense Claim Service Tenant'),($2,'Other Expense Claim Service Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Expense Claim Service Administrator'),($2,'Expense Claim Service Employee'),
            ($3,'Other Expense Claim Service Administrator'),($4,'Expense Claim Manager'),
            ($5,'Other Expense Claim Employee'),($6,'Unassigned Expense Claim Manager')`,
    [
      ids.admin,
      ids.employee,
      ids.otherAdmin,
      ids.manager,
      ids.otherEmployee,
      ids.unassignedManager,
    ],
  );
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, ids.tenant, ids.admin, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'tenant_admin'),($4,$2,$5,'employee'),($6,$2,$7,'manager'),
                ($8,$2,$9,'manager')`,
        [
          ids.adminMembership,
          ids.tenant,
          ids.admin,
          ids.employeeMembership,
          ids.employee,
          ids.managerMembership,
          ids.manager,
          ids.unassignedManagerMembership,
          ids.unassignedManager,
        ],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.expense.activate_service'),($1,$2,'hr.expense.configure_service'),($1,$2,'hr.expense.deactivate_service'),($1,$2,'hr.expense.view_service_control')`,
        [ids.tenant, ids.admin],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.expense.create'),($1,$2,'hr.expense.edit_draft'),
                ($1,$2,'hr.expense.submit')`,
        [ids.tenant, ids.employee],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.expense.approve'),($1,$2,'hr.expense.reject'),
                ($1,$3,'hr.expense.approve'),($1,$3,'hr.expense.reject')`,
        [ids.tenant, ids.manager, ids.unassignedManager],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version) VALUES ($1,'workforce_profile','active',1),($1,'workspace.task','active',1)`,
        [ids.tenant],
      );
      workerProfileId = await activeProfile(tenantClient, ids.tenant, ids.employee);
      managerProfileId = await activeProfile(tenantClient, ids.tenant, ids.manager);
      await activeProfile(tenantClient, ids.tenant, ids.unassignedManager);
      const relationship = await tenantClient.query<{ reporting_relationship_id: string }>(
        `INSERT INTO hr_reporting_relationships
           (tenant_id,worker_profile_id,manager_worker_profile_id,
            relationship_status,relationship_version)
         VALUES ($1,$2,$3,'assigned',1) RETURNING reporting_relationship_id::text`,
        [ids.tenant, workerProfileId, managerProfileId],
      );
      await tenantClient.query(
        `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3,row_version=4
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, workerProfileId, relationship.rows[0]?.reporting_relationship_id],
      );
    });
    await tenantTransaction(client, ids.otherTenant, ids.otherAdmin, async (tenantClient) => {
      await tenantClient.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'tenant_admin'),($4,$2,$5,'employee')`,
        [
          ids.otherAdminMembership,
          ids.otherTenant,
          ids.otherAdmin,
          ids.otherEmployeeMembership,
          ids.otherEmployee,
        ],
      );
      await tenantClient.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.expense.edit_draft')`,
        [ids.otherTenant, ids.otherEmployee],
      );
      await tenantClient.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),
                ($1,'workspace.task','active',1),
                ($1,'expense_claim_boundary','active',1)`,
        [ids.otherTenant],
      );
      await activeProfile(tenantClient, ids.otherTenant, ids.otherEmployee);
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
describe("Expense Claim service-control API", () => {
  it("fails activation until eligible and returns only registered control state", async () => {
    expectProblem(await signedGet(controlUrl), 404, "EXPENSE_SERVICE_CONTROL_NOT_FOUND");
    const before = await proofCounts();
    const blocked = await mutate("activate", { expectedVersion: null });
    expectProblem(blocked, 503, "ACTIVATION_DEPENDENCY_BLOCKED");
    await expectActivationBlocked(domainActivate("non_production", null), ["service_not_eligible"]);
    expect(await proofCounts()).toEqual(before);
    await setActivation("expense_claim_boundary", "active", 1);
    const current = await signedGet(controlUrl);
    expect(current.response.statusCode, current.response.body).toBe(200);
    expect(current.response.json()).toEqual({
      activationState: "active",
      activationVersion: 1,
      serviceKey: "expense_claim_boundary",
      settings: {
        categoryCodes: "other",
        rejectionNoteRequired: true,
      },
      settingsVersion: 1,
      updatedAt: expect.any(String),
      version: 1,
    });
    expect(current.response.headers["x-esbla-expense-actions"]).toBe(
      '["activate_service","configure_service","deactivate_service","view_service_control"]',
    );
  });
  it("configures one exact bounded replacement with deterministic replay", async () => {
    const before = await proofCounts();
    const key = randomUUID();
    const body = {
      expectedSettingsVersion: 1,
      settings: {
        categoryCodes: "other,travel",
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
      settings: 2,
    });
    const conflict = await mutate(
      "settings",
      { ...body, settings: { ...body.settings, categoryCodes: "other" } },
      key,
    );
    expectProblem(conflict, 409, "IDEMPOTENCY_CONFLICT");
    for (const settings of [
      { ...body.settings, categoryCodes: "" },
      { ...body.settings, categoryCodes: "other,other" },
      { ...body.settings, categoryCodes: "other, travel" },
      { ...body.settings, rejectionNoteRequired: "false" },
      { ...body.settings, taxCategory: true },
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
    expectProblem(inactiveSettings, 503, "EXPENSE_SERVICE_INACTIVE");
    await setActivation("workspace.task", "inactive", 2);
    expectProblem(
      await mutate("activate", { expectedVersion: 2 }),
      503,
      "EXPENSE_DEPENDENCY_INACTIVE",
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
        "CREATE FUNCTION public.esbla_test_rewrite_expense_retention() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS 'BEGIN NEW.subject_type=''hr.expense.retention_qualification''; NEW.subject_id=''ce2de1f7-f65d-5c50-af5b-37638a593e95''; NEW.event_type=''hr.expense.retention.qualified''; NEW.prior_state=NULL; NEW.new_state=''qualified''; RETURN NEW; END'; CREATE TRIGGER zzz_expense_retention_rewrite BEFORE INSERT ON evidence_events FOR EACH ROW EXECUTE FUNCTION public.esbla_test_rewrite_expense_retention()",
        "DROP TRIGGER zzz_expense_retention_rewrite ON evidence_events; DROP FUNCTION public.esbla_test_rewrite_expense_retention()",
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
        "SELECT state,version FROM service_activations WHERE tenant_id=$1 AND service_key='expense_claim_boundary'",
        [ids.tenant],
      ),
    );
    expect(activation.rows[0]).toEqual({ state: "inactive", version: 2 });
  });
});

describe.sequential("Expense Claim employee lifecycle API", () => {
  it("creates, edits, submits and replays one atomic non-money claim while denial stays inert", async () => {
    await setActivation("expense_claim_boundary", "active", 3);
    await setActivation("workspace.task", "active", 3);
    await governed((client) =>
      client.query(
        `INSERT INTO tenant_settings (tenant_id,setting_key,value_type,value,version)
         VALUES ($1,'hr.expense.category_codes','text','"other,travel"'::jsonb,1)
         ON CONFLICT (tenant_id,setting_key)
         DO UPDATE SET value=EXCLUDED.value,version=tenant_settings.version+1`,
        [ids.tenant],
      ),
    );
    const before = await claimProofCounts();
    const createBody = { currencyCode: "PKR" };
    const createKey = randomUUID();
    const created = await claimMutation("POST", "/v1/hr/expense-claims", createBody, createKey);
    expect(created.response.statusCode, created.response.body).toBe(201);
    expect(created.response.headers["idempotent-replayed"]).toBe("false");
    const draft = created.response.json();
    expect(draft).toMatchObject({
      currentVersion: {
        assignedApproverWorkerProfileId: null,
        currencyCode: "PKR",
        lines: [],
        rowVersion: 1,
        status: "draft",
        submittedAt: null,
        totalAmountMinor: 0,
        version: 1,
      },
      rootVersion: 1,
      workerProfileId,
    });
    const replayedCreate = await claimMutation(
      "POST",
      "/v1/hr/expense-claims",
      createBody,
      createKey,
    );
    expect(replayedCreate.response.statusCode).toBe(200);
    expect(replayedCreate.response.headers["idempotent-replayed"]).toBe("true");
    expect(replayedCreate.response.json()).toEqual(draft);
    expectProblem(
      await claimMutation("POST", "/v1/hr/expense-claims", { currencyCode: "USD" }, createKey),
      409,
      "IDEMPOTENCY_CONFLICT",
    );

    const expenseClaimId = String(draft.expenseClaimId);
    const expenseClaimVersionId = String(draft.currentVersion.expenseClaimVersionId);
    const editBody = {
      expectedExpenseClaimVersionId: expenseClaimVersionId,
      expectedRootVersion: 1,
      expectedVersion: 1,
      lines: [
        {
          amountMinor: 12_500,
          categoryCode: "other",
          description: "Local transport",
          expenseDate: "2028-07-31",
        },
        {
          amountMinor: 7_500,
          categoryCode: "travel",
          expenseDate: "2028-08-01",
        },
      ],
    };
    const editKey = randomUUID();
    const edited = await claimMutation(
      "PATCH",
      `/v1/hr/expense-claims/${expenseClaimId}/draft`,
      editBody,
      editKey,
    );
    expect(edited.response.statusCode, edited.response.body).toBe(200);
    expect(edited.response.json().currentVersion).toMatchObject({
      rowVersion: 2,
      status: "draft",
      totalAmountMinor: 20_000,
    });
    expect(edited.response.json().currentVersion.lines).toHaveLength(2);
    const replayedEdit = await claimMutation(
      "PATCH",
      `/v1/hr/expense-claims/${expenseClaimId}/draft`,
      editBody,
      editKey,
    );
    expect(replayedEdit.response.headers["idempotent-replayed"]).toBe("true");
    expect(replayedEdit.response.json()).toEqual(edited.response.json());
    const beforeStale = await claimProofCounts();
    expectProblem(
      await claimMutation("PATCH", `/v1/hr/expense-claims/${expenseClaimId}/draft`, editBody),
      409,
      "EXPENSE_VERSION_CONFLICT",
    );
    expect(await claimProofCounts()).toEqual(beforeStale);

    const submitBody = {
      expectedExpenseClaimVersionId: expenseClaimVersionId,
      expectedRootVersion: 1,
      expectedVersion: 2,
    };
    const submitKey = randomUUID();
    const submitted = await claimMutation(
      "POST",
      `/v1/hr/expense-claims/${expenseClaimId}/submit`,
      submitBody,
      submitKey,
    );
    expect(submitted.response.statusCode, submitted.response.body).toBe(200);
    expect(submitted.response.json().currentVersion).toMatchObject({
      assignedApproverWorkerProfileId: managerProfileId,
      rowVersion: 3,
      status: "submitted",
      totalAmountMinor: 20_000,
    });
    const replayedSubmit = await claimMutation(
      "POST",
      `/v1/hr/expense-claims/${expenseClaimId}/submit`,
      submitBody,
      submitKey,
    );
    expect(replayedSubmit.response.headers["idempotent-replayed"]).toBe("true");
    expect(replayedSubmit.response.json()).toEqual(submitted.response.json());
    expect(await claimProofCounts()).toEqual({
      approvals: before.approvals,
      completedWork: before.completedWork,
      evidence: before.evidence + 6,
      forbidden: 0,
      lines: before.lines + 2,
      nonBillable: before.nonBillable + 3,
      openWork: before.openWork + 1,
      outbox: before.outbox + 3,
      roots: before.roots + 1,
      versions: before.versions + 1,
    });

    const beforeDenied = await claimProofCounts();
    await governed((client) =>
      client.query(
        "UPDATE memberships SET status='suspended' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenant, ids.employee],
      ),
    );
    expectProblem(
      await claimMutation("POST", "/v1/hr/expense-claims", createBody),
      403,
      "ACTOR_NOT_ACTIVE_MEMBER",
    );
    await governed((client) =>
      client.query(
        "UPDATE memberships SET status='active',role_key='tenant_admin' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenant, ids.employee],
      ),
    );
    expectProblem(
      await claimMutation("POST", "/v1/hr/expense-claims", createBody),
      403,
      "POLICY_DENIED",
    );
    await governed((client) =>
      client.query(
        "UPDATE memberships SET role_key='employee' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenant, ids.employee],
      ),
    );
    expectProblem(
      await claimMutation(
        "PATCH",
        `/v1/hr/expense-claims/${expenseClaimId}/draft`,
        editBody,
        randomUUID(),
        ids.otherEmployee,
        ids.otherTenant,
      ),
      404,
      "EXPENSE_NOT_FOUND",
    );
    await setActivation("workspace.task", "inactive", 4);
    expectProblem(
      await claimMutation("POST", "/v1/hr/expense-claims", createBody),
      503,
      "EXPENSE_DEPENDENCY_INACTIVE",
    );
    await setActivation("workspace.task", "active", 5);
    await setActivation("expense_claim_boundary", "inactive", 4);
    expectProblem(
      await claimMutation("POST", "/v1/hr/expense-claims", createBody),
      503,
      "EXPENSE_SERVICE_INACTIVE",
    );
    await setActivation("expense_claim_boundary", "active", 5);
    expect(await claimProofCounts()).toEqual(beforeDenied);
  });
});

describe.sequential("Expense Claim assigned-manager decision API", () => {
  it("approves or rejects exact assigned work while current authority and note policy fail closed", async () => {
    const createSubmitted = async (expenseDate: string) => {
      const created = await claimMutation("POST", "/v1/hr/expense-claims", {
        currencyCode: "PKR",
      });
      expect(created.response.statusCode, created.response.body).toBe(201);
      const draft = created.response.json();
      const expenseClaimId = String(draft.expenseClaimId);
      const expenseClaimVersionId = String(draft.currentVersion.expenseClaimVersionId);
      const edited = await claimMutation("PATCH", `/v1/hr/expense-claims/${expenseClaimId}/draft`, {
        expectedExpenseClaimVersionId: expenseClaimVersionId,
        expectedRootVersion: 1,
        expectedVersion: 1,
        lines: [{ amountMinor: 1_000, categoryCode: "other", expenseDate }],
      });
      expect(edited.response.statusCode, edited.response.body).toBe(200);
      const submitted = await claimMutation(
        "POST",
        `/v1/hr/expense-claims/${expenseClaimId}/submit`,
        {
          expectedExpenseClaimVersionId: expenseClaimVersionId,
          expectedRootVersion: 1,
          expectedVersion: 2,
        },
      );
      expect(submitted.response.statusCode, submitted.response.body).toBe(200);
      expect(submitted.response.json().currentVersion).toMatchObject({
        assignedApproverWorkerProfileId: managerProfileId,
        rowVersion: 3,
        status: "submitted",
      });
      return { expenseClaimId, expenseClaimVersionId };
    };

    const before = await claimProofCounts();
    const approveCandidate = await createSubmitted("2028-08-02");
    const rejectCandidate = await createSubmitted("2028-08-03");
    const expectedDecision = (expenseClaimVersionId: string) => ({
      expectedExpenseClaimVersionId: expenseClaimVersionId,
      expectedRootVersion: 1,
      expectedVersion: 3,
    });

    const approveBody = expectedDecision(approveCandidate.expenseClaimVersionId);
    const approveKey = randomUUID();
    const approved = await claimMutation(
      "POST",
      `/v1/hr/expense-claims/${approveCandidate.expenseClaimId}/approve`,
      approveBody,
      approveKey,
      ids.manager,
    );
    expect(approved.response.statusCode, approved.response.body).toBe(200);
    expect(approved.response.headers["idempotent-replayed"]).toBe("false");
    expect(approved.response.json().currentVersion).toMatchObject({
      rowVersion: 4,
      status: "approved",
    });
    const replayedApprove = await claimMutation(
      "POST",
      `/v1/hr/expense-claims/${approveCandidate.expenseClaimId}/approve`,
      approveBody,
      approveKey,
      ids.manager,
    );
    expect(replayedApprove.response.headers["idempotent-replayed"]).toBe("true");
    expect(replayedApprove.response.json()).toEqual(approved.response.json());

    const rejectBody = expectedDecision(rejectCandidate.expenseClaimVersionId);
    const beforeDenied = await claimProofCounts();
    expectProblem(
      await claimMutation(
        "POST",
        `/v1/hr/expense-claims/${rejectCandidate.expenseClaimId}/reject`,
        rejectBody,
        randomUUID(),
        ids.unassignedManager,
      ),
      403,
      "POLICY_DENIED",
    );
    expect(await claimProofCounts()).toEqual(beforeDenied);

    await governed((client) =>
      client.query(
        "UPDATE memberships SET role_key='employee' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenant, ids.manager],
      ),
    );
    expectProblem(
      await claimMutation(
        "POST",
        `/v1/hr/expense-claims/${rejectCandidate.expenseClaimId}/reject`,
        rejectBody,
        randomUUID(),
        ids.manager,
      ),
      403,
      "POLICY_DENIED",
    );
    await governed((client) =>
      client.query(
        "UPDATE memberships SET role_key='manager' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenant, ids.manager],
      ),
    );
    expect(await claimProofCounts()).toEqual(beforeDenied);

    await governed((client) =>
      client.query(
        `INSERT INTO tenant_settings (tenant_id,setting_key,value_type,value,version)
         VALUES ($1,'hr.expense.rejection_note_required','boolean','true'::jsonb,1)
         ON CONFLICT (tenant_id,setting_key)
         DO UPDATE SET value_type='boolean',value='true'::jsonb,
                       version=tenant_settings.version+1`,
        [ids.tenant],
      ),
    );
    expectProblem(
      await claimMutation(
        "POST",
        `/v1/hr/expense-claims/${rejectCandidate.expenseClaimId}/reject`,
        rejectBody,
        randomUUID(),
        ids.manager,
      ),
      400,
      "EXPENSE_INPUT_INVALID",
    );
    expect(await claimProofCounts()).toEqual(beforeDenied);
    await governed((client) =>
      client.query(
        `UPDATE tenant_settings SET value='false'::jsonb,version=version+1
         WHERE tenant_id=$1 AND setting_key='hr.expense.rejection_note_required'`,
        [ids.tenant],
      ),
    );
    const rejectKey = randomUUID();
    const rejected = await claimMutation(
      "POST",
      `/v1/hr/expense-claims/${rejectCandidate.expenseClaimId}/reject`,
      rejectBody,
      rejectKey,
      ids.manager,
    );
    expect(rejected.response.statusCode, rejected.response.body).toBe(200);
    expect(rejected.response.json().currentVersion).toMatchObject({
      rowVersion: 4,
      status: "rejected",
    });
    const replayedReject = await claimMutation(
      "POST",
      `/v1/hr/expense-claims/${rejectCandidate.expenseClaimId}/reject`,
      rejectBody,
      rejectKey,
      ids.manager,
    );
    expect(replayedReject.response.headers["idempotent-replayed"]).toBe("true");
    expect(replayedReject.response.json()).toEqual(rejected.response.json());

    await governedOther(async (client) => {
      await client.query(
        "UPDATE memberships SET role_key='manager' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.otherTenant, ids.otherEmployee],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.expense.approve')`,
        [ids.otherTenant, ids.otherEmployee],
      );
    });
    expectProblem(
      await claimMutation(
        "POST",
        `/v1/hr/expense-claims/${approveCandidate.expenseClaimId}/approve`,
        approveBody,
        randomUUID(),
        ids.otherEmployee,
        ids.otherTenant,
      ),
      404,
      "EXPENSE_NOT_FOUND",
    );
    expect(await claimProofCounts()).toEqual({
      approvals: before.approvals + 2,
      completedWork: before.completedWork + 2,
      evidence: before.evidence + 16,
      forbidden: 0,
      lines: before.lines + 2,
      nonBillable: before.nonBillable + 8,
      openWork: before.openWork,
      outbox: before.outbox + 8,
      roots: before.roots + 2,
      versions: before.versions + 2,
    });
  });
});
