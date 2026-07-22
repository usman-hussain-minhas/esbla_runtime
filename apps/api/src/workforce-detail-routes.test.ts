import { randomUUID } from "node:crypto";
import { PlatformError } from "@esbla/platform-core";
import type { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";

const workforce = vi.hoisted(() => ({ getDetail: vi.fn(), listAuthorized: vi.fn() }));
vi.mock("@esbla/hr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@esbla/hr")>()),
  getAuthorizedWorkforceProfileDetail: workforce.getDetail,
  listAuthorizedWorkforceProfiles: workforce.listAuthorized,
}));

import { createServer } from "./server.js";

const secret = "development-only-secret-with-at-least-32-bytes";
const pool = {} as Pool;
const server = createServer({
  authenticate: createDevelopmentAuthenticator({ secret }),
  logger: false,
  pool,
});
function signedGet(url: string) {
  const principalId = randomUUID();
  const requestId = randomUUID();
  const tenantId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const operation = { actorPrincipalId: principalId, correlationId: requestId, tenantId };
  return {
    headers: {
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
    },
    operation,
    requestId,
  };
}
afterEach(() => {
  workforce.getDetail.mockReset();
  workforce.listAuthorized.mockReset();
});
afterAll(() => server.close());
describe("Workforce authorized-detail route", () => {
  it("maps the exact independent history cursors to one enriched response", async () => {
    const workerProfileId = randomUUID();
    const statusId = randomUUID();
    const relationshipId = randomUUID();
    const detail = {
      employeeNumber: "EMP-1",
      principalLinked: true,
      relationshipHistory: { items: [], nextCursor: null },
      statusHistory: { items: [], nextCursor: null },
      version: 4,
      workerProfileId,
      workforceStatus: "active",
    };
    workforce.getDetail.mockResolvedValueOnce(detail);
    const query =
      `pageSize=2&statusCursorEffectiveAt=2026-07-22T00%3A00%3A00.000Z` +
      `&statusCursorWorkforceStatusHistoryId=${statusId}` +
      `&relationshipCursorVersion=3&relationshipCursorReportingRelationshipId=${relationshipId}`;
    const url = `/v1/hr/workforce-profiles/by-id/${workerProfileId}?${query}`;
    const signed = signedGet(url);
    const response = await server.inject({ headers: signed.headers, method: "GET", url });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(detail);
    expect(workforce.getDetail).toHaveBeenCalledWith(pool, signed.operation, {
      pageSize: 2,
      relationshipCursor: { relationshipVersion: 3, reportingRelationshipId: relationshipId },
      statusCursor: {
        effectiveAt: "2026-07-22T00:00:00.000Z",
        workforceStatusHistoryId: statusId,
      },
      workerProfileId,
    });
  });
  it("authenticates first and rejects foreign, orphaned, or authority-bearing inputs", async () => {
    const workerProfileId = randomUUID();
    const unauthenticated = await server.inject({
      method: "GET",
      url: `/v1/hr/workforce-profiles/by-id/${workerProfileId}?include=history`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    for (const query of [
      "statusCursorEffectiveAt=2026-07-22T00%3A00%3A00.000Z",
      `statusCursorWorkforceStatusHistoryId=${randomUUID()}`,
      "relationshipCursorVersion=2",
      `relationshipCursorReportingRelationshipId=${randomUUID()}`,
      "pageSize=51",
      "include=history",
      "mode=manager",
      `tenantId=${randomUUID()}`,
      `actorPrincipalId=${randomUUID()}`,
      `cursorCreatedAt=2026-07-22T00%3A00%3A00.000Z&cursorWorkerProfileId=${randomUUID()}`,
    ]) {
      const url = `/v1/hr/workforce-profiles/by-id/${workerProfileId}?${query}`;
      const signed = signedGet(url);
      const response = await server.inject({ headers: signed.headers, method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "REQUEST_VALIDATION_FAILED",
        requestId: signed.requestId,
        status: 400,
      });
    }
    expect(workforce.getDetail).not.toHaveBeenCalled();
  });
  it("returns a sanitized policy denial without dispatching a success response", async () => {
    const workerProfileId = randomUUID();
    workforce.getDetail.mockRejectedValueOnce(
      new PlatformError("POLICY_DENIED", "Policy decision denied the action"),
    );
    const url = `/v1/hr/workforce-profiles/by-id/${workerProfileId}`;
    const signed = signedGet(url);
    const response = await server.inject({ headers: signed.headers, method: "GET", url });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "POLICY_DENIED",
      requestId: signed.requestId,
      status: 403,
    });
    expect(response.body).not.toContain(signed.operation.actorPrincipalId);
    expect(response.body).not.toContain(signed.operation.tenantId);
  });
  it("keeps enriched detail histories outside the list response boundary", async () => {
    const workerProfileId = randomUUID();
    workforce.listAuthorized.mockResolvedValueOnce({
      items: [
        {
          employeeNumber: null,
          principalLinked: true,
          relationshipHistory: { items: [], nextCursor: null },
          statusHistory: { items: [], nextCursor: null },
          version: 1,
          workerProfileId,
          workforceStatus: "active",
        },
      ],
      kind: "workforce",
      nextCursor: null,
    });
    const url = "/v1/hr/workforce-profiles?status=active";
    const signed = signedGet(url);
    const response = await server.inject({ headers: signed.headers, method: "GET", url });
    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toMatchObject({
      code: "UNEXPECTED_SERVER_ERROR",
      status: 500,
    });
    expect(response.body).not.toContain("statusHistory");
    expect(response.body).not.toContain("relationshipHistory");
  });
});
