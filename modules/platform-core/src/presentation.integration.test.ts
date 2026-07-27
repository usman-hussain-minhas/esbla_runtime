import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformError } from "./errors.js";
import {
  getOwnPresentationPreferences,
  getOwnPresentationServiceGroups,
  getOwnPresentationSurfaceLayout,
  updateOwnPresentationPreferences,
  updateOwnPresentationSurfaceOverlay,
} from "./presentation.js";

const ids = {
  actorA: "91000000-0000-4000-8000-000000000001",
  actorB: "91000000-0000-4000-8000-000000000002",
  membershipA: "92000000-0000-4000-8000-000000000001",
  membershipB: "92000000-0000-4000-8000-000000000002",
  tenantA: "90000000-0000-4000-8000-000000000001",
  tenantB: "90000000-0000-4000-8000-000000000002",
} as const;

let migrationPool: Pool;
let pool: Pool;

function context(tenantId: string, actorPrincipalId: string, correlationId = randomUUID()) {
  return { actorPrincipalId, correlationId, tenantId };
}

async function insertMembership(
  tenantId: string,
  membershipId: string,
  principalId: string,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, status)
       VALUES ($1, $2, $3, 'employee', 'active')`,
      [membershipId, tenantId, principalId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setLeavePresentationEligibility(
  tenantId: string,
  principalId: string,
  input: { readonly active: boolean; readonly capabilities: readonly string[] },
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'hr.leave_request', $2, 1)
       ON CONFLICT (tenant_id, service_key)
       DO UPDATE SET state = EXCLUDED.state, version = service_activations.version + 1`,
      [tenantId, input.active ? "active" : "inactive"],
    );
    await client.query(
      `DELETE FROM membership_capabilities
       WHERE tenant_id = $1 AND principal_id = $2
         AND capability_id = ANY($3::text[])`,
      [tenantId, principalId, ["hr.leave.list_own", "hr.leave.view"]],
    );
    if (input.capabilities.length > 0) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1, $2, capability_id
         FROM unnest($3::text[]) AS capability(capability_id)`,
        [tenantId, principalId, input.capabilities],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setWorkforcePresentationEligibility(
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)
       ON CONFLICT (tenant_id, service_key) DO NOTHING`,
      [tenantId],
    );
    await client.query(
      `DELETE FROM membership_capabilities
       WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = 'hr.workforce.view_own'`,
      [tenantId, principalId],
    );
    if (eligible) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.workforce.view_own')`,
        [tenantId, principalId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function surfaceBaseCounts(tenantId: string): Promise<{
  readonly heads: number;
  readonly versions: number;
}> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{
      heads: number;
      versions: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM presentation_surface_heads
          WHERE tenant_id = $1) AS heads,
         (SELECT count(*)::integer FROM presentation_surface_versions
          WHERE tenant_id = $1) AS versions`,
      [tenantId],
    );
    await client.query("ROLLBACK");
    const row = result.rows[0];
    if (!row) throw new Error("Surface base count query returned no row");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (
    !connectionString ||
    !migrationConnectionString ||
    !applicationRole ||
    !/^[a-z_][a-z0-9_]*$/.test(applicationRole)
  ) {
    throw new Error("PostgreSQL fixture variables are required");
  }
  migrationPool = createDatabasePool(migrationConnectionString, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Presentation A'), ($2, 'Presentation B')`,
    [ids.tenantA, ids.tenantB],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Actor A'), ($2, 'Actor B')`,
    [ids.actorA, ids.actorB],
  );
  await insertMembership(ids.tenantA, ids.membershipA, ids.actorA);
  await insertMembership(ids.tenantB, ids.membershipB, ids.actorB);
  await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
    active: true,
    capabilities: ["hr.leave.list_own", "hr.leave.view"],
  });
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities, service_activations TO ${applicationRole}`,
  );
  pool = createDatabasePool(connectionString, { max: 4 });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("presentation preference persistence", () => {
  it("persists independent palette and contrast values through a pool restart", async () => {
    const initial = await getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA));
    expect(initial).toEqual({
      highContrast: false,
      palette: "light",
      source: "code_default",
      version: 0,
    });

    const mutationContext = context(ids.tenantA, ids.actorA);
    const updated = await updateOwnPresentationPreferences(pool, mutationContext, {
      expectedVersion: 0,
      highContrast: true,
      palette: "dark",
    });
    expect(updated).toMatchObject({
      billingState: "non_billable",
      highContrast: true,
      palette: "dark",
      replayed: false,
      source: "user_override",
      version: 1,
    });
    expect(
      await updateOwnPresentationPreferences(pool, mutationContext, {
        expectedVersion: 0,
        highContrast: true,
        palette: "dark",
      }),
    ).toEqual({ ...updated, replayed: true });

    const stored = await migrationPool.connect();
    try {
      await stored.query("BEGIN");
      await stored.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await stored.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.actorA]);
      const rows = await stored.query<{ setting_key: string; value: unknown; version: number }>(
        `SELECT setting_key, value, version
         FROM presentation_setting_values
         WHERE tenant_id = $1 AND subject_type = 'user_override' AND subject_id = $2
         ORDER BY setting_key`,
        [ids.tenantA, ids.actorA],
      );
      expect(rows.rows).toEqual([
        { setting_key: "appearance.high_contrast.v1", value: true, version: 1 },
        { setting_key: "appearance.palette.v1", value: "dark", version: 1 },
      ]);
      await stored.query("ROLLBACK");
    } finally {
      stored.release();
    }

    await pool.end();
    pool = createDatabasePool(process.env.DATABASE_URL ?? "", { max: 4 });
    expect(await getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA))).toEqual({
      highContrast: true,
      palette: "dark",
      source: "user_override",
      version: 1,
    });
  });

  it("materializes distinct bases and persists an own overlay through a pool restart", async () => {
    expect(await surfaceBaseCounts(ids.tenantA)).toEqual({ heads: 0, versions: 0 });

    const missionControl = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.mission-control",
    );
    const hrMissionControl = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.hr.mission-control",
    );
    expect(missionControl).toMatchObject({
      baseVersion: 1,
      overlayVersion: 0,
      source: "code_default",
      surfaceId: "surface.mission-control",
    });
    expect(hrMissionControl).toMatchObject({
      baseVersion: 1,
      overlayVersion: 0,
      source: "code_default",
      surfaceId: "surface.hr.mission-control",
    });
    expect(missionControl.baseDefinitionHash).not.toBe(hrMissionControl.baseDefinitionHash);

    expect(await surfaceBaseCounts(ids.tenantA)).toEqual({ heads: 0, versions: 0 });

    const mutationContext = context(ids.tenantA, ids.actorA);
    const updated = await updateOwnPresentationSurfaceOverlay(
      pool,
      mutationContext,
      "surface.mission-control",
      {
        expectedVersion: 0,
        placements: [
          {
            column: 2,
            columnSpan: 4,
            instanceId: "mission-control.my-leave",
            row: 5,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
          },
        ],
      },
    );
    expect(updated).toMatchObject({
      billingState: "non_billable",
      overlayVersion: 1,
      replayed: false,
      source: "user_overlay",
    });
    expect(
      await updateOwnPresentationSurfaceOverlay(pool, mutationContext, "surface.mission-control", {
        expectedVersion: 0,
        placements: updated.effectivePlacements,
      }),
    ).toEqual({ ...updated, replayed: true });

    expect(await surfaceBaseCounts(ids.tenantA)).toEqual({ heads: 2, versions: 2 });

    await pool.end();
    pool = createDatabasePool(process.env.DATABASE_URL ?? "", { max: 4 });
    expect(
      await getOwnPresentationSurfaceLayout(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.mission-control",
      ),
    ).toMatchObject({
      effectivePlacements: updated.effectivePlacements,
      overlayVersion: 1,
      source: "user_overlay",
    });
  });

  it("filters discovery and blocks layout mutation after capability loss or deactivation", async () => {
    const eligible = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.mission-control",
    );
    expect(eligible.effectivePlacements).toHaveLength(1);

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own"],
    });
    const capabilityRevoked = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.mission-control",
    );
    expect(capabilityRevoked.basePlacements).toEqual([]);
    expect(capabilityRevoked.effectivePlacements).toEqual([]);
    await expect(
      getOwnPresentationSurfaceLayout(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.hr.mission-control",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    await expect(
      updateOwnPresentationSurfaceOverlay(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.mission-control",
        {
          expectedVersion: eligible.overlayVersion,
          placements: eligible.effectivePlacements,
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: false,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    expect(
      (
        await getOwnPresentationSurfaceLayout(
          pool,
          context(ids.tenantA, ids.actorA),
          "surface.mission-control",
        )
      ).effectivePlacements,
    ).toEqual([]);
    await expect(
      getOwnPresentationSurfaceLayout(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.hr.mission-control",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
  });

  it("discovers HR from any active actor-eligible included service without loading service data", async () => {
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: ["hr"],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: false,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: [],
    });
    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, true);
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: ["hr"],
    });
    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, false);
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: [],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.submit"],
    });
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: [],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
  });

  it("fails closed across tenants, suspended actors, and stale CAS writers", async () => {
    await expect(
      getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorB)),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" } satisfies Partial<PlatformError>);

    await expect(
      updateOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA), {
        expectedVersion: 0,
        highContrast: false,
        palette: "light",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<PlatformError>);

    const client = await migrationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await client.query(
        `UPDATE memberships SET status = 'suspended'
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenantA, ids.actorA],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expect(
      getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA)),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" } satisfies Partial<PlatformError>);
  });
});
