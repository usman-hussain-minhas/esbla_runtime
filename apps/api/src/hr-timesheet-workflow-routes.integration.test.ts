import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const secret = "esbla-timesheet-employee-workflow-integration-secret-v1";
const ids = {
  employee: "b1000000-0000-4000-8000-000000000001",
  employeeMembership: "b2000000-0000-4000-8000-000000000001",
  manager: "b1000000-0000-4000-8000-000000000002",
  managerMembership: "b2000000-0000-4000-8000-000000000002",
  operator: "b1000000-0000-4000-8000-000000000003",
  operatorMembership: "b2000000-0000-4000-8000-000000000003",
  otherEmployee: "b1000000-0000-4000-8000-000000000004",
  otherMembership: "b2000000-0000-4000-8000-000000000004",
  otherTenant: "b3000000-0000-4000-8000-000000000002",
  tenant: "b3000000-0000-4000-8000-000000000001",
} as const;

interface SignedMutation {
  readonly body: NonNullable<InjectOptions["payload"]>;
  readonly idempotencyKey: string;
  readonly method: "PATCH" | "POST";
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly url: string;
}

let applicationRole = "";
let migrationPool: Pool;
let pool: Pool;
let server: FastifyInstance;
let timesheetId = "";
let timesheetVersionId = "";
let workerProfileId = "";

async function governed<T>(
  tenantId: string,
  actorPrincipalId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
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
  } finally {
    client.release();
  }
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
  const profileId = created.rows[0]?.worker_profile_id ?? "";
  await client.query(
    "UPDATE hr_worker_profiles SET principal_id=$3,row_version=2 WHERE tenant_id=$1 AND worker_profile_id=$2",
    [tenantId, profileId, principalId],
  );
  await client.query(
    "UPDATE hr_worker_profiles SET workforce_status='active',row_version=3 WHERE tenant_id=$1 AND worker_profile_id=$2",
    [tenantId, profileId],
  );
  return profileId;
}

async function signedMutation({
  body,
  idempotencyKey,
  method,
  principalId = ids.employee,
  tenantId = ids.tenant,
  url,
}: SignedMutation) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const headers = {
    "idempotency-key": idempotencyKey,
    "x-esbla-auth-signature": signDevelopmentPrincipal(secret, {
      body,
      idempotencyKey,
      method,
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
    response: await server.inject({ headers, method, payload: body, url }),
  };
}

async function mutation(
  body: SignedMutation["body"],
  idempotencyKey: string,
  method: SignedMutation["method"],
  url: string,
  principalId?: string,
  tenantId?: string,
) {
  return await signedMutation({
    body,
    idempotencyKey,
    method,
    ...(principalId ? { principalId } : {}),
    ...(tenantId ? { tenantId } : {}),
    url,
  });
}

async function serviceState(state: "active" | "inactive") {
  await governed(ids.tenant, ids.operator, (client) =>
    client.query(
      "UPDATE service_activations SET state=$2,version=version+1 WHERE tenant_id=$1 AND service_key='timesheet'",
      [ids.tenant, state],
    ),
  );
}

function byStatus<T extends { response: { statusCode: number } }>(results: T[], status: number): T {
  const selected = results.find(({ response }) => response.statusCode === status);
  if (!selected) throw new Error(`Expected HTTP ${status}`);
  return selected;
}

function expectProblem(
  result: Awaited<ReturnType<typeof signedMutation>>,
  status: number,
  code: string,
): void {
  expect(result.response.statusCode, result.response.body).toBe(status);
  expect(result.response.headers["content-type"]).toContain("application/problem+json");
  expect(result.response.json()).toMatchObject({ code, requestId: result.requestId, status });
  expect(Object.keys(result.response.json())).toHaveLength(7);
}

async function proofSnapshot() {
  return await governed(ids.tenant, ids.operator, async (client) => {
    const result = await client.query(
      `SELECT
         (SELECT count(*)::integer FROM hr_timesheets WHERE tenant_id=$1) roots,
         (SELECT count(*)::integer FROM hr_timesheet_versions WHERE tenant_id=$1) versions,
         (SELECT count(*)::integer FROM hr_timesheet_entries WHERE tenant_id=$1) entries,
         (SELECT count(*)::integer FROM work_items WHERE tenant_id=$1
            AND subject_type='hr.timesheet.version') work,
         (SELECT count(*)::integer FROM evidence_events WHERE tenant_id=$1
            AND event_type LIKE 'hr.timesheet.%') evidence,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1
            AND event_type LIKE 'hr.timesheet.%') outbox,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1
            AND event_type LIKE 'hr.timesheet.%' AND aggregate_type='hr.timesheet.version')
            version_subjects,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1
            AND event_type LIKE 'hr.timesheet.%' AND payload ? 'beforeVersion'
            AND payload ? 'afterVersion') versioned,
         (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1
            AND event_type LIKE 'hr.timesheet.%'
            AND payload->>'billingState'='non_billable') non_billable`,
      [ids.tenant],
    );
    return result.rows[0];
  });
}

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL Timesheet workflow harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings,hr_reporting_relationships TO ${applicationRole};
     GRANT SELECT,UPDATE ON hr_worker_profiles,service_activations TO ${applicationRole};
     GRANT SELECT,INSERT ON evidence_events,outbox_events,work_items TO ${applicationRole}`,
  );
  pool = createDatabasePool(runtimeUrl, { max: 8 });
  await migrationPool.query(
    "INSERT INTO tenants (tenant_id,name) VALUES ($1,'Timesheet Workflow'),($2,'Other Workflow')",
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Employee'),($2,'Manager'),($3,'Operator'),($4,'Other Employee')`,
    [ids.employee, ids.manager, ids.operator, ids.otherEmployee],
  );
  await governed(ids.tenant, ids.operator, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'employee'),($4,$2,$5,'manager'),($6,$2,$7,'hr_operator')`,
      [
        ids.employeeMembership,
        ids.tenant,
        ids.employee,
        ids.managerMembership,
        ids.manager,
        ids.operatorMembership,
        ids.operator,
      ],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
      [
        ids.tenant,
        ids.employee,
        ["hr.timesheet.create", "hr.timesheet.edit_draft", "hr.timesheet.submit"],
      ],
    );
    await client.query(
      "INSERT INTO tenant_settings (tenant_id,setting_key,value_type,value) VALUES ($1,'hr.timesheet.max_daily_minutes','integer','300')",
      [ids.tenant],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),($1,'timesheet','active',1)`,
      [ids.tenant],
    );
    workerProfileId = await activeProfile(client, ids.tenant, ids.employee);
    const managerProfileId = await activeProfile(client, ids.tenant, ids.manager);
    const relationship = await client.query<{ reporting_relationship_id: string }>(
      `INSERT INTO hr_reporting_relationships
         (tenant_id,worker_profile_id,manager_worker_profile_id,relationship_status,relationship_version)
       VALUES ($1,$2,$3,'assigned',1) RETURNING reporting_relationship_id::text`,
      [ids.tenant, workerProfileId, managerProfileId],
    );
    await client.query(
      `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3,row_version=4
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId, relationship.rows[0]?.reporting_relationship_id],
    );
  });
  await governed(ids.otherTenant, ids.otherEmployee, async (client) => {
    await client.query(
      "INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key) VALUES ($1,$2,$3,'employee')",
      [ids.otherMembership, ids.otherTenant, ids.otherEmployee],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'hr.timesheet.edit_draft')`,
      [ids.otherTenant, ids.otherEmployee],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),($1,'timesheet','active',1)`,
      [ids.otherTenant],
    );
    await activeProfile(client, ids.otherTenant, ids.otherEmployee);
  });
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

describe("Timesheet employee workflow API", () => {
  it("creates, edits, and submits one weekly draft with exact replay and atomic proof", async () => {
    const createBody = { periodEnd: "2028-08-07", periodStart: "2028-08-01" };
    const createKey = randomUUID();
    const attempts = await Promise.all([
      mutation(createBody, createKey, "POST", "/v1/hr/timesheets"),
      mutation(createBody, createKey, "POST", "/v1/hr/timesheets"),
    ]);
    const created = byStatus(attempts, 201);
    byStatus(attempts, 200);
    const draft = created.response.json();
    timesheetId = draft.timesheetId;
    timesheetVersionId = draft.currentVersion.timesheetVersionId;
    expectProblem(
      await mutation(
        { periodEnd: "2028-08-14", periodStart: "2028-08-08" },
        createKey,
        "POST",
        "/v1/hr/timesheets",
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );

    const editBody = {
      entries: [
        { description: "Customer support", entryDate: "2028-08-01", minutes: 240 },
        { description: null, entryDate: "2028-08-02", minutes: 300 },
      ],
      expectedRootVersion: 1,
      expectedTimesheetVersionId: draft.currentVersion.timesheetVersionId,
      expectedVersion: 1,
    };
    let editKey = randomUUID();
    const competingEditKey = randomUUID();
    const editUrl = `/v1/hr/timesheets/${draft.timesheetId}/draft`;
    expectProblem(
      await mutation(
        { ...editBody, entries: [{ entryDate: "2028-08-01", minutes: 301 }] },
        randomUUID(),
        "PATCH",
        editUrl,
      ),
      400,
      "TIMESHEET_INPUT_INVALID",
    );
    const edits = await Promise.all([
      mutation(editBody, editKey, "PATCH", editUrl),
      mutation(editBody, competingEditKey, "PATCH", editUrl),
    ]);
    const edited = byStatus(edits, 200);
    if (edits[1]?.response.statusCode === 200) editKey = competingEditKey;
    expect(edited.response.json()).toMatchObject({
      currentVersion: { rowVersion: 2, status: "draft", totalMinutes: 540 },
      rootVersion: 1,
    });
    expectProblem(byStatus(edits, 409), 409, "TIMESHEET_VERSION_CONFLICT");

    const submitBody = {
      expectedRootVersion: 1,
      expectedTimesheetVersionId: draft.currentVersion.timesheetVersionId,
      expectedVersion: 2,
    };
    await governed(ids.tenant, ids.operator, (client) =>
      client.query("UPDATE memberships SET role_key='employee' WHERE principal_id=$1", [
        ids.manager,
      ]),
    );
    expectProblem(
      await mutation(
        submitBody,
        randomUUID(),
        "POST",
        `/v1/hr/timesheets/${draft.timesheetId}/submit`,
      ),
      422,
      "TIMESHEET_APPROVER_UNAVAILABLE",
    );
    await governed(ids.tenant, ids.operator, (client) =>
      client.query("UPDATE memberships SET role_key='manager' WHERE principal_id=$1", [
        ids.manager,
      ]),
    );
    await migrationPool.query(`REVOKE INSERT ON work_items FROM ${applicationRole}`);
    try {
      const failed = await mutation(
        submitBody,
        randomUUID(),
        "POST",
        `/v1/hr/timesheets/${draft.timesheetId}/submit`,
      );
      expectProblem(failed, 403, "POLICY_DENIED");
      expect(await proofSnapshot()).toMatchObject({
        entries: 2,
        evidence: 4,
        outbox: 2,
        roots: 1,
        versions: 1,
        work: 0,
      });
    } finally {
      await migrationPool.query(`GRANT INSERT ON work_items TO ${applicationRole}`);
    }
    let submitKey = randomUUID();
    const competingSubmitKey = randomUUID();
    const submitUrl = `/v1/hr/timesheets/${draft.timesheetId}/submit`;
    const submits = await Promise.all([
      mutation(submitBody, submitKey, "POST", submitUrl),
      mutation(submitBody, competingSubmitKey, "POST", submitUrl),
    ]);
    const submitted = byStatus(submits, 200);
    if (submits[1]?.response.statusCode === 200) submitKey = competingSubmitKey;
    expectProblem(byStatus(submits, 409), 409, "TIMESHEET_VERSION_CONFLICT");
    expect(submitted.response.json().currentVersion.status).toBe("submitted");
    for (const [body, key, method, url, expected] of [
      [createBody, createKey, "POST", "/v1/hr/timesheets", draft],
      [editBody, editKey, "PATCH", editUrl, edited.response.json()],
      [submitBody, submitKey, "POST", submitUrl, submitted.response.json()],
    ] as const) {
      const retried = await mutation(body, key, method, url);
      expect(retried.response.statusCode, retried.response.body).toBe(200);
      expect(retried.response.headers["idempotent-replayed"]).toBe("true");
      expect(retried.response.json()).toEqual(expected);
    }
    expect(await proofSnapshot()).toEqual({
      entries: 2,
      evidence: 6,
      non_billable: 3,
      outbox: 3,
      roots: 1,
      version_subjects: 3,
      versioned: 3,
      versions: 1,
      work: 1,
    });
  });

  it("fails closed for unauthorized, inactive, stale, and cross-tenant requests", async () => {
    const before = await proofSnapshot();
    expectProblem(
      await mutation(
        {
          entries: [],
          expectedRootVersion: 1,
          expectedTimesheetVersionId: timesheetVersionId,
          expectedVersion: 1,
        },
        randomUUID(),
        "PATCH",
        `/v1/hr/timesheets/${timesheetId}/draft`,
        ids.otherEmployee,
        ids.otherTenant,
      ),
      404,
      "TIMESHEET_NOT_FOUND",
    );
    await serviceState("inactive");
    try {
      expectProblem(
        await mutation(
          { periodEnd: "2028-08-14", periodStart: "2028-08-08" },
          randomUUID(),
          "POST",
          "/v1/hr/timesheets",
        ),
        503,
        "TIMESHEET_SERVICE_INACTIVE",
      );
    } finally {
      await serviceState("active");
    }
    expect(await proofSnapshot()).toEqual(before);
  });
});
