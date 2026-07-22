import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";

const workforce = vi.hoisted(() => ({ listAuthorized: vi.fn() }));
vi.mock("@esbla/hr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@esbla/hr")>()),
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

afterEach(() => workforce.listAuthorized.mockReset());
afterAll(() => server.close());

describe("Workforce authorized-list route", () => {
  it("maps strict HR and manager queries without accepting a client authority mode", async () => {
    const workerProfileId = randomUUID();
    const reportingRelationshipId = randomUUID();
    const profile = {
      employeeNumber: "EMP-1",
      principalLinked: true,
      version: 4,
      workerProfileId,
      workforceStatus: "active",
    };
    const workforcePage = {
      items: [profile],
      kind: "workforce",
      nextCursor: { createdAt: "2026-07-22T00:00:00.000Z", workerProfileId },
    };
    const directReportsPage = {
      items: [
        {
          profile,
          relationship: {
            effectiveAt: "2026-07-22T00:00:00.000Z",
            managerWorkerProfileId: randomUUID(),
            relationshipStatus: "assigned",
            relationshipVersion: 1,
            reportingRelationshipId,
            supersedesReportingRelationshipId: null,
            workerProfileId,
            workerProfileVersion: 4,
          },
        },
      ],
      kind: "direct_reports",
      nextCursor: {
        effectiveAt: "2026-07-22T00:00:00.000Z",
        reportingRelationshipId,
      },
    };
    workforce.listAuthorized
      .mockResolvedValueOnce(workforcePage)
      .mockResolvedValueOnce(directReportsPage);

    const hrUrl = "/v1/hr/workforce-profiles?status=active&pageSize=1";
    const hr = signedGet(hrUrl);
    const hrResponse = await server.inject({ headers: hr.headers, method: "GET", url: hrUrl });
    expect(hrResponse.statusCode, hrResponse.body).toBe(200);
    expect(hrResponse.json()).toEqual(workforcePage);
    expect(workforce.listAuthorized).toHaveBeenNthCalledWith(1, pool, hr.operation, {
      pageSize: 1,
      status: "active",
    });

    const managerUrl = "/v1/hr/workforce-profiles";
    const manager = signedGet(managerUrl);
    const managerResponse = await server.inject({
      headers: manager.headers,
      method: "GET",
      url: managerUrl,
    });
    expect(managerResponse.statusCode).toBe(200);
    expect(managerResponse.json()).toEqual(directReportsPage);
    expect(workforce.listAuthorized).toHaveBeenNthCalledWith(2, pool, manager.operation, {});
  });

  it("rejects orphaned or cross-provider cursors before the domain query", async () => {
    for (const query of [
      "status=active&cursorCreatedAt=2026-07-22T00%3A00%3A00.000Z",
      `cursorReportingRelationshipId=${randomUUID()}`,
      `status=active&cursorEffectiveAt=2026-07-22T00%3A00%3A00.000Z&cursorReportingRelationshipId=${randomUUID()}`,
      `cursorCreatedAt=2026-07-22T00%3A00%3A00.000Z&cursorWorkerProfileId=${randomUUID()}`,
      `status=active&cursorCreatedAt=2026-07-22T00%3A00%3A00.000Z&cursorWorkerProfileId=${randomUUID()}&cursorEffectiveAt=2026-07-22T00%3A00%3A00.000Z&cursorReportingRelationshipId=${randomUUID()}`,
      "mode=manager",
      "kind=workforce",
    ]) {
      const url = `/v1/hr/workforce-profiles?${query}`;
      const signed = signedGet(url);
      const response = await server.inject({ headers: signed.headers, method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "REQUEST_VALIDATION_FAILED",
        requestId: signed.requestId,
        status: 400,
      });
    }
    expect(workforce.listAuthorized).not.toHaveBeenCalled();
  });
});
