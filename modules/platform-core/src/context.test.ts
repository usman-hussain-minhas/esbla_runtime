import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTenantTransaction } from "./context.js";

const context = {
  actorPrincipalId: "10000000-0000-4000-8000-000000000001",
  correlationId: "30000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000001",
} as const;

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
      context,
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
      withTenantTransaction(pool, context, async () => undefined, {
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

    await withTenantTransaction(pool, context, async () => undefined, {
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
      withTenantTransaction(pool, context, async () => undefined, {
        serviceActivationLock: "update",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SERVICE_KEY" });
    expect(statements.some((value) => value.includes("FROM memberships"))).toBe(false);
  });
});
