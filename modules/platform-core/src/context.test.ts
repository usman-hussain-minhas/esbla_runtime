import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTransaction } from "./context.js";

const mockContext = {
  actorPrincipalId: "10000000-0000-4000-8000-000000000001",
  correlationId: "30000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000001",
} as const;

const databaseIds = {
  correlation: "30000000-0000-4000-8000-000000000009",
  membership: "20000000-0000-4000-8000-000000000009",
  principal: "10000000-0000-4000-8000-000000000009",
  tenant: "00000000-0000-4000-8000-000000000009",
} as const;

const serviceKey = "test.service_bound_transaction";
let applicationPool: Pool;
let migrationPool: Pool;

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
  await migrationPool.query(`GRANT SELECT, INSERT ON tenants, principals TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE ON memberships, service_activations TO ${applicationRole}`,
  );

  applicationPool = createDatabasePool(connectionString, { max: 3 });
  await applicationPool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Context lock tenant')
     ON CONFLICT DO NOTHING`,
    [databaseIds.tenant],
  );
  await applicationPool.query(
    `INSERT INTO principals (principal_id, display_name) VALUES ($1, 'Context lock actor')
     ON CONFLICT DO NOTHING`,
    [databaseIds.principal],
  );
  const client = await applicationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenant]);
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'tenant_admin') ON CONFLICT DO NOTHING`,
      [databaseIds.membership, databaseIds.tenant, databaseIds.principal],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, $2, 'active', 1) ON CONFLICT DO NOTHING`,
      [databaseIds.tenant, serviceKey],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await applicationPool.end();
  await migrationPool.end();
});

function databaseContext(correlationId: string = databaseIds.correlation) {
  return {
    actorPrincipalId: databaseIds.principal,
    correlationId,
    tenantId: databaseIds.tenant,
  };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

async function competingStatement(statement: string) {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '250ms'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenant]);
    await client.query(statement, [databaseIds.tenant, serviceKey]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("service-bound tenant transaction", () => {
  it("locks activation before reading current membership", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        if (statement.includes("FROM service_activations")) {
          return {
            rows: [{ service_key: "workforce_profile", state: "active", version: 2 }],
          };
        }
        if (statement.includes("FROM memberships")) {
          return { rows: [{ role_key: "hr_operator", status: "active" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await withTenantTransaction(
      pool,
      mockContext,
      async (transaction) => {
        expect(transaction.actor.roleKey).toBe("hr_operator");
        expect(transaction.lockedServiceActivation).toEqual({
          serviceKey: "workforce_profile",
          state: "active",
          version: 2,
        });
      },
      { serviceActivationKey: "workforce_profile" },
    );

    const activationIndex = statements.findIndex((value) =>
      value.includes("FROM service_activations"),
    );
    const membershipIndex = statements.findIndex((value) => value.includes("FROM memberships"));
    expect(activationIndex).toBeGreaterThan(-1);
    expect(membershipIndex).toBeGreaterThan(activationIndex);
  });

  it("rejects an invalid activation key before membership authority is read", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(
      withTenantTransaction(pool, mockContext, async () => undefined, {
        serviceActivationKey: "../invalid",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SERVICE_KEY" });
    expect(statements.some((value) => value.includes("FROM memberships"))).toBe(false);
  });

  it("uses an update lock for activation lifecycle mutations", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        if (statement.includes("FROM service_activations")) {
          return {
            rows: [{ service_key: "workforce_profile", state: "active", version: 1 }],
          };
        }
        if (statement.includes("FROM memberships")) {
          return { rows: [{ role_key: "tenant_admin", status: "active" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await withTenantTransaction(pool, mockContext, async () => undefined, {
      serviceActivationKey: "workforce_profile",
      serviceActivationLock: "update",
    });

    expect(statements.find((value) => value.includes("FROM service_activations"))).toContain(
      "FOR UPDATE",
    );
  });

  it("rejects a lock mode without a service key before membership authority is read", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(
      withTenantTransaction(pool, mockContext, async () => undefined, {
        serviceActivationLock: "update",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SERVICE_KEY" });
    expect(statements.some((value) => value.includes("FROM memberships"))).toBe(false);
  });

  it("rejects an invalid runtime lock mode before activation or membership is read", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(
      withTenantTransaction(pool, mockContext, async () => undefined, {
        serviceActivationKey: serviceKey,
        serviceActivationLock: "exclusive" as "share",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SERVICE_KEY" });
    expect(statements.some((value) => value.includes("FROM service_activations"))).toBe(false);
    expect(statements.some((value) => value.includes("FROM memberships"))).toBe(false);
  });

  it("holds the default share lock until cooperative commit", async () => {
    const locked = gate();
    const release = gate();
    const holder = withTenantTransaction(
      applicationPool,
      databaseContext(),
      async () => {
        locked.open();
        await release.promise;
      },
      { serviceActivationKey: serviceKey },
    );
    await locked.promise;

    try {
      await expect(
        competingStatement(
          "UPDATE service_activations SET state = state WHERE tenant_id = $1 AND service_key = $2",
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release.open();
    }
    await holder;
    await expect(
      competingStatement(
        "UPDATE service_activations SET state = state WHERE tenant_id = $1 AND service_key = $2",
      ),
    ).resolves.toBeUndefined();
  });

  it("holds the update lock until rollback and then releases it", async () => {
    const locked = gate();
    const release = gate();
    const holder = withTenantTransaction(
      applicationPool,
      databaseContext("30000000-0000-4000-8000-000000000010"),
      async () => {
        locked.open();
        await release.promise;
        throw new Error("force activation-lock rollback");
      },
      { serviceActivationKey: serviceKey, serviceActivationLock: "update" },
    );
    await locked.promise;

    try {
      await expect(
        competingStatement(
          `SELECT service_key FROM service_activations
           WHERE tenant_id = $1 AND service_key = $2 FOR SHARE`,
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release.open();
    }
    await expect(holder).rejects.toThrow("force activation-lock rollback");
    await expect(
      competingStatement(
        `SELECT service_key FROM service_activations
         WHERE tenant_id = $1 AND service_key = $2 FOR SHARE`,
      ),
    ).resolves.toBeUndefined();
  });
});
