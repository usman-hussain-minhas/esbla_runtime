import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";
import { createServer } from "./server.js";

const servers = [] as ReturnType<typeof createServer>[];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("runtime probes", () => {
  const secret = "development-only-secret-with-at-least-32-bytes";

  function testServer(query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] })) {
    const server = createServer({
      authenticate: createDevelopmentAuthenticator({ secret }),
      logger: false,
      pool: { query } as unknown as Pool,
    });
    servers.push(server);
    return { query, server };
  }

  it("answers liveness without touching PostgreSQL", async () => {
    const { query, server } = testServer();
    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(query).not.toHaveBeenCalled();
  });

  it("reports readiness only after PostgreSQL answers", async () => {
    const { query, server } = testServer();
    const response = await server.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("fails readiness closed without leaking the database error", async () => {
    const { server } = testServer(vi.fn().mockRejectedValue(new Error("secret database detail")));
    const response = await server.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.body).not.toContain("secret database detail");
  });

  it("protects admitted Employment Record service-control routes before PostgreSQL access", async () => {
    const { query, server } = testServer();
    const idempotencyKey = randomUUID();
    for (const request of [
      { method: "GET", url: "/v1/hr/employment-records/service-control" },
      {
        body: { expectedVersion: null },
        headers: { "idempotency-key": idempotencyKey },
        method: "POST",
        url: "/v1/hr/employment-records/service-control/activate",
      },
      {
        body: { expectedVersion: 1 },
        headers: { "idempotency-key": idempotencyKey },
        method: "POST",
        url: "/v1/hr/employment-records/service-control/deactivate",
      },
      {
        body: {
          expectedSettingsVersion: 1,
          settings: {
            effectiveRangeOverlapAllowed: false,
            employmentTypeCodes: "unspecified",
          },
        },
        headers: { "idempotency-key": idempotencyKey },
        method: "PATCH",
        url: "/v1/hr/employment-records/service-control/settings",
      },
    ] as const) {
      expect((await server.inject(request)).statusCode).toBe(401);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("protects the admitted Employment Record read routes before PostgreSQL access", async () => {
    const { query, server } = testServer();
    for (const url of ["/v1/hr/employment-records", "/v1/hr/employment-records/service-control"]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps every Shift Assignment route dormant without touching PostgreSQL", async () => {
    const { query, server } = testServer();
    const rosterVersionId = randomUUID();
    const shiftAssignmentId = randomUUID();
    for (const request of [
      { method: "POST", url: "/v1/hr/shift-rosters" },
      {
        method: "POST",
        url: `/v1/hr/shift-rosters/${rosterVersionId}/assignments`,
      },
      {
        method: "POST",
        url: `/v1/hr/shift-rosters/${rosterVersionId}/publish`,
      },
      {
        method: "POST",
        url: `/v1/hr/shift-assignments/${shiftAssignmentId}/cancel`,
      },
      {
        method: "GET",
        url: `/v1/hr/shift-assignments/by-id/${shiftAssignmentId}`,
      },
      { method: "GET", url: "/v1/hr/shift-assignments" },
      { method: "GET", url: "/v1/hr/shift-rosters/service-control" },
      {
        method: "POST",
        url: "/v1/hr/shift-rosters/service-control/activate",
      },
      {
        method: "POST",
        url: "/v1/hr/shift-rosters/service-control/deactivate",
      },
      {
        method: "PATCH",
        url: "/v1/hr/shift-rosters/service-control/settings",
      },
    ] as const) {
      expect((await server.inject(request)).statusCode).toBe(404);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("turns unexpected API failures into opaque problem details", async () => {
    const requestId = randomUUID();
    const principalId = randomUUID();
    const tenantId = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const url = "/v1/hr/leave-requests";
    const server = createServer({
      authenticate: createDevelopmentAuthenticator({ secret }),
      logger: false,
      pool: {
        connect: vi.fn().mockRejectedValue(new Error("private connection string and stack")),
      } as unknown as Pool,
    });
    servers.push(server);
    const signature = signDevelopmentPrincipal(secret, {
      method: "GET",
      principalId,
      requestId,
      tenantId,
      timestamp,
      url,
    });
    const response = await server.inject({
      headers: {
        "x-esbla-auth-signature": signature,
        "x-esbla-auth-timestamp": timestamp,
        "x-esbla-principal-id": principalId,
        "x-esbla-request-id": requestId,
        "x-esbla-tenant-id": tenantId,
      },
      method: "GET",
      url,
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toMatchObject({
      code: "UNEXPECTED_SERVER_ERROR",
      requestId,
      status: 500,
    });
    expect(response.body).not.toContain("private connection string");
    expect(response.body).not.toContain("stack");
  });
});

describe("development principal configuration", () => {
  it("cannot be enabled in production", () => {
    expect(() =>
      createDevelopmentAuthenticator({
        environment: "production",
        secret: "development-only-secret-with-at-least-32-bytes",
      }),
    ).toThrow("Development principal authentication is forbidden in production");
  });

  it("rejects weak secrets and invalid signature lifetimes", () => {
    expect(() => createDevelopmentAuthenticator({ secret: "short" })).toThrow("at least 32 bytes");
    expect(() =>
      createDevelopmentAuthenticator({
        maxAgeSeconds: 0,
        secret: "development-only-secret-with-at-least-32-bytes",
      }),
    ).toThrow("positive integer");
  });
});
