import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readShiftMutationReceipt, sealShiftMutationReceipt } from "./hr-shift-assignment";

vi.mock("server-only", () => ({}));
const ids = {
  key: "70000000-0000-4000-8000-000000000001",
  principal: "70000000-0000-4000-8000-000000000002",
  roster: "70000000-0000-4000-8000-000000000003",
  tenant: "70000000-0000-4000-8000-000000000004",
};
beforeEach(() => {
  for (const [name, value] of Object.entries({
    ESBLA_API_BASE_URL: "http://127.0.0.1:3001",
    ESBLA_DEV_AUTH_SECRET: "shift-receipt-test-secret-with-at-least-32-bytes",
    ESBLA_DEV_PRINCIPAL_ID: ids.principal,
    ESBLA_DEV_TENANT_ID: ids.tenant,
    NODE_ENV: "development",
  }))
    vi.stubEnv(name, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("Shift mutation receipt", () => {
  it("is exact-result, actor, tenant, tamper and expiry bound", () => {
    const sealed = sealShiftMutationReceipt(
      { body: {}, idempotencyKey: ids.key, operation: "create_roster" },
      {
        periodEnd: "2030-01-07",
        periodStart: "2030-01-01",
        periodVersion: 1,
        publishedAt: null,
        rosterVersionId: ids.roster,
        status: "draft",
        supersedesRosterVersionId: null,
        version: 1,
      },
      1_000,
    );
    expect(readShiftMutationReceipt(sealed, 1_000)).toMatchObject({
      operation: "create_roster",
      recordId: ids.roster,
      status: "draft",
    });
    expect(readShiftMutationReceipt(`${sealed}x`, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_PRINCIPAL_ID", ids.tenant);
    expect(readShiftMutationReceipt(sealed, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_PRINCIPAL_ID", ids.principal);
    expect(readShiftMutationReceipt(sealed, 301_000)).toBeNull();
  });
});
