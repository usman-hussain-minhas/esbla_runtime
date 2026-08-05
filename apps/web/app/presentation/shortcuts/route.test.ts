import { beforeEach, describe, expect, it, vi } from "vitest";

const { persistOwnPresentationShortcut } = vi.hoisted(() => ({
  persistOwnPresentationShortcut: vi.fn(),
}));

vi.mock("../../../lib/presentation-shortcuts", () => ({
  persistOwnPresentationShortcut,
}));

import { POST } from "./route";

const idempotencyKey = "93000000-0000-4000-8000-000000000001";
const validBody = {
  contextId: "global",
  contextKind: "global",
  expectedVersion: 0,
  idempotencyKey,
  operation: "append",
  settingKey: "navigation.universal_shortcuts.v1",
  targetId: "surface.hr.requests-and-claims",
};

function request(body: unknown, origin = "http://127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/presentation/shortcuts", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin,
      "sec-fetch-site": origin === "http://127.0.0.1:3000" ? "same-origin" : "cross-site",
    },
    method: "POST",
  });
}

describe("presentation shortcut web transport", () => {
  beforeEach(() => persistOwnPresentationShortcut.mockReset());

  it("rejects cross-origin and extra authority fields before calling the API", async () => {
    expect((await POST(request(validBody, "https://attacker.example"))).status).toBe(403);
    expect((await POST(request({ ...validBody, tenantId: "attacker" }))).status).toBe(400);
    expect(persistOwnPresentationShortcut).not.toHaveBeenCalled();
  });

  it("forwards one exact same-origin own-shortcut mutation", async () => {
    persistOwnPresentationShortcut.mockResolvedValue({
      billingState: "non_billable",
      evidenceEventId: "94000000-0000-4000-8000-000000000001",
      replayed: false,
      set: {
        contextId: "global",
        contextKind: "global",
        editable: true,
        eligibleTargets: [],
        items: [],
        settingKey: "navigation.universal_shortcuts.v1",
        tombstoneCount: 0,
        version: 1,
      },
    });
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(persistOwnPresentationShortcut).toHaveBeenCalledWith(
      {
        contextId: "global",
        contextKind: "global",
        expectedVersion: 0,
        operation: "append",
        settingKey: "navigation.universal_shortcuts.v1",
        targetId: "surface.hr.requests-and-claims",
      },
      idempotencyKey,
    );
  });
});
