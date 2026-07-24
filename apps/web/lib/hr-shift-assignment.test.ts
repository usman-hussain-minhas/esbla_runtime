import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readShiftMutationReceipt,
  readShiftServiceReceipt,
  sealShiftMutationReceipt,
  sealShiftServiceReceipt,
} from "./hr-shift-assignment";
import {
  isShiftServiceActionOnlyFallback,
  validateShiftServiceAction,
} from "./hr-shift-assignment-core";

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

  it("binds exact service-control transitions and rejects malformed settings", () => {
    const action = {
      body: {
        expectedSettingsVersion: 1,
        settings: { overlapAllowed: false as const, rosterHorizonDays: 21 },
      },
      idempotencyKey: ids.key,
      operation: "configure_service" as const,
    };
    const sealed = sealShiftServiceReceipt(
      action,
      {
        activationState: "active",
        activationVersion: 1,
        serviceKey: "shift_assignment",
        settings: action.body.settings,
        settingsVersion: 2,
        updatedAt: "2030-01-01T00:00:00.000Z",
        version: 2,
      },
      1_000,
    );
    expect(readShiftServiceReceipt(sealed, 1_000)).toEqual({
      activationState: "active",
      activationVersion: 1,
      controlVersion: 2,
      operation: "configure_service",
      settingsVersion: 2,
    });
    expect(readShiftServiceReceipt(`${sealed}x`, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_PRINCIPAL_ID", ids.tenant);
    expect(readShiftServiceReceipt(sealed, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_PRINCIPAL_ID", ids.principal);
    vi.stubEnv("ESBLA_DEV_TENANT_ID", ids.principal);
    expect(readShiftServiceReceipt(sealed, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_TENANT_ID", ids.tenant);
    expect(readShiftServiceReceipt(sealed, 301_000)).toBeNull();
    expect(() =>
      sealShiftServiceReceipt(action, {
        activationState: "active",
        activationVersion: 1,
        serviceKey: "shift_assignment",
        settings: action.body.settings,
        settingsVersion: 1,
        updatedAt: "2030-01-01T00:00:00.000Z",
        version: 1,
      }),
    ).toThrow();
    expect(
      validateShiftServiceAction({
        expectedSettingsVersion: "1",
        idempotencyKey: ids.key,
        operation: "configure_service",
        overlapAllowed: "false",
        rosterHorizonDays: "21",
      }),
    ).toMatchObject({
      ok: true,
      value: { body: { settings: { overlapAllowed: false, rosterHorizonDays: 21 } } },
    });
    expect(
      validateShiftServiceAction({
        expectedSettingsVersion: "1",
        idempotencyKey: ids.key,
        operation: "configure_service",
        overlapAllowed: "true",
        rosterHorizonDays: "21",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
  });

  it("permits only policy-denied action-only fallback and preserves genuine failures", () => {
    expect(isShiftServiceActionOnlyFallback("denied", true)).toBe(true);
    expect(isShiftServiceActionOnlyFallback("denied", false)).toBe(false);
    expect(isShiftServiceActionOnlyFallback("dependency_unavailable", true)).toBe(false);
    expect(isShiftServiceActionOnlyFallback("inactive", true)).toBe(false);
    expect(isShiftServiceActionOnlyFallback("operational_error", true)).toBe(false);
  });
});
