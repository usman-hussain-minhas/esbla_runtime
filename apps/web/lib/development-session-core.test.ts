import { signDevelopmentPrincipal } from "@esbla/contracts/development-principal";
import { describe, expect, it } from "vitest";
import {
  prepareDevelopmentRequest,
  readDevelopmentSessionConfig,
  summarizeDevelopmentSession,
} from "./development-session-core";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const principalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const secret = "development-only-secret-with-at-least-32-bytes";

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    ESBLA_API_BASE_URL: "http://127.0.0.1:3001",
    ESBLA_DEV_AUTH_SECRET: secret,
    ESBLA_DEV_PRINCIPAL_ID: principalId,
    ESBLA_DEV_SESSION_LABEL: "Usman local",
    ESBLA_DEV_TENANT_ID: tenantId,
    NODE_ENV: "development",
    ...overrides,
  };
}

describe("server-only development session boundary", () => {
  it("creates a safe summary without identity IDs or the signing secret", () => {
    const summary = summarizeDevelopmentSession(environment());
    expect(summary).toEqual({
      endpoint: "http://127.0.0.1:3001",
      label: "Usman local",
      state: "configured",
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(JSON.stringify(summary)).not.toContain(tenantId);
    expect(JSON.stringify(summary)).not.toContain(principalId);
  });

  it("fails closed for production, public secrets, remote origins, weak secrets, and invalid IDs", () => {
    expect(() => readDevelopmentSessionConfig(environment({ NODE_ENV: "production" }))).toThrow(
      "forbidden in production",
    );
    expect(() =>
      readDevelopmentSessionConfig(environment({ NEXT_PUBLIC_ESBLA_DEV_AUTH_SECRET: secret })),
    ).toThrow("NEXT_PUBLIC");
    expect(() =>
      readDevelopmentSessionConfig(environment({ ESBLA_API_BASE_URL: "https://api.example.com" })),
    ).toThrow("loopback");
    expect(() =>
      readDevelopmentSessionConfig(environment({ ESBLA_DEV_AUTH_SECRET: "short" })),
    ).toThrow("32 bytes");
    expect(() =>
      readDevelopmentSessionConfig(environment({ ESBLA_DEV_PRINCIPAL_ID: "principal" })),
    ).toThrow("UUID");
  });

  it("uses the shared signer and binds exact path, query, body, identity, and idempotency", () => {
    const config = readDevelopmentSessionConfig(environment());
    const body = { z: "last", a: "first" };
    const request = prepareDevelopmentRequest(
      config,
      {
        body,
        idempotencyKey,
        method: "POST",
        path: "/v1/hr/leave-requests?source=web",
      },
      {
        clock: () => new Date(1_777_777_777_000),
        requestId: () => requestId,
      },
    );
    expect(request.headers["x-esbla-auth-signature"]).toBe(
      signDevelopmentPrincipal(secret, {
        body,
        idempotencyKey,
        method: "POST",
        principalId,
        requestId,
        tenantId,
        timestamp: "1777777777",
        url: "/v1/hr/leave-requests?source=web",
      }),
    );
    expect(request.body).toBe(JSON.stringify(body));
    expect(JSON.stringify(request)).not.toContain(secret);
  });

  it("requires idempotency for mutations and rejects origin escape or read bodies", () => {
    const config = readDevelopmentSessionConfig(environment());
    expect(() =>
      prepareDevelopmentRequest(config, { method: "POST", path: "/v1/hr/leave-requests" }),
    ).toThrow("Idempotency-Key");
    expect(() =>
      prepareDevelopmentRequest(config, { method: "GET", path: "//example.com/escape" }),
    ).toThrow("origin-relative");
    expect(() =>
      prepareDevelopmentRequest(config, { body: {}, method: "GET", path: "/health" }),
    ).toThrow("must not include a body");
  });
});
