import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttendanceServiceReceipt, sealAttendanceServiceReceipt } from "./hr-attendance";
import type { AttendanceServiceAction, AttendanceServiceControl } from "./hr-attendance-core";

vi.mock("server-only", () => ({}));

const ids = {
  key: "71000000-0000-4000-8000-000000000001",
  principal: "71000000-0000-4000-8000-000000000002",
  tenant: "71000000-0000-4000-8000-000000000003",
} as const;
const settings = {
  correctionNoteRequired: true,
  manualObservationKinds: "presence_start",
} as const satisfies AttendanceServiceControl["settings"];
const configure = {
  body: { expectedSettingsVersion: 1, settings },
  idempotencyKey: ids.key,
  operation: "configure_service",
} as const satisfies AttendanceServiceAction;
const configured = {
  activationState: "active",
  activationVersion: 1,
  serviceKey: "attendance",
  settings,
  settingsVersion: 2,
  updatedAt: "2030-01-01T00:00:00.000Z",
  version: 2,
} as const satisfies AttendanceServiceControl;

beforeEach(() => {
  for (const [name, value] of Object.entries({
    ESBLA_API_BASE_URL: "http://127.0.0.1:3001",
    ESBLA_DEV_AUTH_SECRET: "attendance-receipt-test-secret-with-at-least-32-bytes",
    ESBLA_DEV_PRINCIPAL_ID: ids.principal,
    ESBLA_DEV_TENANT_ID: ids.tenant,
    NODE_ENV: "development",
  })) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("Attendance service-control receipt", () => {
  it("is exact-result, action, actor, tenant, tamper and expiry bound", () => {
    const sealed = sealAttendanceServiceReceipt(configure, configured, 1_000);
    expect(readAttendanceServiceReceipt(sealed, 1_000)).toEqual({
      activationState: "active",
      activationVersion: 1,
      controlVersion: 2,
      operation: "configure_service",
      settingsVersion: 2,
    });
    expect(readAttendanceServiceReceipt(`${sealed}x`, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_PRINCIPAL_ID", ids.tenant);
    expect(readAttendanceServiceReceipt(sealed, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_PRINCIPAL_ID", ids.principal);
    vi.stubEnv("ESBLA_DEV_TENANT_ID", ids.principal);
    expect(readAttendanceServiceReceipt(sealed, 1_000)).toBeNull();
    vi.stubEnv("ESBLA_DEV_TENANT_ID", ids.tenant);
    expect(readAttendanceServiceReceipt(sealed, 301_000)).toBeNull();
    expect(() =>
      sealAttendanceServiceReceipt(configure, {
        ...configured,
        activationState: "inactive",
      }),
    ).toThrow();
  });

  it("rejects a wrong service and a non-canonical first activation", () => {
    expect(() =>
      sealAttendanceServiceReceipt(configure, {
        ...configured,
        serviceKey: "shift_assignment",
      } as unknown as AttendanceServiceControl),
    ).toThrow();

    const activate = {
      body: { expectedVersion: null },
      idempotencyKey: ids.key,
      operation: "activate_service",
    } as const satisfies AttendanceServiceAction;
    expect(() =>
      sealAttendanceServiceReceipt(activate, {
        ...configured,
        settingsVersion: 2,
        version: 2,
      }),
    ).toThrow();
  });
});
