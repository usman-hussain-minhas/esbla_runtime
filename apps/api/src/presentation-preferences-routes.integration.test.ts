import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const secret = "esbla-presentation-preferences-api-test-secret-v1";
const ids = {
  admin: "10000000-0000-4000-8000-00000000a001",
  adminMembership: "20000000-0000-4000-8000-00000000a001",
  employee: "10000000-0000-4000-8000-00000000a002",
  employeeMembership: "20000000-0000-4000-8000-00000000a002",
  otherTenant: "00000000-0000-4000-8000-00000000a002",
  tenant: "00000000-0000-4000-8000-00000000a001",
} as const;

let migrationPool: Pool;
let pool: Pool;
let server: FastifyInstance;

async function tenantTransaction<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.admin]);
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function setTenantAuthority(enabled: boolean): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, async () => {
      await client.query(
        enabled
          ? `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
             VALUES ($1,$2,'platform.presentation.tenant_defaults.write')
             ON CONFLICT DO NOTHING`
          : `DELETE FROM membership_capabilities
             WHERE tenant_id=$1 AND principal_id=$2
               AND capability_id='platform.presentation.tenant_defaults.write'`,
        [ids.tenant, ids.admin],
      );
    });
  } finally {
    client.release();
  }
}

async function setEmployeeLayoutCapability(
  capabilityId:
    | "platform.presentation.layouts.read_own"
    | "platform.presentation.layouts.reset_own"
    | "platform.presentation.layouts.write_own",
  enabled: boolean,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, async () => {
      await client.query(
        enabled
          ? `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
             VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`
          : `DELETE FROM membership_capabilities
             WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
        [ids.tenant, ids.employee, capabilityId],
      );
    });
  } finally {
    client.release();
  }
}

async function signedRequest(options: {
  readonly body?: object;
  readonly idempotencyKey?: string;
  readonly method: "GET" | "POST";
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly url: string;
}) {
  const principalId = options.principalId ?? ids.employee;
  const tenantId = options.tenantId ?? ids.tenant;
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = signDevelopmentPrincipal(secret, {
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    method: options.method,
    principalId,
    requestId,
    tenantId,
    timestamp,
    url: options.url,
  });
  const headers: Record<string, string> = {
    "x-esbla-auth-signature": signature,
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": tenantId,
  };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const request: InjectOptions = { headers, method: options.method, url: options.url };
  if (options.body !== undefined) request.payload = options.body;
  return await server.inject(request);
}

async function proofSnapshot() {
  const result = await migrationPool.query<{
    evidence: string;
    outbox: string;
    settings: string;
  }>(
    `SELECT
       (SELECT coalesce(jsonb_agg(to_jsonb(setting) ORDER BY subject_type,subject_id,setting_key),
                        '[]'::jsonb)::text
        FROM presentation_setting_values setting WHERE tenant_id=$1) settings,
       (SELECT coalesce(jsonb_agg(to_jsonb(evidence) ORDER BY evidence_event_id),
                        '[]'::jsonb)::text
        FROM evidence_events evidence
        WHERE tenant_id=$1
          AND subject_type IN (
            'platform_presentation_preferences',
            'platform_presentation_tenant_defaults'
          )) evidence,
       (SELECT coalesce(jsonb_agg(to_jsonb(outbox) ORDER BY event_id),'[]'::jsonb)::text
        FROM outbox_events outbox
        WHERE tenant_id=$1 AND event_type LIKE 'platform.presentation.%') outbox`,
    [ids.tenant],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Presentation API proof snapshot is unavailable");
  return row;
}

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL presentation API harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities, service_activations TO ${applicationRole};
     GRANT SELECT,INSERT ON evidence_events TO ${applicationRole}`,
  );
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Presentation Tenant'),($2,'Other Presentation Tenant')`,
    [ids.tenant, ids.otherTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Presentation Administrator'),($2,'Presentation Employee')`,
    [ids.admin, ids.employee],
  );
  const client = await migrationPool.connect();
  try {
    await tenantTransaction(client, async () => {
      await client.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'employee'),($4,$2,$5,'employee')`,
        [ids.adminMembership, ids.tenant, ids.admin, ids.employeeMembership, ids.employee],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'platform.presentation.tenant_defaults.write')`,
        [ids.tenant, ids.admin],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'hr.leave_request','active',1)`,
        [ids.tenant],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         SELECT $1,$2,capability_id
         FROM unnest($3::text[]) AS capability(capability_id)`,
        [
          ids.tenant,
          ids.employee,
          [
            "hr.leave.list_own",
            "hr.leave.view",
            "platform.presentation.layouts.read_own",
            "platform.presentation.layouts.reset_own",
            "platform.presentation.layouts.write_own",
          ],
        ],
      );
    });
  } finally {
    client.release();
  }
  pool = createDatabasePool(runtimeUrl, { max: 6 });
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

describe("presentation preference API", () => {
  it("keeps values server-authoritative across user, tenant, denial, CAS and reset", async () => {
    const preferencesUrl = "/v1/platform/presentation/preferences";
    const tenantUrl = "/v1/platform/presentation/tenant-defaults";
    const initial = await signedRequest({ method: "GET", url: preferencesUrl });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      appearance: {
        density: { effectiveValue: "comfortable", source: "product_default" },
        highContrast: { effectiveValue: false, source: "product_default" },
        palette: { effectiveValue: "light", source: "product_default" },
        reducedMotion: { effectiveValue: "auto", source: "product_default" },
      },
      canManageTenantDefaults: false,
      tenantVersion: 0,
      userVersion: 0,
    });

    const ownBody = {
      density: "compact",
      expectedVersion: 0,
      highContrast: false,
      palette: "dark",
      reducedMotion: "auto",
    };
    const ownKey = randomUUID();
    const own = await signedRequest({
      body: ownBody,
      idempotencyKey: ownKey,
      method: "POST",
      url: preferencesUrl,
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.headers["idempotent-replayed"]).toBe("false");
    const ownReplay = await signedRequest({
      body: ownBody,
      idempotencyKey: ownKey,
      method: "POST",
      url: preferencesUrl,
    });
    expect(ownReplay.statusCode, ownReplay.body).toBe(200);
    expect(ownReplay.headers["idempotent-replayed"]).toBe("true");
    expect(ownReplay.json()).toEqual({ ...own.json(), replayed: true });

    const tenantBody = {
      density: "comfortable",
      expectedVersion: 0,
      highContrast: true,
      lockDensity: true,
      palette: "light",
      reducedMotion: "reduce",
      requireHighContrast: true,
      requireReducedMotion: true,
    };
    const tenant = await signedRequest({
      body: tenantBody,
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.admin,
      url: tenantUrl,
    });
    expect(tenant.statusCode, tenant.body).toBe(200);
    expect(tenant.json()).toMatchObject({
      canManageTenantDefaults: true,
      tenantVersion: 1,
    });
    const effective = await signedRequest({ method: "GET", url: preferencesUrl });
    expect(effective.statusCode, effective.body).toBe(200);
    expect(effective.json()).toMatchObject({
      appearance: {
        density: { effectiveValue: "comfortable", locked: true, userValue: "compact" },
        highContrast: { effectiveValue: true, locked: true, userValue: false },
        palette: { effectiveValue: "dark", locked: false, userValue: "dark" },
        reducedMotion: { effectiveValue: "reduce", locked: true, userValue: "auto" },
      },
      canManageTenantDefaults: false,
      tenantVersion: 1,
      userVersion: 1,
    });

    const beforeDenied = await proofSnapshot();
    await setTenantAuthority(false);
    const denied = await signedRequest({
      body: { ...tenantBody, expectedVersion: 1 },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.admin,
      url: tenantUrl,
    });
    expect([denied.statusCode, denied.json().code]).toEqual([403, "POLICY_DENIED"]);
    expect(await proofSnapshot()).toEqual(beforeDenied);
    const crossTenant = await signedRequest({
      body: tenantBody,
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.admin,
      tenantId: ids.otherTenant,
      url: tenantUrl,
    });
    expect([crossTenant.statusCode, crossTenant.json().code]).toEqual([
      403,
      "ACTOR_NOT_ACTIVE_MEMBER",
    ]);

    await setTenantAuthority(true);
    const race = await Promise.all([
      signedRequest({
        body: { ...ownBody, expectedVersion: 1, palette: "light" },
        idempotencyKey: randomUUID(),
        method: "POST",
        url: preferencesUrl,
      }),
      signedRequest({
        body: { ...ownBody, expectedVersion: 1, reducedMotion: "reduce" },
        idempotencyKey: randomUUID(),
        method: "POST",
        url: preferencesUrl,
      }),
    ]);
    expect(race.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);

    const tenantReset = await signedRequest({
      body: { expectedVersion: 1 },
      idempotencyKey: randomUUID(),
      method: "POST",
      principalId: ids.admin,
      url: `${tenantUrl}/reset`,
    });
    expect(tenantReset.statusCode, tenantReset.body).toBe(200);
    const ownReset = await signedRequest({
      body: { expectedVersion: 2 },
      idempotencyKey: randomUUID(),
      method: "POST",
      url: `${preferencesUrl}/reset`,
    });
    expect(ownReset.statusCode, ownReset.body).toBe(200);
    expect(ownReset.json()).toMatchObject({ tenantVersion: 0, userVersion: 0 });
    expect((await proofSnapshot()).outbox).toBe("[]");
  });

  it("resets only the current actor's exact personal surface overlay with replay evidence", async () => {
    const surfaceUrl = "/v1/platform/presentation/surfaces/surface.mission-control";
    const initial = await signedRequest({ method: "GET", url: surfaceUrl });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({ overlayVersion: 0, source: "code_default" });

    const overlay = await signedRequest({
      body: {
        expectedVersion: 0,
        placements: initial.json().effectivePlacements,
      },
      idempotencyKey: randomUUID(),
      method: "POST",
      url: `${surfaceUrl}/overlay`,
    });
    expect(overlay.statusCode, overlay.body).toBe(200);
    expect(overlay.json()).toMatchObject({ overlayVersion: 1, source: "user_overlay" });

    const resetKey = randomUUID();
    const reset = await signedRequest({
      body: { expectedVersion: 1 },
      idempotencyKey: resetKey,
      method: "POST",
      url: `${surfaceUrl}/overlay/reset`,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.headers["idempotent-replayed"]).toBe("false");
    expect(reset.json()).toMatchObject({
      billingState: "non_billable",
      overlayVersion: 0,
      replayed: false,
      source: "code_default",
    });

    const replay = await signedRequest({
      body: { expectedVersion: 1 },
      idempotencyKey: resetKey,
      method: "POST",
      url: `${surfaceUrl}/overlay/reset`,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual({ ...reset.json(), replayed: true });

    const crossTenant = await signedRequest({
      body: { expectedVersion: 1 },
      idempotencyKey: randomUUID(),
      method: "POST",
      tenantId: ids.otherTenant,
      url: `${surfaceUrl}/overlay/reset`,
    });
    expect([crossTenant.statusCode, crossTenant.json().code]).toEqual([
      403,
      "ACTOR_NOT_ACTIVE_MEMBER",
    ]);
    const client = await migrationPool.connect();
    try {
      const state = await tenantTransaction(client, async () =>
        client.query<{ evidence_count: number; outbox_count: number }>(
          `SELECT
             (SELECT count(*)::integer FROM evidence_events
              WHERE tenant_id=$1 AND subject_type='platform_presentation_surface_overlay')
               AS evidence_count,
             (SELECT count(*)::integer FROM outbox_events
              WHERE tenant_id=$1 AND event_type LIKE 'platform.presentation.surface_overlay.%')
               AS outbox_count`,
          [ids.tenant],
        ),
      );
      expect(state.rows[0]).toEqual({ evidence_count: 2, outbox_count: 0 });
    } finally {
      client.release();
    }
  });

  it("discovers a personal editor only through current read and write capabilities", async () => {
    const surfaceUrl = "/v1/platform/presentation/surfaces/surface.mission-control";
    const editorUrl = `${surfaceUrl}/personal-editor`;
    const initial = await signedRequest({ method: "GET", url: editorUrl });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      editable: true,
      layout: {
        overlayVersion: 0,
        surfaceId: "surface.mission-control",
      },
      lockReason: null,
      resettable: true,
    });

    await setEmployeeLayoutCapability("platform.presentation.layouts.reset_own", false);
    const resetLocked = await signedRequest({ method: "GET", url: editorUrl });
    expect(resetLocked.statusCode, resetLocked.body).toBe(200);
    expect(resetLocked.json()).toMatchObject({
      editable: true,
      lockReason: null,
      resettable: false,
    });
    await setEmployeeLayoutCapability("platform.presentation.layouts.reset_own", true);

    await setEmployeeLayoutCapability("platform.presentation.layouts.write_own", false);
    const locked = await signedRequest({ method: "GET", url: editorUrl });
    expect(locked.statusCode, locked.body).toBe(200);
    expect(locked.json()).toMatchObject({
      editable: false,
      lockReason: "layout_write_capability_absent",
      resettable: true,
    });
    const beforeDenied = await migrationPool.query<{
      evidence_count: number;
      outbox_count: number;
      overlay_count: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM presentation_surface_overlays
          WHERE tenant_id=$1 AND principal_id=$2) overlay_count,
         (SELECT count(*)::integer FROM evidence_events
          WHERE tenant_id=$1 AND subject_type='platform_presentation_surface_overlay')
           evidence_count,
         (SELECT count(*)::integer FROM outbox_events
          WHERE tenant_id=$1 AND event_type LIKE 'platform.presentation.surface_overlay.%')
           outbox_count`,
      [ids.tenant, ids.employee],
    );
    const denied = await signedRequest({
      body: {
        expectedVersion: 0,
        placements: initial.json().layout.effectivePlacements,
      },
      idempotencyKey: randomUUID(),
      method: "POST",
      url: `${surfaceUrl}/overlay`,
    });
    expect([denied.statusCode, denied.json().code]).toEqual([403, "POLICY_DENIED"]);
    expect(
      await migrationPool.query(
        `SELECT
           (SELECT count(*)::integer FROM presentation_surface_overlays
            WHERE tenant_id=$1 AND principal_id=$2) overlay_count,
           (SELECT count(*)::integer FROM evidence_events
            WHERE tenant_id=$1 AND subject_type='platform_presentation_surface_overlay')
             evidence_count,
           (SELECT count(*)::integer FROM outbox_events
            WHERE tenant_id=$1 AND event_type LIKE 'platform.presentation.surface_overlay.%')
             outbox_count`,
        [ids.tenant, ids.employee],
      ),
    ).toMatchObject({ rows: beforeDenied.rows });

    await setEmployeeLayoutCapability("platform.presentation.layouts.write_own", true);
    await setEmployeeLayoutCapability("platform.presentation.layouts.read_own", false);
    const unreadable = await signedRequest({ method: "GET", url: editorUrl });
    expect([unreadable.statusCode, unreadable.json().code]).toEqual([403, "POLICY_DENIED"]);
    await setEmployeeLayoutCapability("platform.presentation.layouts.read_own", true);

    const crossTenant = await signedRequest({
      method: "GET",
      tenantId: ids.otherTenant,
      url: editorUrl,
    });
    expect([crossTenant.statusCode, crossTenant.json().code]).toEqual([
      403,
      "ACTOR_NOT_ACTIVE_MEMBER",
    ]);
  });
});
