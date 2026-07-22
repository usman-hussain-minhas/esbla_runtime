import { createHash, randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { deriveStableUuid } from "@esbla/platform-core";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const sha256 = (values: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
const now = new Date("2026-07-22T08:30:00.000Z");
const secret = "esbla-workforce-settings-api-test-secret-v1";
const url = "/v1/hr/workforce-profiles/service-control";
const ids = {
  admin: "10000000-0000-4000-8000-000000006001",
  membership: "20000000-0000-4000-8000-000000006001",
  tenant: "00000000-0000-4000-8000-000000006001",
  tenantOther: "00000000-0000-4000-8000-000000006002",
} as const;
let authorityClient: PoolClient;
let migrationPool: Pool;
let pool: Pool;
let server: FastifyInstance;
async function inTenant<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function signedRequest(options: {
  readonly body?: object;
  readonly idempotencyKey?: string;
  readonly method: "GET" | "PATCH" | "POST";
  readonly principalId?: string;
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly targetUrl: string;
}) {
  const principalId = options.principalId ?? ids.admin;
  const requestId = options.requestId ?? randomUUID();
  const tenantId = options.tenantId ?? ids.tenant;
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const signature = signDevelopmentPrincipal(secret, {
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    method: options.method,
    principalId,
    requestId,
    tenantId,
    timestamp,
    url: options.targetUrl,
  });
  const headers: Record<string, string> = {
    "x-esbla-auth-signature": signature,
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": tenantId,
  };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const request: InjectOptions = { headers, method: options.method, url: options.targetUrl };
  if (options.body !== undefined) request.payload = options.body;
  return await server.inject(request);
}
const patchSettings = (body: object, idempotencyKey?: string, tenantId?: string) =>
  signedRequest({
    body,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    method: "PATCH",
    ...(tenantId === undefined ? {} : { tenantId }),
    targetUrl: `${url}/settings`,
  });
async function setConfigureAuthority(deniedBy: "role" | "capability", allowed: boolean) {
  const value =
    deniedBy === "role"
      ? allowed
        ? "tenant_admin"
        : "employee"
      : "hr.workforce.configure_service";
  await inTenant(authorityClient, () =>
    authorityClient.query(
      deniedBy === "role"
        ? `UPDATE memberships SET role_key=$3 WHERE tenant_id=$1 AND principal_id=$2`
        : allowed
          ? `INSERT INTO membership_capabilities VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`
          : `DELETE FROM membership_capabilities WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
      [ids.tenant, ids.admin, value],
    ),
  );
}
const serviceStateSql = `UPDATE service_activations SET state=$2, version=version+1
  WHERE tenant_id=$1 AND service_key='workforce_profile'`;
const setServiceState = (state: "active" | "inactive") =>
  inTenant(authorityClient, () => authorityClient.query(serviceStateSql, [ids.tenant, state]));
async function snapshot() {
  const client = await pool.connect();
  try {
    return await inTenant(client, async () => {
      const control = await client.query(
        `SELECT control.service_control_id, activation.state,
                activation.version activation_version,
                control.row_version, control.settings_version
         FROM hr_workforce_profile_service_control control
         JOIN service_activations activation
           ON activation.tenant_id=control.tenant_id
          AND activation.service_key=control.service_key
         WHERE control.tenant_id=$1 AND control.service_key='workforce_profile'`,
        [ids.tenant],
      );
      const settings = await client.query(
        `SELECT setting_key, value AS setting_value
         FROM tenant_settings
         WHERE tenant_id=$1 AND setting_key LIKE 'hr.workforce_profile.%'
         ORDER BY setting_key`,
        [ids.tenant],
      );
      const evidence = await client.query(
        `SELECT event_type, subject_type, subject_id, actor_principal_id,
                correlation_id, prior_state, new_state
         FROM evidence_events
         WHERE tenant_id=$1 AND subject_type LIKE 'hr.workforce_profile.service_control%'
         ORDER BY event_type, evidence_event_id`,
        [ids.tenant],
      );
      const outbox = await client.query(
        `SELECT event_type, aggregate_type, aggregate_id, aggregate_version,
                correlation_id, payload
         FROM outbox_events
         WHERE tenant_id=$1 AND aggregate_type='hr.workforce_profile.service_control'
         ORDER BY aggregate_version, event_id`,
        [ids.tenant],
      );
      return {
        control: control.rows,
        evidence: evidence.rows,
        outbox: outbox.rows,
        settings: settings.rows,
      };
    });
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!connectionString || !migrationConnectionString || !applicationRole) {
    throw new Error("PostgreSQL harness environment is required");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("Application role is not a safe PostgreSQL identifier");
  }
  migrationPool = createDatabasePool(migrationConnectionString, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `GRANT USAGE ON SCHEMA public TO ${applicationRole};
     REVOKE ALL ON TABLE public.memberships, public.tenant_settings,
       public.hr_workforce_profile_service_control FROM ${applicationRole};
     GRANT SELECT ON TABLE public.membership_capabilities, public.tenant_settings,
       public.hr_workforce_profile_service_control, public.hr_workforce_status_history,
       public.memberships TO ${applicationRole};
     GRANT UPDATE (status) ON public.memberships TO ${applicationRole};
     GRANT SELECT, INSERT, UPDATE ON TABLE public.service_activations,
       public.hr_worker_profiles TO ${applicationRole};
     GRANT SELECT, INSERT ON TABLE public.evidence_events, public.outbox_events,
       public.hr_reporting_relationships TO ${applicationRole}`,
  );
  await migrationPool.query(
    `WITH tenant AS (
       INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Settings A') RETURNING tenant_id
     ) INSERT INTO principals (principal_id, display_name)
       SELECT $2, 'Settings Admin' FROM tenant`,
    [ids.tenant, ids.admin],
  );
  authorityClient = await migrationPool.connect();
  await inTenant(authorityClient, async () => {
    await authorityClient.query(
      `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ($1, $2, $3, 'tenant_admin', NULL)`,
      [ids.membership, ids.tenant, ids.admin],
    );
    await authorityClient.query(
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       VALUES ($1,$2,'hr.workforce.activate_service'),
         ($1,$2,'hr.workforce.configure_service'),
         ($1,$2,'hr.workforce.view_service_control')`,
      [ids.tenant, ids.admin],
    );
  });
  pool = createDatabasePool(connectionString, { max: 8 });
  const developmentAuthenticator = createDevelopmentAuthenticator({ clock: () => now, secret });
  server = createServer({
    authenticate: async (request) => {
      const authenticated = await developmentAuthenticator(request);
      return {
        ...authenticated,
        operationContext: {
          ...authenticated.operationContext,
          correlationId: authenticated.requestId,
        },
      };
    },
    logger: false,
    migrationReadPool: migrationPool,
    pool,
    runtimeEnvironment: "test",
  });
});
afterAll(async () => {
  await server.close();
  await pool.end();
  authorityClient.release();
  await migrationPool.end();
});
describe("Workforce Profile settings API", () => {
  it("requires the complete capability-bearing settings consumer before configuration", async () => {
    const activated = await signedRequest({
      body: { expectedVersion: null },
      idempotencyKey: randomUUID(),
      method: "POST",
      targetUrl: `${url}/activate`,
    });
    expect(activated.statusCode).toBe(200);
    const before = await snapshot();
    const idempotencyKey = randomUUID();
    const body = {
      expectedSettingsVersion: 1,
      settings: {
        employeeNumberRequired: true,
        managerVisibility: "none",
        unlinkedWorkerCreationAllowed: false,
      },
    };
    const invalidKeys = await Promise.all(
      [undefined, "not-a-uuid"].map((key) => patchSettings(body, key)),
    );
    expect(invalidKeys.map((response) => [response.statusCode, response.json().code])).toEqual([
      [401, "AUTH_REQUIRED"],
      [401, "AUTH_INVALID"],
    ]);
    const configured = await patchSettings(body, idempotencyKey);
    expect(configured.headers["idempotent-replayed"]).toBe("false");
    const response = configured.json();
    expect(response).toMatchObject({
      activationState: "active",
      activationVersion: 1,
      serviceKey: "workforce_profile",
      settings: body.settings,
      settingsVersion: 2,
      version: 2,
    });
    const replay = await patchSettings(body, idempotencyKey);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(response);
    const conflict = await patchSettings(
      { ...body, settings: { ...body.settings, employeeNumberRequired: false } },
      idempotencyKey,
    );
    expect([conflict.statusCode, conflict.json().code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    const after = await snapshot();
    expect(
      after.settings.map(({ setting_key, setting_value }) => [setting_key, setting_value]),
    ).toEqual([
      ["hr.workforce_profile.employee_number_required", true],
      ["hr.workforce_profile.manager_visibility", "none"],
      ["hr.workforce_profile.unlinked_worker_creation_allowed", false],
    ]);
    const serviceControlId = after.control[0]?.service_control_id;
    const semanticSha256 = sha256([1, true, "none", false]);
    const beforeSettingsSha256 = sha256([1, false, "minimized", true]);
    const afterSettingsSha256 = sha256([2, true, "none", false]);
    const responseSha256 = sha256([
      response.activationState,
      response.activationVersion,
      response.serviceKey,
      ...Object.values(body.settings),
      response.settingsVersion,
      response.updatedAt,
      response.version,
    ]);
    const receiptId = deriveStableUuid(
      "hr.workforce_profile.service_control.idempotency.v1",
      ids.tenant,
      ids.admin,
      "configure_service",
      idempotencyKey,
    );
    const proofAuthority = { actor_principal_id: ids.admin, correlation_id: idempotencyKey };
    expect(
      after.evidence.filter(({ correlation_id }) => correlation_id === idempotencyKey),
    ).toEqual([
      {
        ...proofAuthority,
        event_type: "hr.workforce_profile.configure_service",
        new_state: afterSettingsSha256,
        prior_state: beforeSettingsSha256,
        subject_id: serviceControlId,
        subject_type: "hr.workforce_profile.service_control",
      },
      {
        ...proofAuthority,
        event_type: "hr.workforce_profile.configure_service.response_bound",
        new_state: responseSha256,
        prior_state: semanticSha256,
        subject_id: receiptId,
        subject_type: "hr.workforce_profile.service_control.idempotency",
      },
    ]);
    expect(
      after.evidence.filter(({ correlation_id }) => correlation_id !== idempotencyKey),
    ).toEqual(before.evidence);
    expect(after.outbox.filter(({ correlation_id }) => correlation_id === idempotencyKey)).toEqual([
      {
        aggregate_id: serviceControlId,
        aggregate_type: "hr.workforce_profile.service_control",
        aggregate_version: 2,
        correlation_id: idempotencyKey,
        event_type: "hr.workforce_profile.configure_service",
        payload: {
          action: "configure_service",
          actorPrincipalId: ids.admin,
          afterSettingsSha256,
          afterSettingsVersion: 2,
          aggregateId: serviceControlId,
          beforeSettingsSha256,
          beforeSettingsVersion: 1,
          correlationId: idempotencyKey,
          receiptId,
          serviceControl: response,
          tenantId: ids.tenant,
        },
      },
    ]);
    expect(after.outbox.filter(({ correlation_id }) => correlation_id !== idempotencyKey)).toEqual(
      before.outbox,
    );
    const crossTenant = await patchSettings(body, randomUUID(), ids.tenantOther);
    expect(crossTenant.statusCode).toBe(403);
    for (const deniedBy of ["role", "capability"] as const) {
      await setConfigureAuthority(deniedBy, false);
      try {
        const denied = await patchSettings(body, idempotencyKey);
        expect([deniedBy, denied.statusCode, denied.json().code]).toEqual([
          deniedBy,
          403,
          "POLICY_DENIED",
        ]);
        expect(await snapshot()).toEqual(after);
      } finally {
        await setConfigureAuthority(deniedBy, true);
      }
    }
    await setServiceState("inactive");
    const inactiveBefore = await snapshot();
    try {
      const inactive = await patchSettings(body, idempotencyKey);
      expect(inactive.statusCode).toBe(503);
      expect(inactive.json().code).toBe("WORKFORCE_SERVICE_INACTIVE");
      expect(await snapshot()).toEqual(inactiveBefore);
    } finally {
      await setServiceState("active");
    }
  });
});
