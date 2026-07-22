import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lockMembershipAuthority, withTenantTransaction } from "./context.js";

const mockContext = {
  actorPrincipalId: "10000000-0000-4000-8000-000000000001",
  correlationId: "30000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000001",
} as const;

const databaseIds = {
  correlation: "30000000-0000-4000-8000-000000000009",
  membership: "20000000-0000-4000-8000-000000000009",
  membershipOther: "20000000-0000-4000-8000-000000000010",
  principal: "10000000-0000-4000-8000-000000000009",
  principalOther: "10000000-0000-4000-8000-000000000010",
  tenant: "00000000-0000-4000-8000-000000000009",
  tenantOther: "00000000-0000-4000-8000-000000000010",
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
    `GRANT SELECT, INSERT, UPDATE ON service_activations TO ${applicationRole}`,
  );

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Context lock tenant'), ($2, 'Context lock other tenant')
     ON CONFLICT DO NOTHING`,
    [databaseIds.tenant, databaseIds.tenantOther],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Context lock actor'), ($2, 'Context lock other actor')
     ON CONFLICT DO NOTHING`,
    [databaseIds.principal, databaseIds.principalOther],
  );
  const client = await migrationPool.connect();
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
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenantOther]);
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'manager') ON CONFLICT DO NOTHING`,
      [databaseIds.membershipOther, databaseIds.tenantOther, databaseIds.principalOther],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  applicationPool = createDatabasePool(connectionString, { max: 3 });
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

async function competingMembershipUpdate() {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '250ms'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenant]);
    await client.query(
      `UPDATE memberships SET role_key = role_key
       WHERE tenant_id = $1 AND principal_id = $2`,
      [databaseIds.tenant, databaseIds.principal],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("service-bound tenant transaction", () => {
  it("reads locked membership authority with SELECT-only Runtime privilege", async () => {
    const privilege = await migrationPool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_insert_column: boolean;
      can_references: boolean;
      can_references_column: boolean;
      can_select: boolean;
      can_trigger: boolean;
      can_truncate: boolean;
      can_update: boolean;
      can_update_column: boolean;
    }>(
      `SELECT has_table_privilege('esbla_app','memberships','SELECT') can_select,
              has_table_privilege('esbla_app','memberships','INSERT') can_insert,
              has_any_column_privilege('esbla_app','memberships','INSERT') can_insert_column,
              has_table_privilege('esbla_app','memberships','UPDATE') can_update,
              has_any_column_privilege('esbla_app','memberships','UPDATE') can_update_column,
              has_table_privilege('esbla_app','memberships','DELETE') can_delete,
              has_table_privilege('esbla_app','memberships','TRUNCATE') can_truncate,
              has_table_privilege('esbla_app','memberships','REFERENCES') can_references,
              has_any_column_privilege('esbla_app','memberships','REFERENCES')
                can_references_column,
              has_table_privilege('esbla_app','memberships','TRIGGER') can_trigger`,
    );
    expect(privilege.rows).toEqual([
      {
        can_delete: false,
        can_insert: false,
        can_insert_column: false,
        can_references: false,
        can_references_column: false,
        can_select: true,
        can_trigger: false,
        can_truncate: false,
        can_update: false,
        can_update_column: false,
      },
    ]);
    await expect(
      withTenantTransaction(applicationPool, databaseContext(), async ({ actor }) => actor),
    ).resolves.toEqual({ principalId: databaseIds.principal, roleKey: "tenant_admin" });
  });

  it("installs one exact capability-bearing membership lock boundary", async () => {
    const result = await migrationPool.query(
      `SELECT pg_catalog.pg_get_userbyid(procedure.proowner) owner,
              pg_catalog.pg_get_function_identity_arguments(procedure.oid) arguments,
              pg_catalog.format_type(procedure.prorettype, NULL) return_type,
              procedure.prosecdef security_definer,
              procedure.proisstrict strict,
              procedure.proleakproof leakproof,
              procedure.proretset set_returning,
              procedure.provolatile::text volatility,
              procedure.proparallel::text parallel,
              pg_catalog.array_to_string(procedure.proconfig, ',') config,
              pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc, 'UTF8')), 'hex'
              ) source_sha256,
              EXISTS (
                SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
                  procedure.proacl, pg_catalog.acldefault('f', procedure.proowner)
                )) privilege
                WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
              ) public_executable,
              EXISTS (
                SELECT 1
                FROM pg_catalog.aclexplode(COALESCE(
                  procedure.proacl, pg_catalog.acldefault('f', procedure.proowner)
                )) privilege
                JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
                WHERE role.rolname = 'esbla_app' AND privilege.privilege_type = 'EXECUTE'
              ) application_executable,
              NOT EXISTS (
                SELECT 1
                FROM pg_catalog.aclexplode(COALESCE(
                  procedure.proacl, pg_catalog.acldefault('f', procedure.proowner)
                )) privilege
                WHERE privilege.privilege_type = 'EXECUTE'
                  AND privilege.grantee <> procedure.proowner
                  AND privilege.grantee <> (
                    SELECT role.oid FROM pg_catalog.pg_roles role
                    WHERE role.rolname = 'esbla_app'
                  )
              ) only_owner_and_application,
              NOT EXISTS (
                SELECT 1
                FROM pg_catalog.aclexplode(COALESCE(
                  procedure.proacl, pg_catalog.acldefault('f', procedure.proowner)
                )) privilege
                JOIN pg_catalog.pg_roles role ON role.oid = privilege.grantee
                WHERE role.rolname = 'esbla_app'
                  AND privilege.privilege_type = 'EXECUTE'
                  AND privilege.is_grantable
              ) application_cannot_grant
       FROM pg_catalog.pg_proc procedure
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.proname = 'esbla_lock_membership_authority'`,
    );
    expect(result.rows).toEqual([
      {
        application_cannot_grant: true,
        application_executable: true,
        arguments:
          "expected_tenant_id uuid, expected_actor_principal_id uuid, subject_principal_id uuid",
        config: "search_path=pg_catalog,row_security=on",
        leakproof: false,
        only_owner_and_application: true,
        owner: "esbla_migrator",
        parallel: "u",
        public_executable: false,
        return_type: "jsonb",
        security_definer: true,
        set_returning: false,
        source_sha256: "917b3c6562f9c66396fe497defff14140a7acaef70fbe861f498f8fc15a4849a",
        strict: false,
        volatility: "v",
      },
    ]);
  });

  it("binds the protected lock to exact tenant and actor context", async () => {
    await expect(
      applicationPool.query(`SELECT public.esbla_lock_membership_authority($1, $2, $3)`, [
        databaseIds.tenant,
        databaseIds.principal,
        databaseIds.principal,
      ]),
    ).rejects.toMatchObject({ code: "42501" });

    const client = await applicationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenant]);
      await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
        databaseIds.principal,
      ]);
      await expect(
        client.query(`SELECT public.esbla_lock_membership_authority($1, $2, $3)`, [
          databaseIds.tenantOther,
          databaseIds.principal,
          databaseIds.principal,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenant]);
      await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
        databaseIds.principal,
      ]);
      await expect(
        lockMembershipAuthority(client, databaseContext(), databaseIds.principalOther),
      ).resolves.toBeNull();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it.each([
    undefined,
    {},
    { roleKey: " tenant_admin", status: "active" },
    { extra: true, roleKey: "tenant_admin", status: "active" },
    { roleKey: "tenant_admin", status: "unknown" },
  ])("rejects malformed membership authority output %#", async (authority) => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ authority }] })),
    } as unknown as PoolClient;
    await expect(
      lockMembershipAuthority(client, mockContext, mockContext.actorPrincipalId),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("blocks direct Runtime membership mutation without changing authority", async () => {
    const client = await applicationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenant]);
      await expect(
        client.query(
          `UPDATE memberships SET role_key = 'employee'
           WHERE tenant_id = $1 AND principal_id = $2`,
          [databaseIds.tenant, databaseIds.principal],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const selected = await migrationPool.connect();
    try {
      await selected.query("BEGIN");
      await selected.query("SELECT set_config('app.tenant_id', $1, true)", [databaseIds.tenant]);
      const membership = await selected.query(
        `SELECT role_key, status FROM memberships
         WHERE tenant_id = $1 AND principal_id = $2`,
        [databaseIds.tenant, databaseIds.principal],
      );
      expect(membership.rows).toEqual([{ role_key: "tenant_admin", status: "active" }]);
      await selected.query("COMMIT");
    } catch (error) {
      await selected.query("ROLLBACK");
      throw error;
    } finally {
      selected.release();
    }
  });

  it("holds membership authority through commit and then releases it", async () => {
    const locked = gate();
    const release = gate();
    const holder = withTenantTransaction(applicationPool, databaseContext(), async () => {
      locked.open();
      await release.promise;
    });
    await locked.promise;
    try {
      await expect(competingMembershipUpdate()).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release.open();
    }
    await holder;
    await expect(competingMembershipUpdate()).resolves.toBeUndefined();
  });

  it("holds membership authority through rollback and then releases it", async () => {
    const locked = gate();
    const release = gate();
    const holder = withTenantTransaction(applicationPool, databaseContext(), async () => {
      locked.open();
      await release.promise;
      throw new Error("force membership-lock rollback");
    });
    await locked.promise;
    try {
      await expect(competingMembershipUpdate()).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release.open();
    }
    await expect(holder).rejects.toThrow("force membership-lock rollback");
    await expect(competingMembershipUpdate()).resolves.toBeUndefined();
  });

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
        if (statement.includes("esbla_lock_membership_authority")) {
          return { rows: [{ authority: { roleKey: "hr_operator", status: "active" } }] };
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
    const membershipIndex = statements.findIndex((value) =>
      value.includes("esbla_lock_membership_authority"),
    );
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
    expect(statements.some((value) => value.includes("esbla_lock_membership_authority"))).toBe(
      false,
    );
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
        if (statement.includes("esbla_lock_membership_authority")) {
          return { rows: [{ authority: { roleKey: "tenant_admin", status: "active" } }] };
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
    expect(statements.some((value) => value.includes("esbla_lock_membership_authority"))).toBe(
      false,
    );
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
    expect(statements.some((value) => value.includes("esbla_lock_membership_authority"))).toBe(
      false,
    );
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
