import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const now = new Date("2026-07-23T12:00:00.000Z");
const secret = "esbla-employment-api-integration-secret-v1";
const ids = {
  adminA: "71000000-0000-4000-8000-000000000006",
  adminC: "71000000-0000-4000-8000-000000000007",
  employeeA: "71000000-0000-4000-8000-000000000003",
  membershipAdminA: "72000000-0000-4000-8000-000000000006",
  membershipAdminC: "72000000-0000-4000-8000-000000000007",
  membershipEmployeeA: "72000000-0000-4000-8000-000000000003",
  membershipOperatorA: "72000000-0000-4000-8000-000000000002",
  membershipOperatorB: "72000000-0000-4000-8000-000000000005",
  operatorA: "71000000-0000-4000-8000-000000000002",
  operatorB: "71000000-0000-4000-8000-000000000005",
  tenantA: "70000000-0000-4000-8000-000000000001",
  tenantB: "70000000-0000-4000-8000-000000000002",
  tenantC: "70000000-0000-4000-8000-000000000003",
} as const;

const employmentCapabilities = {
  admin: [
    "hr.employment.activate_service",
    "hr.employment.configure_service",
    "hr.employment.deactivate_service",
    "hr.employment.view_service_control",
  ],
  operator: [
    "hr.employment.create_record",
    "hr.employment.create_version",
    "hr.employment.end_record",
    "hr.employment.list_authorized",
    "hr.employment.view_detail",
  ],
} as const;

interface SignedRequestOptions {
  readonly body?: object;
  readonly employmentActionsHeader?: string;
  readonly idempotencyKey?: string;
  readonly method: "GET" | "PATCH" | "POST";
  readonly principalId: string;
  readonly tenantId: string;
  readonly url: string;
}

interface EmploymentResponse {
  readonly currentVersion: number | null;
  readonly employmentRecordId: string;
  readonly operation: "create_record" | "create_version" | "end_record";
  readonly rootVersion: number;
  readonly status: "active" | "draft" | "ended";
}

interface EmploymentDetailResponse {
  readonly history: Readonly<{
    items: readonly Readonly<{ version: number }>[];
    nextCursor: object | null;
  }>;
}

let migrationPool: Pool;
let pool: Pool;
let server: FastifyInstance;
let workerProfileId: string;

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  tenantId: string,
  actorPrincipalId: string,
  query: string,
  values: readonly unknown[],
): Promise<QueryResult<Row>> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [actorPrincipalId]);
    await client.query("SELECT set_config('app.correlation_id', $1, true)", [randomUUID()]);
    const result = await client.query<Row>(query, [...values]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function replaceEmploymentCapabilities(
  principalId: string,
  capabilities: readonly string[],
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await tenantQuery(
      client,
      ids.tenantA,
      principalId,
      `DELETE FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2 AND capability_id LIKE 'hr.employment.%'`,
      [ids.tenantA, principalId],
    );
    if (capabilities.length > 0) {
      await tenantQuery(
        client,
        ids.tenantA,
        principalId,
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1,$2,capability_id FROM unnest($3::text[]) AS capability(capability_id)`,
        [ids.tenantA, principalId, capabilities],
      );
    }
  } finally {
    client.release();
  }
}

async function signedRequest(options: SignedRequestOptions) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(now.getTime() / 1000));
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
    "x-esbla-auth-signature": signature,
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": options.principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": options.tenantId,
  };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  if (options.employmentActionsHeader) {
    headers["x-esbla-employment-actions"] = options.employmentActionsHeader;
  }
  const request: InjectOptions = { headers, method: options.method, url: options.url };
  if (options.body !== undefined) request.payload = options.body;
  return await server.inject(request);
}

async function persistenceCounts(tenantId: string) {
  const result = await migrationPool.query<{
    evidence: string;
    outbox: string;
    records: string;
    versions: string;
  }>(
    `SELECT
       (SELECT count(*) FROM evidence_events WHERE tenant_id=$1)::text AS evidence,
       (SELECT count(*) FROM outbox_events WHERE tenant_id=$1)::text AS outbox,
       (SELECT count(*) FROM hr_employment_records WHERE tenant_id=$1)::text AS records,
       (SELECT count(*) FROM hr_employment_record_versions WHERE tenant_id=$1)::text AS versions`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Employment persistence counts are unavailable");
  return {
    evidence: Number(row.evidence),
    outbox: Number(row.outbox),
    records: Number(row.records),
    versions: Number(row.versions),
  };
}

function expectProblem(
  response: Awaited<ReturnType<typeof signedRequest>>,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(response.json()).toMatchObject({ code, status });
  expect(Object.keys(response.json()).sort()).toEqual(
    ["code", "detail", "instance", "requestId", "status", "title", "type"].sort(),
  );
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
  await migrationPool.query(
    `GRANT USAGE ON TYPE hr_employment_record_status, hr_employment_version_kind
     TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT ON memberships, membership_capabilities, tenant_settings,
       hr_workforce_profile_service_control, hr_workforce_status_history,
       hr_employment_record_service_control
     TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE ON service_activations, hr_worker_profiles,
       hr_employment_records TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT, INSERT ON evidence_events, outbox_events, hr_reporting_relationships,
       hr_employment_record_versions
     TO ${applicationRole}`,
  );

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Employment Tenant A'), ($2, 'Employment Tenant B'),
            ($3, 'Employment Action-only Tenant')`,
    [ids.tenantA, ids.tenantB, ids.tenantC],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'HR Operator A'), ($2, 'Employee A'), ($3, 'HR Operator B'),
            ($4, 'Tenant Admin A'), ($5, 'Action-only Tenant Admin')`,
    [ids.operatorA, ids.employeeA, ids.operatorB, ids.adminA, ids.adminC],
  );

  const client = await migrationPool.connect();
  try {
    await tenantQuery(
      client,
      ids.tenantA,
      ids.operatorA,
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1,$2,$3,'hr_operator'), ($4,$2,$5,'employee'),
              ($6,$2,$7,'tenant_admin')`,
      [
        ids.membershipOperatorA,
        ids.tenantA,
        ids.operatorA,
        ids.membershipEmployeeA,
        ids.employeeA,
        ids.membershipAdminA,
        ids.adminA,
      ],
    );
    await tenantQuery(
      client,
      ids.tenantB,
      ids.operatorB,
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1,$2,$3,'hr_operator')`,
      [ids.membershipOperatorB, ids.tenantB, ids.operatorB],
    );
    await tenantQuery(
      client,
      ids.tenantC,
      ids.adminC,
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1,$2,$3,'tenant_admin')`,
      [ids.membershipAdminC, ids.tenantC, ids.adminC],
    );
    await tenantQuery(
      client,
      ids.tenantA,
      ids.operatorA,
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       SELECT $1,$2,capability_id FROM unnest($3::text[]) AS capability(capability_id)`,
      [ids.tenantA, ids.operatorA, employmentCapabilities.operator],
    );
    await tenantQuery(
      client,
      ids.tenantA,
      ids.adminA,
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       SELECT $1,$2,capability_id FROM unnest($3::text[]) AS capability(capability_id)`,
      [ids.tenantA, ids.adminA, employmentCapabilities.admin],
    );
    await tenantQuery(
      client,
      ids.tenantB,
      ids.operatorB,
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       SELECT $1,$2,capability_id FROM unnest($3::text[]) AS capability(capability_id)`,
      [ids.tenantB, ids.operatorB, ["hr.employment.create_record", "hr.employment.view_detail"]],
    );
    await tenantQuery(
      client,
      ids.tenantC,
      ids.adminC,
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       SELECT $1,$2,capability_id FROM unnest($3::text[]) AS capability(capability_id)`,
      [
        ids.tenantC,
        ids.adminC,
        [
          "hr.employment.activate_service",
          "hr.employment.configure_service",
          "hr.employment.deactivate_service",
        ],
      ],
    );
    for (const [tenantId, actorPrincipalId] of [
      [ids.tenantA, ids.operatorA],
      [ids.tenantB, ids.operatorB],
    ] as const) {
      await tenantQuery(
        client,
        tenantId,
        actorPrincipalId,
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
         VALUES ($1,'workforce_profile','active',1), ($1,'employment_record','active',1)`,
        [tenantId],
      );
    }
    await tenantQuery(
      client,
      ids.tenantC,
      ids.adminC,
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1,'workforce_profile','active',1)`,
      [ids.tenantC],
    );
    const profile = await tenantQuery<{ worker_profile_id: string }>(
      client,
      ids.tenantA,
      ids.operatorA,
      `INSERT INTO hr_worker_profiles (tenant_id, employee_number)
       VALUES ($1,'EMPLOYMENT-API') RETURNING worker_profile_id`,
      [ids.tenantA],
    );
    workerProfileId = profile.rows[0]?.worker_profile_id ?? "";
  } finally {
    client.release();
  }
  if (!workerProfileId) throw new Error("Employment Worker Profile setup failed");

  pool = createDatabasePool(connectionString, { max: 6 });
  server = createServer({
    authenticate: createDevelopmentAuthenticator({ clock: () => now, secret }),
    logger: false,
    migrationReadPool: migrationPool,
    pool,
    runtimeEnvironment: "test",
  });
});

afterAll(async () => {
  if (server) await server.close();
  if (pool) await pool.end();
  if (migrationPool) await migrationPool.end();
});

describe("Employment Record API boundary", () => {
  it("proves the authorized journey and fails malformed or unauthorized requests closed", async () => {
    const createBody = { workerProfileId };
    const createKey = randomUUID();
    const createUrl = "/v1/hr/employment-records";
    const created = await signedRequest({
      body: createBody,
      idempotencyKey: createKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: createUrl,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers["idempotent-replayed"]).toBe("false");
    const draft = created.json<EmploymentResponse>();
    expect(draft).toEqual({
      currentVersion: null,
      employmentRecordId: expect.any(String),
      operation: "create_record",
      rootVersion: 1,
      status: "draft",
    });
    const replayedCreate = await signedRequest({
      body: createBody,
      idempotencyKey: createKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: createUrl,
    });
    expect(replayedCreate.statusCode).toBe(200);
    expect(replayedCreate.headers["idempotent-replayed"]).toBe("true");
    expect(replayedCreate.json()).toEqual(draft);

    const versionBody = {
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-07-31",
      employmentTypeCode: null,
      expectedCurrentVersion: null,
      expectedVersion: 1,
      organizationReference: "org:opaque",
      positionReference: "position:opaque",
    };
    const versionUrl = `${createUrl}/${draft.employmentRecordId}/versions`;
    const versionKey = randomUUID();
    const versioned = await signedRequest({
      body: versionBody,
      idempotencyKey: versionKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: versionUrl,
    });
    expect(versioned.statusCode).toBe(201);
    const active = versioned.json<EmploymentResponse>();
    expect(active).toEqual({
      currentVersion: 1,
      employmentRecordId: draft.employmentRecordId,
      operation: "create_version",
      rootVersion: 2,
      status: "active",
    });

    const listed = await signedRequest({
      method: "GET",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `${createUrl}?pageSize=1`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      accessScope: "tenant",
      items: [{ employmentRecordId: draft.employmentRecordId, status: "active" }],
    });

    const detailUrl = `${createUrl}/by-id/${draft.employmentRecordId}`;
    const detail = await signedRequest({
      method: "GET",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `${detailUrl}?pageSize=1`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers["x-esbla-employment-actions"]).toBe(
      '["create_record","create_version","end_record","list_authorized","view_detail"]',
    );
    expect(detail.json()).toMatchObject({
      accessScope: "tenant",
      currentVersion: {
        effectiveFrom: "2026-07-01",
        effectiveTo: "2026-07-31",
        kind: "effective",
        rowVersion: 1,
        terminal: false,
        version: 1,
      },
      employmentRecordId: draft.employmentRecordId,
      history: { items: [expect.objectContaining({ version: 1 })], nextCursor: null },
      status: "active",
      version: 2,
      workerProfileId,
    });

    const endBody = { effectiveTo: "2026-07-25", expectedCurrentVersion: 1, expectedVersion: 2 };
    const endUrl = `${createUrl}/${draft.employmentRecordId}/end`;
    const endKey = randomUUID();
    const ended = await signedRequest({
      body: endBody,
      idempotencyKey: endKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: endUrl,
    });
    expect(ended.statusCode).toBe(200);
    const terminal = ended.json<EmploymentResponse>();
    expect(terminal).toEqual({
      currentVersion: 2,
      employmentRecordId: draft.employmentRecordId,
      operation: "end_record",
      rootVersion: 3,
      status: "ended",
    });
    const endedDetail = await signedRequest({
      method: "GET",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: detailUrl,
    });
    expect(endedDetail.statusCode).toBe(200);
    expect(
      endedDetail.json<EmploymentDetailResponse>().history.items.map(({ version }) => version),
    ).toEqual([2, 1]);

    for (const [url, body, idempotencyKey, expected] of [
      [createUrl, createBody, createKey, draft],
      [versionUrl, versionBody, versionKey, active],
      [endUrl, endBody, endKey, terminal],
    ] as const) {
      const replay = await signedRequest({
        body,
        idempotencyKey,
        method: "POST",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url,
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json()).toEqual(expected);
    }
    const beforeSemanticConflict = await persistenceCounts(ids.tenantA);
    const semanticConflict = await signedRequest({
      body: { ...versionBody, organizationReference: "changed" },
      idempotencyKey: versionKey,
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: versionUrl,
    });
    expectProblem(semanticConflict, 409, "IDEMPOTENCY_CONFLICT");
    expect(await persistenceCounts(ids.tenantA)).toEqual(beforeSemanticConflict);

    const beforeA = await persistenceCounts(ids.tenantA);
    const beforeB = await persistenceCounts(ids.tenantB);

    const malformed = await signedRequest({
      body: { tenantId: ids.tenantB, workerProfileId },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: createUrl,
    });
    expectProblem(malformed, 400, "REQUEST_VALIDATION_FAILED");

    const unpairedCursor = await signedRequest({
      method: "GET",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: `${createUrl}?cursorCreatedAt=2026-07-23T12%3A00%3A00.000Z`,
    });
    expectProblem(unpairedCursor, 400, "REQUEST_VALIDATION_FAILED");
    expect(unpairedCursor.headers["x-esbla-employment-actions"]).toBeUndefined();

    const missingIdempotency = await signedRequest({
      body: { workerProfileId },
      method: "POST",
      principalId: ids.operatorA,
      tenantId: ids.tenantA,
      url: createUrl,
    });
    expectProblem(missingIdempotency, 401, "AUTH_REQUIRED");

    const unauthorized = await signedRequest({
      body: { workerProfileId },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.employeeA,
      tenantId: ids.tenantA,
      url: createUrl,
    });
    expectProblem(unauthorized, 403, "POLICY_DENIED");

    const crossTenantRead = await signedRequest({
      method: "GET",
      principalId: ids.operatorB,
      tenantId: ids.tenantB,
      url: `${createUrl}/by-id/${draft.employmentRecordId}`,
    });
    expectProblem(crossTenantRead, 404, "EMPLOYMENT_NOT_FOUND");
    expect(crossTenantRead.body).not.toContain(ids.tenantA);
    expect(crossTenantRead.body).not.toContain(workerProfileId);

    expect(await persistenceCounts(ids.tenantA)).toEqual(beforeA);
    expect(await persistenceCounts(ids.tenantB)).toEqual(beforeB);
  });

  it("reports all nine current Employment action authorities independently", async () => {
    const listUrl = "/v1/hr/employment-records";
    const controlUrl = "/v1/hr/employment-records/service-control";
    try {
      const activated = await signedRequest({
        body: { expectedVersion: null },
        idempotencyKey: randomUUID(),
        method: "POST",
        principalId: ids.adminC,
        tenantId: ids.tenantC,
        url: `${controlUrl}/activate`,
      });
      expect(activated.statusCode, activated.body).toBe(200);
      expect(activated.json()).toEqual({
        activationState: "active",
        activationVersion: 1,
        controlVersion: 1,
        operation: "activate_service",
        serviceKey: "employment_record",
        settingsVersion: 1,
      });
      const configured = await signedRequest({
        body: {
          expectedSettingsVersion: 1,
          settings: {
            effectiveRangeOverlapAllowed: false,
            employmentTypeCodes: "standard,temporary",
          },
        },
        idempotencyKey: randomUUID(),
        method: "PATCH",
        principalId: ids.adminC,
        tenantId: ids.tenantC,
        url: `${controlUrl}/settings`,
      });
      expect(configured.statusCode, configured.body).toBe(200);
      expect(configured.json()).toEqual({
        activationState: "active",
        activationVersion: 1,
        controlVersion: 2,
        operation: "configure_service",
        serviceKey: "employment_record",
        settingsVersion: 2,
      });
      const deactivated = await signedRequest({
        body: { expectedVersion: 1 },
        idempotencyKey: randomUUID(),
        method: "POST",
        principalId: ids.adminC,
        tenantId: ids.tenantC,
        url: `${controlUrl}/deactivate`,
      });
      expect(deactivated.statusCode, deactivated.body).toBe(200);
      expect(deactivated.json()).toEqual({
        activationState: "inactive",
        activationVersion: 2,
        controlVersion: 3,
        operation: "deactivate_service",
        serviceKey: "employment_record",
        settingsVersion: 2,
      });
      const actionOnlyControlRead = await signedRequest({
        method: "GET",
        principalId: ids.adminC,
        tenantId: ids.tenantC,
        url: controlUrl,
      });
      expectProblem(actionOnlyControlRead, 403, "POLICY_DENIED");
      expect(actionOnlyControlRead.headers["x-esbla-employment-actions"]).toBe(
        '["activate_service","configure_service","deactivate_service"]',
      );

      await replaceEmploymentCapabilities(ids.operatorA, [
        "hr.employment.create_record",
        "hr.employment.create_version",
        "hr.employment.end_record",
      ]);
      const actionOnlyOperator = await signedRequest({
        employmentActionsHeader: '["activate_service"]',
        method: "GET",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url: listUrl,
      });
      expectProblem(actionOnlyOperator, 403, "POLICY_DENIED");
      expect(actionOnlyOperator.headers["x-esbla-employment-actions"]).toBe(
        '["create_record","create_version","end_record"]',
      );
      const actionOnlyMutation = await signedRequest({
        body: { workerProfileId },
        idempotencyKey: randomUUID(),
        method: "POST",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url: listUrl,
      });
      expect(actionOnlyMutation.statusCode, actionOnlyMutation.body).toBe(201);
      expect(Object.keys(actionOnlyMutation.json()).sort()).toEqual(
        ["currentVersion", "employmentRecordId", "operation", "rootVersion", "status"].sort(),
      );
      expect(actionOnlyMutation.json()).toMatchObject({
        currentVersion: null,
        operation: "create_record",
        rootVersion: 1,
        status: "draft",
      });
      const actionOnlyDetailRead = await signedRequest({
        method: "GET",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url: `${listUrl}/by-id/${actionOnlyMutation.json<EmploymentResponse>().employmentRecordId}`,
      });
      expectProblem(actionOnlyDetailRead, 403, "POLICY_DENIED");
      expect(actionOnlyDetailRead.body).not.toContain(workerProfileId);
      const beforeRevocation = await persistenceCounts(ids.tenantA);
      await replaceEmploymentCapabilities(ids.operatorA, []);
      const revokedSubmission = await signedRequest({
        body: { workerProfileId },
        idempotencyKey: randomUUID(),
        method: "POST",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url: listUrl,
      });
      expectProblem(revokedSubmission, 403, "POLICY_DENIED");
      expect(await persistenceCounts(ids.tenantA)).toEqual(beforeRevocation);

      await replaceEmploymentCapabilities(ids.operatorA, [
        "hr.employment.list_authorized",
        "hr.employment.view_detail",
      ]);
      const readOnlyOperator = await signedRequest({
        method: "GET",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url: listUrl,
      });
      expect(readOnlyOperator.statusCode).toBe(200);
      expect(readOnlyOperator.headers["x-esbla-employment-actions"]).toBe(
        '["list_authorized","view_detail"]',
      );

      await replaceEmploymentCapabilities(ids.operatorA, ["hr.employment.list_authorized"]);
      const listOnlyOperator = await signedRequest({
        method: "GET",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url: listUrl,
      });
      expect(listOnlyOperator.statusCode).toBe(200);
      expect(listOnlyOperator.headers["x-esbla-employment-actions"]).toBe('["list_authorized"]');

      await replaceEmploymentCapabilities(ids.operatorA, ["hr.employment.view_detail"]);
      const detailOnlyOperator = await signedRequest({
        method: "GET",
        principalId: ids.operatorA,
        tenantId: ids.tenantA,
        url: listUrl,
      });
      expectProblem(detailOnlyOperator, 403, "POLICY_DENIED");
      expect(detailOnlyOperator.headers["x-esbla-employment-actions"]).toBe('["view_detail"]');

      await replaceEmploymentCapabilities(ids.adminA, [
        "hr.employment.activate_service",
        "hr.employment.configure_service",
        "hr.employment.deactivate_service",
      ]);
      const actionOnlyAdmin = await signedRequest({
        method: "GET",
        principalId: ids.adminA,
        tenantId: ids.tenantA,
        url: controlUrl,
      });
      expectProblem(actionOnlyAdmin, 403, "POLICY_DENIED");
      expect(actionOnlyAdmin.headers["x-esbla-employment-actions"]).toBe(
        '["activate_service","configure_service","deactivate_service"]',
      );

      await replaceEmploymentCapabilities(ids.adminA, ["hr.employment.view_service_control"]);
      const viewOnlyAdmin = await signedRequest({
        method: "GET",
        principalId: ids.adminA,
        tenantId: ids.tenantA,
        url: controlUrl,
      });
      expect([200, 404]).toContain(viewOnlyAdmin.statusCode);
      expect(viewOnlyAdmin.headers["x-esbla-employment-actions"]).toBe('["view_service_control"]');

      const separateTenantAction = await signedRequest({
        method: "GET",
        principalId: ids.operatorB,
        tenantId: ids.tenantB,
        url: listUrl,
      });
      expectProblem(separateTenantAction, 403, "POLICY_DENIED");
      expect(separateTenantAction.headers["x-esbla-employment-actions"]).toBe(
        '["create_record","view_detail"]',
      );

      await replaceEmploymentCapabilities(ids.employeeA, ["hr.employment.create_record"]);
      const wrongRole = await signedRequest({
        method: "GET",
        principalId: ids.employeeA,
        tenantId: ids.tenantA,
        url: listUrl,
      });
      expectProblem(wrongRole, 403, "POLICY_DENIED");
      expect(wrongRole.headers["x-esbla-employment-actions"]).toBe("[]");

      const absentMembership = await signedRequest({
        employmentActionsHeader: '["create_record"]',
        method: "GET",
        principalId: ids.operatorA,
        tenantId: ids.tenantB,
        url: listUrl,
      });
      expectProblem(absentMembership, 403, "ACTOR_NOT_ACTIVE_MEMBER");
      expect(absentMembership.headers["x-esbla-employment-actions"]).toBeUndefined();
    } finally {
      await replaceEmploymentCapabilities(ids.operatorA, employmentCapabilities.operator);
      await replaceEmploymentCapabilities(ids.adminA, employmentCapabilities.admin);
      await replaceEmploymentCapabilities(ids.employeeA, []);
    }
  });
});
