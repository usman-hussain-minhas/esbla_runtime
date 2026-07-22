import type { HrServiceControl } from "@esbla/contracts/hr-service-control-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, load } = vi.hoisted(() => ({ execute: vi.fn(), load: vi.fn() }));
vi.mock("../../../../../../lib/hr-workforce-profile-service-control", () => ({
  executeWorkforceProfileServiceControl: execute,
  loadWorkforceProfileServiceControl: load,
}));

import { POST } from "./route";

const control: HrServiceControl = {
  activationState: "active",
  activationVersion: 2,
  serviceKey: "workforce_profile",
  settings: {
    employeeNumberRequired: false,
    managerVisibility: "minimized",
    unlinkedWorkerCreationAllowed: true,
  },
  settingsVersion: 3,
  updatedAt: "2026-07-22T09:00:00.000Z",
  version: 4,
};
const action = {
  expectedVersion: 2,
  idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  operation: "deactivate",
} as const;

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/workspace/hr/profile/settings/action", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    method: "POST",
  });
}

describe("Workforce Profile service-control web transport", () => {
  beforeEach(() => {
    execute.mockReset();
    load.mockReset();
    load.mockResolvedValue({ control, status: "success" });
  });

  it("fails closed before loading current authority for cross-origin or invalid input", async () => {
    const crossOrigin = await POST(
      request(action, { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" }),
    );
    expect(crossOrigin.status).toBe(403);

    const media = await POST(request(action, { "content-type": "text/plain" }));
    expect(media.status).toBe(415);

    const invalidJson = await POST(request("{"));
    expect(invalidJson.status).toBe(400);

    const extra = await POST(request({ ...action, tenantId: "attacker" }));
    expect(extra.status).toBe(400);
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds execution to the freshly loaded current control", async () => {
    const deactivated: HrServiceControl = {
      ...control,
      activationState: "inactive",
      activationVersion: 3,
      updatedAt: "2026-07-22T09:01:00.000Z",
      version: 5,
    };
    execute.mockResolvedValue(deactivated);
    const response = await POST(request(action));
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(control, {
      body: { expectedVersion: 2 },
      idempotencyKey: action.idempotencyKey,
      operation: "deactivate",
    });
    expect(await response.json()).toEqual({ control: deactivated, ok: true });
  });

  it("permits only first activation from the authorized not-found state", async () => {
    load.mockResolvedValue({
      fieldErrors: {},
      kind: "not_found",
      message: "Workforce Profile is ready for its first governed activation.",
      status: "error",
    });
    const blocked = await POST(request(action));
    expect(blocked.status).toBe(404);

    const activate = { ...action, expectedVersion: null, operation: "activate" } as const;
    const activated: HrServiceControl = {
      ...control,
      activationVersion: 1,
      settingsVersion: 1,
      updatedAt: "2026-07-22T09:02:00.000Z",
      version: 1,
    };
    execute.mockResolvedValue(activated);
    const response = await POST(request(activate));
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(null, {
      body: { expectedVersion: null },
      idempotencyKey: action.idempotencyKey,
      operation: "activate",
    });
  });

  it("returns only fixed sanitized load and mutation failures", async () => {
    load.mockResolvedValue({
      fieldErrors: {},
      kind: "denied",
      message: "You do not have permission to manage Workforce Profile service controls.",
      status: "error",
    });
    const denied = await POST(request(action));
    expect(denied.status).toBe(403);

    load.mockResolvedValue({ control, status: "success" });
    execute.mockRejectedValue(new Error("postgresql://private-secret"));
    const failed = await POST(request(action));
    expect(failed.status).toBe(503);
    const body = await failed.json();
    expect(body).toMatchObject({ ok: false, state: { kind: "operational_error" } });
    expect(JSON.stringify(body)).not.toContain("private-secret");
  });
});
