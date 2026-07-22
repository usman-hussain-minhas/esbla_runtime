import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDevelopmentAuthenticator, signDevelopmentPrincipal } from "./auth.js";

const workforce = vi.hoisted(() => ({ changeReportingRelationship: vi.fn() }));
vi.mock("@esbla/hr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@esbla/hr")>()),
  changeWorkforceReportingRelationship: workforce.changeReportingRelationship,
}));

import { createServer } from "./server.js";

const secret = "development-only-secret-with-at-least-32-bytes";
const server = createServer({
  authenticate: createDevelopmentAuthenticator({ secret }),
  logger: false,
  pool: {} as Pool,
});
function signedRequest(url: string, body: unknown, idempotencyKey = randomUUID()) {
  const principalId = randomUUID();
  const requestId = randomUUID();
  const tenantId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const operation = { actorPrincipalId: principalId, correlationId: idempotencyKey, tenantId };
  return {
    headers: {
      "idempotency-key": idempotencyKey,
      "x-esbla-auth-signature": signDevelopmentPrincipal(secret, {
        body,
        idempotencyKey,
        method: "POST",
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
afterEach(() => workforce.changeReportingRelationship.mockReset());
afterAll(() => server.close());
describe("Workforce reporting relationship route", () => {
  it("returns 201 for a mutation and 200 for its exact replay", async () => {
    const workerProfileId = randomUUID();
    const managerWorkerProfileId = randomUUID();
    const relationship = {
      effectiveAt: "2026-07-22T00:00:00.000Z",
      managerWorkerProfileId,
      relationshipStatus: "assigned",
      relationshipVersion: 1,
      reportingRelationshipId: randomUUID(),
      supersedesReportingRelationshipId: null,
      workerProfileId,
      workerProfileVersion: 4,
    };
    workforce.changeReportingRelationship
      .mockResolvedValueOnce({ billingState: "non_billable", relationship, replayed: false })
      .mockResolvedValueOnce({ billingState: "non_billable", relationship, replayed: true });
    const url = `/v1/hr/workforce-profiles/${workerProfileId}/reporting-relationships`;
    const idempotencyKey = randomUUID();
    const body = { expectedVersion: 3, managerWorkerProfileId, relationshipStatus: "assigned" };
    const { headers, operation } = signedRequest(url, body, idempotencyKey);
    for (const [expectedStatus, replayed] of [
      [201, "false"],
      [200, "true"],
    ] as const) {
      const response = await server.inject({ body, headers, method: "POST", url });
      expect(response.statusCode).toBe(expectedStatus);
      expect(response.headers["idempotent-replayed"]).toBe(replayed);
      expect(response.json()).toEqual(relationship);
    }
    expect(workforce.changeReportingRelationship).toHaveBeenCalledTimes(2);
    for (const call of workforce.changeReportingRelationship.mock.calls) {
      expect(call.slice(1)).toEqual([operation, { ...body, idempotencyKey, workerProfileId }]);
    }
  });
  it("rejects cross-field request data before the command", async () => {
    const workerProfileId = randomUUID();
    const url = `/v1/hr/workforce-profiles/${workerProfileId}/reporting-relationships`;
    const body = {
      expectedVersion: 3,
      managerWorkerProfileId: null,
      relationshipStatus: "assigned",
    };
    const { headers, requestId } = signedRequest(url, body);
    const response = await server.inject({ body, headers, method: "POST", url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "REQUEST_VALIDATION_FAILED",
      requestId,
      status: 400,
    });
    expect(workforce.changeReportingRelationship).not.toHaveBeenCalled();
  });
});
