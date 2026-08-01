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
let projectorPool: Pool;
let server: FastifyInstance;
let managerProfileId = "";
let timesheetId = "";
let timesheetVersionId = "";
let workerProfileId = "";

async function governed<T>(
  tenantId: string,
  actorPrincipalId: string,
  operation: (client: PoolClient) => Promise<T>,
  correlationId = randomUUID(),
): Promise<T> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true),
              set_config('app.actor_principal_id',$2,true),
              set_config('app.correlation_id',$3,true)`,
      [tenantId, actorPrincipalId, correlationId],
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

async function signedGet(
  url: string,
  principalId: string = ids.employee,
  tenantId: string = ids.tenant,
) {
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
  return { requestId, response: await server.inject({ headers, method: "GET", url }) };
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

async function submitWeeklyTimesheet(periodStart: string, periodEnd: string, entryDate: string) {
  const created = await mutation(
    { periodEnd, periodStart },
    randomUUID(),
    "POST",
    "/v1/hr/timesheets",
  );
  expect(created.response.statusCode, created.response.body).toBe(201);
  const draft = created.response.json();
  const url = `/v1/hr/timesheets/${draft.timesheetId}`;
  const edited = await mutation(
    {
      entries: [{ entryDate, minutes: 60 }],
      expectedRootVersion: 1,
      expectedTimesheetVersionId: draft.currentVersion.timesheetVersionId,
      expectedVersion: 1,
    },
    randomUUID(),
    "PATCH",
    `${url}/draft`,
  );
  expect(edited.response.statusCode, edited.response.body).toBe(200);
  const submitted = await mutation(
    {
      expectedRootVersion: 1,
      expectedTimesheetVersionId: draft.currentVersion.timesheetVersionId,
      expectedVersion: 2,
    },
    randomUUID(),
    "POST",
    `${url}/submit`,
  );
  expect(submitted.response.statusCode, submitted.response.body).toBe(200);
  return submitted.response.json();
}

async function proofSnapshot() {
  return await governed(ids.tenant, ids.operator, async (client) => {
    const result = await client.query(
      `SELECT
         (SELECT count(*)::integer FROM hr_timesheets WHERE tenant_id=$1) roots,
         (SELECT count(*)::integer FROM hr_timesheet_versions WHERE tenant_id=$1) versions,
         (SELECT count(*)::integer FROM hr_timesheet_entries WHERE tenant_id=$1) entries,
         (SELECT count(*)::integer FROM hr_timesheet_approvals WHERE tenant_id=$1) approvals,
         (SELECT count(*)::integer FROM work_items WHERE tenant_id=$1
            AND subject_type='hr.timesheet.version') work,
         (SELECT count(*)::integer FROM work_items WHERE tenant_id=$1
            AND subject_type='hr.timesheet.version' AND status='open') open_work,
         (SELECT count(*)::integer FROM work_items WHERE tenant_id=$1
            AND subject_type='hr.timesheet.version' AND status='completed') completed_work,
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

async function notificationIntents(targetResourceId: string) {
  const result = await projectorPool.query<{
    intent_payload: Record<string, unknown>;
    recipient_principal_id: string;
  }>(
    `SELECT intent_payload,recipient_principal_id::text
     FROM notification_intents
     WHERE tenant_id=$1 AND intent_payload->>'targetResourceId'=$2
     ORDER BY created_at,intent_id`,
    [ids.tenant, targetResourceId],
  );
  return result.rows;
}

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const projectorUrl = process.env.DATABASE_NOTIFICATION_PROJECTOR_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (
    !runtimeUrl ||
    !migrationUrl ||
    !projectorUrl ||
    !/^[a-z_][a-z0-9_]*$/.test(applicationRole)
  ) {
    throw new Error("PostgreSQL Timesheet workflow harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  projectorPool = createDatabasePool(projectorUrl, { max: 2 });
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings,hr_reporting_relationships TO ${applicationRole};
     GRANT SELECT,UPDATE ON hr_worker_profiles,service_activations TO ${applicationRole};
     GRANT SELECT,INSERT ON evidence_events,outbox_events TO ${applicationRole};
     GRANT SELECT,INSERT,UPDATE ON work_items TO ${applicationRole}`,
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
        [
          "hr.timesheet.create",
          "hr.timesheet.edit_draft",
          "hr.timesheet.list_own",
          "hr.timesheet.submit",
          "hr.timesheet.view_detail",
        ],
      ],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
      [
        ids.tenant,
        ids.manager,
        [
          "hr.timesheet.approve",
          "hr.timesheet.list_assigned",
          "hr.timesheet.reject",
          "hr.timesheet.view_detail",
        ],
      ],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
      [ids.tenant, ids.operator, ["hr.timesheet.create_correction", "hr.timesheet.view_detail"]],
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
    managerProfileId = await activeProfile(client, ids.tenant, ids.manager);
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
       SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
      [
        ids.otherTenant,
        ids.otherEmployee,
        ["hr.timesheet.edit_draft", "hr.timesheet.list_own", "hr.timesheet.view_detail"],
      ],
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
  await projectorPool?.end();
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
    expect(await notificationIntents(draft.timesheetId)).toEqual([]);

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
    const beforeNotificationFailure = await proofSnapshot();
    await migrationPool.query(`REVOKE INSERT ON notification_intents FROM ${applicationRole}`);
    try {
      expectProblem(
        await mutation(
          submitBody,
          randomUUID(),
          "POST",
          `/v1/hr/timesheets/${draft.timesheetId}/submit`,
        ),
        403,
        "POLICY_DENIED",
      );
      expect(await proofSnapshot()).toEqual(beforeNotificationFailure);
    } finally {
      await migrationPool.query(`GRANT INSERT ON notification_intents TO ${applicationRole}`);
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
    expect(await notificationIntents(draft.timesheetId)).toEqual([
      {
        intent_payload: {
          category: "hr.timesheet",
          safeSummary: "Open the timesheet for details.",
          targetHref: `/workspace/hr/timesheets/by-id/${draft.timesheetId}`,
          targetKind: "hr.timesheet.detail",
          targetReadCapabilityId: "hr.timesheet.view_detail",
          targetResourceId: draft.timesheetId,
          title: "A timesheet needs your review",
        },
        recipient_principal_id: ids.manager,
      },
    ]);
    expect(await proofSnapshot()).toEqual({
      approvals: 0,
      completed_work: 0,
      entries: 2,
      evidence: 6,
      non_billable: 3,
      open_work: 1,
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

  it("fails stale manager authority closed and records exactly one atomic terminal decision", async () => {
    const expected = {
      expectedRootVersion: 1,
      expectedTimesheetVersionId: timesheetVersionId,
      expectedVersion: 3,
    };
    const approve = { ...expected, decisionNote: "Reviewed" };
    const reject = { ...expected, decisionNote: "Needs correction" };
    const approveUrl = `/v1/hr/timesheets/${timesheetId}/approve`;
    const rejectUrl = `/v1/hr/timesheets/${timesheetId}/reject`;
    const before = await proofSnapshot();

    expectProblem(await mutation(approve, randomUUID(), "POST", approveUrl), 403, "POLICY_DENIED");
    await governed(ids.tenant, ids.operator, (client) =>
      client.query("UPDATE memberships SET role_key='employee' WHERE principal_id=$1", [
        ids.manager,
      ]),
    );
    try {
      expectProblem(
        await mutation(approve, randomUUID(), "POST", approveUrl, ids.manager),
        403,
        "POLICY_DENIED",
      );
    } finally {
      await governed(ids.tenant, ids.operator, (client) =>
        client.query("UPDATE memberships SET role_key='manager' WHERE principal_id=$1", [
          ids.manager,
        ]),
      );
    }
    await governed(ids.tenant, ids.operator, (client) =>
      client.query(
        `DELETE FROM membership_capabilities
         WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='hr.timesheet.approve'`,
        [ids.tenant, ids.manager],
      ),
    );
    try {
      expectProblem(
        await mutation(approve, randomUUID(), "POST", approveUrl, ids.manager),
        403,
        "POLICY_DENIED",
      );
    } finally {
      await governed(ids.tenant, ids.operator, (client) =>
        client.query(
          `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
           VALUES ($1,$2,'hr.timesheet.approve')`,
          [ids.tenant, ids.manager],
        ),
      );
    }
    await governed(ids.tenant, ids.operator, (client) =>
      client.query(
        `UPDATE work_items SET assignee_principal_id=$3
         WHERE tenant_id=$1 AND subject_type='hr.timesheet.version' AND subject_id=$2`,
        [ids.tenant, timesheetVersionId, ids.operator],
      ),
    );
    try {
      expectProblem(
        await mutation(approve, randomUUID(), "POST", approveUrl, ids.manager),
        403,
        "POLICY_DENIED",
      );
    } finally {
      await governed(ids.tenant, ids.operator, (client) =>
        client.query(
          `UPDATE work_items SET assignee_principal_id=$3
           WHERE tenant_id=$1 AND subject_type='hr.timesheet.version' AND subject_id=$2`,
          [ids.tenant, timesheetVersionId, ids.manager],
        ),
      );
    }
    expectProblem(
      await mutation(
        { ...expected, decisionNote: null },
        randomUUID(),
        "POST",
        rejectUrl,
        ids.manager,
      ),
      400,
      "TIMESHEET_INPUT_INVALID",
    );
    await migrationPool.query(`REVOKE UPDATE ON work_items FROM ${applicationRole}`);
    try {
      expectProblem(
        await mutation(approve, randomUUID(), "POST", approveUrl, ids.manager),
        403,
        "POLICY_DENIED",
      );
      expect(await proofSnapshot()).toEqual(before);
    } finally {
      await migrationPool.query(`GRANT UPDATE ON work_items TO ${applicationRole}`);
    }

    await migrationPool.query(`REVOKE INSERT ON notification_intents FROM ${applicationRole}`);
    try {
      expectProblem(
        await mutation(approve, randomUUID(), "POST", approveUrl, ids.manager),
        403,
        "POLICY_DENIED",
      );
      expect(await proofSnapshot()).toEqual(before);
    } finally {
      await migrationPool.query(`GRANT INSERT ON notification_intents TO ${applicationRole}`);
    }

    const approveKey = randomUUID();
    const rejectKey = randomUUID();
    const decisions = await Promise.all([
      mutation(approve, approveKey, "POST", approveUrl, ids.manager),
      mutation(reject, rejectKey, "POST", rejectUrl, ids.manager),
    ]);
    const decided = byStatus(decisions, 200);
    expectProblem(byStatus(decisions, 409), 409, "TIMESHEET_VERSION_CONFLICT");
    const winner =
      decided === decisions[0]
        ? { body: approve, key: approveKey, status: "approved", url: approveUrl }
        : { body: reject, key: rejectKey, status: "rejected", url: rejectUrl };
    expect(decided.response.json().currentVersion).toMatchObject({
      rowVersion: 4,
      status: winner.status,
    });
    await governed(ids.tenant, ids.operator, (client) =>
      client.query("UPDATE memberships SET role_key='employee' WHERE principal_id=$1", [
        ids.manager,
      ]),
    );
    try {
      expectProblem(
        await mutation(winner.body, winner.key, "POST", winner.url, ids.manager),
        403,
        "POLICY_DENIED",
      );
    } finally {
      await governed(ids.tenant, ids.operator, (client) =>
        client.query("UPDATE memberships SET role_key='manager' WHERE principal_id=$1", [
          ids.manager,
        ]),
      );
    }
    const replay = await mutation(winner.body, winner.key, "POST", winner.url, ids.manager);
    expect(replay.response.statusCode, replay.response.body).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(decided.response.json());
    expect(await notificationIntents(timesheetId)).toEqual([
      expect.objectContaining({
        intent_payload: expect.objectContaining({ title: "A timesheet needs your review" }),
        recipient_principal_id: ids.manager,
      }),
      {
        intent_payload: {
          category: "hr.timesheet",
          safeSummary: "Open the timesheet for details.",
          targetHref: `/workspace/hr/timesheets/by-id/${timesheetId}`,
          targetKind: "hr.timesheet.detail",
          targetReadCapabilityId: "hr.timesheet.view_detail",
          targetResourceId: timesheetId,
          title: `Your timesheet was ${winner.status}`,
        },
        recipient_principal_id: ids.employee,
      },
    ]);
    expect(await proofSnapshot()).toEqual({
      ...before,
      approvals: Number(before.approvals) + 1,
      completed_work: 1,
      evidence: Number(before.evidence) + 2,
      non_billable: Number(before.non_billable) + 1,
      open_work: 0,
      outbox: Number(before.outbox) + 1,
      version_subjects: Number(before.version_subjects) + 1,
      versioned: Number(before.versioned) + 1,
    });
    const approval = await governed(ids.tenant, ids.operator, async (client) => {
      const result = await client.query(
        `SELECT approver_worker_profile_id::text,decision,decision_note,correlation_id::text
         FROM hr_timesheet_approvals
         WHERE tenant_id=$1 AND timesheet_version_id=$2`,
        [ids.tenant, timesheetVersionId],
      );
      return result.rows;
    });
    expect(approval).toEqual([
      expect.objectContaining({
        approver_worker_profile_id: managerProfileId,
        correlation_id: winner.key,
        decision: winner.status,
        decision_note: winner.body.decisionNote,
      }),
    ]);
    const decisionProof = await governed(ids.tenant, ids.operator, async (client) => {
      const result = await client.query(
        `SELECT evidence.actor_principal_id::text,evidence.correlation_id::text,
                evidence.event_type,evidence.subject_id::text,evidence.subject_type,
                evidence.prior_state,evidence.new_state,
                outbox.aggregate_id::text,outbox.aggregate_type,outbox.aggregate_version,
                outbox.payload
         FROM evidence_events evidence JOIN outbox_events outbox
           ON outbox.tenant_id=evidence.tenant_id
          AND outbox.correlation_id=evidence.correlation_id
          AND outbox.event_type=evidence.event_type
          AND outbox.aggregate_id=evidence.subject_id
          AND outbox.aggregate_type=evidence.subject_type
         WHERE evidence.tenant_id=$1 AND evidence.event_type=$2
           AND evidence.subject_type='hr.timesheet.version'
           AND evidence.subject_id=$3`,
        [
          ids.tenant,
          `hr.timesheet.${winner.status === "approved" ? "approve" : "reject"}`,
          timesheetVersionId,
        ],
      );
      return result.rows;
    });
    expect(decisionProof).toEqual([
      expect.objectContaining({
        actor_principal_id: ids.manager,
        aggregate_id: timesheetVersionId,
        aggregate_type: "hr.timesheet.version",
        aggregate_version: 4,
        correlation_id: winner.key,
        event_type: `hr.timesheet.${winner.status === "approved" ? "approve" : "reject"}`,
        new_state: winner.status,
        payload: expect.objectContaining({
          action: winner.status === "approved" ? "approve" : "reject",
          afterVersion: 4,
          beforeVersion: 3,
          billingState: "non_billable",
          timesheetId,
        }),
        prior_state: "submitted",
        subject_id: timesheetVersionId,
        subject_type: "hr.timesheet.version",
      }),
    ]);
    await expect(
      governed(ids.tenant, ids.operator, (client) =>
        client.query(
          `UPDATE hr_timesheet_approvals SET decision_note='changed'
           WHERE tenant_id=$1 AND timesheet_version_id=$2`,
          [ids.tenant, timesheetVersionId],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      governed(ids.tenant, ids.operator, (client) =>
        client.query(
          "DELETE FROM hr_timesheet_approvals WHERE tenant_id=$1 AND timesheet_version_id=$2",
          [ids.tenant, timesheetVersionId],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await governed(ids.tenant, ids.operator, (client) =>
      client.query(
        `INSERT INTO tenant_settings (tenant_id,setting_key,value_type,value)
         VALUES ($1,'hr.timesheet.rejection_note_required','boolean','false')
         ON CONFLICT (tenant_id,setting_key) DO UPDATE
         SET value=EXCLUDED.value,version=tenant_settings.version+1`,
        [ids.tenant],
      ),
    );
    const second = await submitWeeklyTimesheet("2028-08-08", "2028-08-14", "2028-08-08");
    const secondRejectKey = randomUUID();
    const rejected = await mutation(
      {
        expectedRootVersion: 1,
        expectedTimesheetVersionId: second.currentVersion.timesheetVersionId,
        expectedVersion: 3,
      },
      secondRejectKey,
      "POST",
      `/v1/hr/timesheets/${second.timesheetId}/reject`,
      ids.manager,
    );
    expect(rejected.response.statusCode, rejected.response.body).toBe(200);
    expect(rejected.response.json().currentVersion.status).toBe("rejected");
    const note = await governed(ids.tenant, ids.operator, async (client) => {
      const result = await client.query<{ decision_note: string | null }>(
        `SELECT decision_note FROM hr_timesheet_approvals
         WHERE tenant_id=$1 AND timesheet_version_id=$2`,
        [ids.tenant, second.currentVersion.timesheetVersionId],
      );
      return result.rows[0]?.decision_note;
    });
    expect(note).toBeNull();
    const afterSecondDecision = await proofSnapshot();
    await governed(ids.tenant, ids.operator, (client) =>
      client.query(
        `UPDATE tenant_settings SET value='true',version=version+1
         WHERE tenant_id=$1 AND setting_key='hr.timesheet.rejection_note_required'`,
        [ids.tenant],
      ),
    );
    const historicalReplay = await mutation(
      {
        expectedRootVersion: 1,
        expectedTimesheetVersionId: second.currentVersion.timesheetVersionId,
        expectedVersion: 3,
      },
      secondRejectKey,
      "POST",
      `/v1/hr/timesheets/${second.timesheetId}/reject`,
      ids.manager,
    );
    expect(historicalReplay.response.statusCode, historicalReplay.response.body).toBe(200);
    expect(historicalReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(historicalReplay.response.json()).toEqual(rejected.response.json());
    expect(await proofSnapshot()).toEqual(afterSecondDecision);
  });

  it("appends one correction draft while preserving its exact terminal predecessor", async () => {
    const url = `/v1/hr/timesheets/${timesheetId}/corrections`;
    const body = {
      expectedRootVersion: 1,
      expectedTimesheetVersionId: timesheetVersionId,
      expectedVersion: 4,
    };
    const before = await proofSnapshot();
    const predecessor = await governed(ids.tenant, ids.operator, async (client) => {
      const result = await client.query(
        `SELECT timesheet_version_id::text,supersedes_version_id::text,version,status,
                assigned_approver_worker_profile_id::text,submitted_at,total_minutes,row_version
         FROM hr_timesheet_versions
         WHERE tenant_id=$1 AND timesheet_id=$2 AND timesheet_version_id=$3`,
        [ids.tenant, timesheetId, timesheetVersionId],
      );
      return result.rows[0];
    });
    expect(["approved", "rejected"]).toContain(predecessor.status);

    expectProblem(await mutation(body, randomUUID(), "POST", url), 403, "POLICY_DENIED");
    await governed(ids.tenant, ids.operator, (client) =>
      client.query(
        `DELETE FROM membership_capabilities
         WHERE tenant_id=$1 AND principal_id=$2
           AND capability_id='hr.timesheet.create_correction'`,
        [ids.tenant, ids.operator],
      ),
    );
    try {
      expectProblem(
        await mutation(body, randomUUID(), "POST", url, ids.operator),
        403,
        "POLICY_DENIED",
      );
      expect(await proofSnapshot()).toEqual(before);
    } finally {
      await governed(ids.tenant, ids.operator, (client) =>
        client.query(
          `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
           VALUES ($1,$2,'hr.timesheet.create_correction')`,
          [ids.tenant, ids.operator],
        ),
      );
    }

    const keys = [randomUUID(), randomUUID()];
    await migrationPool.query(`REVOKE INSERT ON notification_intents FROM ${applicationRole}`);
    try {
      expectProblem(
        await mutation(body, randomUUID(), "POST", url, ids.operator),
        403,
        "POLICY_DENIED",
      );
      expect(await proofSnapshot()).toEqual(before);
    } finally {
      await migrationPool.query(`GRANT INSERT ON notification_intents TO ${applicationRole}`);
    }
    const attempts = await Promise.all(
      keys.map((key) => mutation(body, key, "POST", url, ids.operator)),
    );
    const created = byStatus(attempts, 201);
    expectProblem(byStatus(attempts, 409), 409, "TIMESHEET_VERSION_CONFLICT");
    const winnerKey = keys[attempts.indexOf(created)] ?? "";
    const correction = created.response.json();
    expect(correction).toMatchObject({
      currentVersion: {
        assignedApproverWorkerProfileId: null,
        entries: [],
        rowVersion: 1,
        status: "draft",
        submittedAt: null,
        supersedesVersionId: timesheetVersionId,
        totalMinutes: 0,
        version: 2,
      },
      rootVersion: 2,
      timesheetId,
    });
    const replay = await mutation(body, winnerKey, "POST", url, ids.operator);
    expect(replay.response.statusCode, replay.response.body).toBe(200);
    expect(replay.response.headers["idempotent-replayed"]).toBe("true");
    expect(replay.response.json()).toEqual(correction);
    expect(await notificationIntents(timesheetId)).toEqual([
      expect.objectContaining({
        intent_payload: expect.objectContaining({ title: "A timesheet needs your review" }),
        recipient_principal_id: ids.manager,
      }),
      expect.objectContaining({
        intent_payload: expect.objectContaining({
          title: expect.stringMatching(/^Your timesheet was (approved|rejected)$/),
        }),
        recipient_principal_id: ids.employee,
      }),
      {
        intent_payload: {
          category: "hr.timesheet",
          safeSummary: "Open the timesheet for details.",
          targetHref: `/workspace/hr/timesheets/by-id/${timesheetId}`,
          targetKind: "hr.timesheet.detail",
          targetReadCapabilityId: "hr.timesheet.view_detail",
          targetResourceId: timesheetId,
          title: "A timesheet correction was recorded",
        },
        recipient_principal_id: ids.employee,
      },
    ]);
    expect(await proofSnapshot()).toEqual({
      ...before,
      evidence: Number(before.evidence) + 2,
      non_billable: Number(before.non_billable) + 1,
      outbox: Number(before.outbox) + 1,
      version_subjects: Number(before.version_subjects) + 1,
      versioned: Number(before.versioned) + 1,
      versions: Number(before.versions) + 1,
    });
    const stored = await governed(ids.tenant, ids.operator, async (client) => {
      const result = await client.query(
        `SELECT timesheet_version_id::text,supersedes_version_id::text,version,status,
                assigned_approver_worker_profile_id::text,submitted_at,total_minutes,row_version
         FROM hr_timesheet_versions
         WHERE tenant_id=$1 AND timesheet_id=$2 ORDER BY version`,
        [ids.tenant, timesheetId],
      );
      return result.rows;
    });
    expect(stored).toEqual([
      predecessor,
      expect.objectContaining({
        assigned_approver_worker_profile_id: null,
        row_version: 1,
        status: "draft",
        submitted_at: null,
        supersedes_version_id: timesheetVersionId,
        timesheet_version_id: correction.currentVersion.timesheetVersionId,
        total_minutes: 0,
        version: 2,
      }),
    ]);
    const proof = await governed(ids.tenant, ids.operator, async (client) => {
      const result = await client.query(
        `SELECT evidence.actor_principal_id::text,evidence.correlation_id::text,
                evidence.event_type,evidence.subject_id::text,evidence.subject_type,
                evidence.prior_state,evidence.new_state,
                outbox.aggregate_id::text,outbox.aggregate_type,outbox.aggregate_version,
                outbox.payload
         FROM evidence_events evidence JOIN outbox_events outbox
           ON outbox.tenant_id=evidence.tenant_id
          AND outbox.correlation_id=evidence.correlation_id
          AND outbox.event_type=evidence.event_type
          AND outbox.aggregate_id=evidence.subject_id
          AND outbox.aggregate_type=evidence.subject_type
         WHERE evidence.tenant_id=$1 AND evidence.event_type='hr.timesheet.create_correction'
           AND evidence.subject_id=$2`,
        [ids.tenant, correction.currentVersion.timesheetVersionId],
      );
      return result.rows;
    });
    expect(proof).toEqual([
      expect.objectContaining({
        actor_principal_id: ids.operator,
        aggregate_id: correction.currentVersion.timesheetVersionId,
        aggregate_type: "hr.timesheet.version",
        aggregate_version: 2,
        correlation_id: winnerKey,
        event_type: "hr.timesheet.create_correction",
        new_state: "draft",
        payload: expect.objectContaining({
          action: "create_correction",
          afterVersion: 2,
          beforeVersion: 1,
          billingState: "non_billable",
          timesheetId,
        }),
        prior_state: predecessor.status,
        subject_id: correction.currentVersion.timesheetVersionId,
        subject_type: "hr.timesheet.version",
      }),
    ]);
    const edited = await mutation(
      {
        entries: [{ entryDate: "2028-08-01", minutes: 30 }],
        expectedRootVersion: 2,
        expectedTimesheetVersionId: correction.currentVersion.timesheetVersionId,
        expectedVersion: 1,
      },
      randomUUID(),
      "PATCH",
      `/v1/hr/timesheets/${timesheetId}/draft`,
    );
    expect(edited.response.statusCode, edited.response.body).toBe(200);
    const submitted = await mutation(
      {
        expectedRootVersion: 2,
        expectedTimesheetVersionId: correction.currentVersion.timesheetVersionId,
        expectedVersion: 2,
      },
      randomUUID(),
      "POST",
      `/v1/hr/timesheets/${timesheetId}/submit`,
    );
    expect(submitted.response.statusCode, submitted.response.body).toBe(200);
    const approved = await mutation(
      {
        decisionNote: "Correction reviewed",
        expectedRootVersion: 2,
        expectedTimesheetVersionId: correction.currentVersion.timesheetVersionId,
        expectedVersion: 3,
      },
      randomUUID(),
      "POST",
      `/v1/hr/timesheets/${timesheetId}/approve`,
      ids.manager,
    );
    expect(approved.response.statusCode, approved.response.body).toBe(200);
    const durableReplay = await mutation(body, winnerKey, "POST", url, ids.operator);
    expect(durableReplay.response.statusCode, durableReplay.response.body).toBe(200);
    expect(durableReplay.response.headers["idempotent-replayed"]).toBe("true");
    expect(durableReplay.response.json()).toEqual(correction);
  });

  it("reads bounded own, assigned, and durable version-history pages through current authority", async () => {
    const firstSubmitted = await submitWeeklyTimesheet("2028-08-15", "2028-08-21", "2028-08-15");
    const secondSubmitted = await submitWeeklyTimesheet("2028-08-22", "2028-08-28", "2028-08-22");

    const ownFirst = await signedGet("/v1/hr/timesheets/own?pageSize=1");
    expect(ownFirst.response.statusCode, ownFirst.response.body).toBe(200);
    expect(ownFirst.response.headers["x-esbla-timesheet-actions"]).toBe(
      '["create","edit_draft","list_own","submit","view_detail"]',
    );
    const ownFirstPage = ownFirst.response.json();
    expect(ownFirstPage).toMatchObject({
      kind: "own",
      items: [
        {
          periodStart: "2028-08-22",
          status: "submitted",
          timesheetId: secondSubmitted.timesheetId,
        },
      ],
    });
    expect(ownFirstPage.nextCursor).toEqual({
      periodStart: "2028-08-22",
      timesheetId: secondSubmitted.timesheetId,
    });
    const ownSecond = await signedGet(
      `/v1/hr/timesheets/own?pageSize=1&cursorPeriodStart=${ownFirstPage.nextCursor.periodStart}` +
        `&cursorTimesheetId=${ownFirstPage.nextCursor.timesheetId}`,
    );
    expect(ownSecond.response.statusCode, ownSecond.response.body).toBe(200);
    expect(ownSecond.response.json().items[0].timesheetId).toBe(firstSubmitted.timesheetId);
    expect(
      (await signedGet("/v1/hr/timesheets/own?cursorPeriodStart=2028-08-22")).response.statusCode,
    ).toBe(400);

    const assignedFirst = await signedGet("/v1/hr/timesheets/assigned?pageSize=1", ids.manager);
    expect(assignedFirst.response.statusCode, assignedFirst.response.body).toBe(200);
    expect(assignedFirst.response.headers["x-esbla-timesheet-actions"]).toBe(
      '["approve","list_assigned","reject","view_detail"]',
    );
    const assignedFirstPage = assignedFirst.response.json();
    expect(assignedFirstPage).toMatchObject({
      kind: "assigned",
      items: [{ status: "submitted" }],
    });
    expect(assignedFirstPage.items[0].workItemId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    const assignedCursor = assignedFirstPage.nextCursor;
    expect(assignedCursor).toMatchObject({
      submittedAt: expect.any(String),
      timesheetVersionId: expect.any(String),
    });
    const assignedSecond = await signedGet(
      `/v1/hr/timesheets/assigned?pageSize=1` +
        `&cursorSubmittedAt=${encodeURIComponent(assignedCursor.submittedAt)}` +
        `&cursorTimesheetVersionId=${assignedCursor.timesheetVersionId}`,
      ids.manager,
    );
    expect(assignedSecond.response.statusCode, assignedSecond.response.body).toBe(200);
    expect(assignedSecond.response.json().items).toHaveLength(1);
    expect(assignedSecond.response.json().items[0].timesheetId).not.toBe(
      assignedFirstPage.items[0].timesheetId,
    );

    const assignedDetail = await signedGet(
      `/v1/hr/timesheets/by-id/${firstSubmitted.timesheetId}`,
      ids.manager,
    );
    expect(assignedDetail.response.statusCode, assignedDetail.response.body).toBe(200);
    expect(assignedDetail.response.headers["x-esbla-timesheet-actions"]).toBe(
      '["approve","list_assigned","reject","view_detail"]',
    );
    expect(assignedDetail.response.json()).toMatchObject({
      accessScope: "assigned",
      timesheetId: firstSubmitted.timesheetId,
    });

    await governed(ids.tenant, ids.operator, (client) =>
      client.query("UPDATE memberships SET role_key='employee' WHERE principal_id=$1", [
        ids.manager,
      ]),
    );
    try {
      expectProblem(
        await signedGet("/v1/hr/timesheets/assigned", ids.manager),
        403,
        "POLICY_DENIED",
      );
      expectProblem(
        await signedGet(`/v1/hr/timesheets/by-id/${firstSubmitted.timesheetId}`, ids.manager),
        404,
        "TIMESHEET_NOT_FOUND",
      );
    } finally {
      await governed(ids.tenant, ids.operator, (client) =>
        client.query("UPDATE memberships SET role_key='manager' WHERE principal_id=$1", [
          ids.manager,
        ]),
      );
    }

    const detailFirst = await signedGet(`/v1/hr/timesheets/by-id/${timesheetId}?pageSize=1`);
    expect(detailFirst.response.statusCode, detailFirst.response.body).toBe(200);
    const detailFirstPage = detailFirst.response.json();
    expect(detailFirstPage).toMatchObject({
      accessScope: "own",
      currentVersion: { status: "approved", version: 2 },
      history: {
        items: [{ status: "approved", version: 2 }],
        nextCursor: {
          timesheetVersionId: expect.any(String),
          version: 2,
        },
      },
      timesheetId,
    });
    const historyCursor = detailFirstPage.history.nextCursor;
    const detailSecond = await signedGet(
      `/v1/hr/timesheets/by-id/${timesheetId}?pageSize=1` +
        `&cursorVersion=${historyCursor.version}` +
        `&cursorTimesheetVersionId=${historyCursor.timesheetVersionId}`,
    );
    expect(detailSecond.response.statusCode, detailSecond.response.body).toBe(200);
    expect(detailSecond.response.json().history.items).toEqual([
      expect.objectContaining({ supersedesVersionId: null, version: 1 }),
    ]);

    const operatorDetail = await signedGet(`/v1/hr/timesheets/by-id/${timesheetId}`, ids.operator);
    expect(operatorDetail.response.statusCode, operatorDetail.response.body).toBe(200);
    expect(operatorDetail.response.json().accessScope).toBe("tenant");
    await governed(ids.tenant, ids.operator, (client) =>
      client.query("UPDATE memberships SET role_key='tenant_admin' WHERE principal_id=$1", [
        ids.operator,
      ]),
    );
    try {
      expectProblem(
        await signedGet(`/v1/hr/timesheets/by-id/${timesheetId}`, ids.operator),
        403,
        "POLICY_DENIED",
      );
    } finally {
      await governed(ids.tenant, ids.operator, (client) =>
        client.query("UPDATE memberships SET role_key='hr_operator' WHERE principal_id=$1", [
          ids.operator,
        ]),
      );
    }
    expectProblem(
      await signedGet(`/v1/hr/timesheets/by-id/${timesheetId}`, ids.otherEmployee, ids.otherTenant),
      404,
      "TIMESHEET_NOT_FOUND",
    );

    await serviceState("inactive");
    try {
      expectProblem(await signedGet("/v1/hr/timesheets/own"), 503, "TIMESHEET_SERVICE_INACTIVE");
    } finally {
      await serviceState("active");
    }
  });
});
