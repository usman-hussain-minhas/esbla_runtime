import { beforeEach, describe, expect, it, vi } from "vitest";

const { persistTenantPresentationSurfaceDraft } = vi.hoisted(() => ({
  persistTenantPresentationSurfaceDraft: vi.fn(),
}));

vi.mock("../../../../../../lib/presentation-surface-bases", () => ({
  persistTenantPresentationSurfaceDraft,
}));

import { POST } from "./route";

const validBody = {
  expectedDraftVersion: 0,
  expectedHeadRowVersion: 0,
  idempotencyKey: "93000000-0000-4000-8000-000000000001",
  placements: [
    {
      column: 1,
      columnSpan: 4,
      instanceId: "mission-control.my-work",
      row: 1,
      rowSpan: 3,
      widgetDefinitionId: "workspace.my-work",
      widgetDefinitionVersion: 1,
    },
  ],
};

function request(surfaceId: string, body: unknown, origin = "http://127.0.0.1:3000") {
  return new Request(`http://127.0.0.1:3000/presentation/surfaces/${surfaceId}/tenant-base/draft`, {
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

describe("presentation surface tenant-base draft web transport", () => {
  beforeEach(() => persistTenantPresentationSurfaceDraft.mockReset());

  it("fails closed before the API for cross-origin, unknown-surface and widened input", async () => {
    for (const [surfaceId, body, origin, status] of [
      ["surface.mission-control", validBody, "https://attacker.invalid", 403],
      ["surface.private", validBody, "http://127.0.0.1:3000", 400],
      [
        "surface.mission-control",
        { ...validBody, privateField: "must not pass" },
        "http://127.0.0.1:3000",
        400,
      ],
    ] as const) {
      const response = await POST(request(surfaceId, body, origin), {
        params: Promise.resolve({ surfaceId }),
      });
      expect(response.status).toBe(status);
    }
    expect(persistTenantPresentationSurfaceDraft).not.toHaveBeenCalled();
  });
});
