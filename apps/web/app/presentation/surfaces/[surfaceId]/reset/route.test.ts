import { beforeEach, describe, expect, it, vi } from "vitest";

const { resetOwnPresentationSurfaceOverlay } = vi.hoisted(() => ({
  resetOwnPresentationSurfaceOverlay: vi.fn(),
}));

vi.mock("../../../../../lib/presentation-surfaces", () => ({
  resetOwnPresentationSurfaceOverlay,
}));

import { POST } from "./route";

function request(surfaceId: string, body: unknown, origin = "http://127.0.0.1:3000") {
  return new Request(`http://127.0.0.1:3000/presentation/surfaces/${surfaceId}/reset`, {
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

describe("presentation surface reset web transport", () => {
  beforeEach(() => resetOwnPresentationSurfaceOverlay.mockReset());

  it("fails closed for cross-origin, unknown surface, and invalid reset input", async () => {
    for (const [surfaceId, body, origin, status] of [
      [
        "surface.mission-control",
        {
          expectedVersion: 1,
          idempotencyKey: "93000000-0000-4000-8000-000000000001",
        },
        "https://attacker.invalid",
        403,
      ],
      [
        "surface.private",
        {
          expectedVersion: 1,
          idempotencyKey: "93000000-0000-4000-8000-000000000001",
        },
        "http://127.0.0.1:3000",
        400,
      ],
      [
        "surface.mission-control",
        {
          expectedVersion: 0,
          idempotencyKey: "93000000-0000-4000-8000-000000000001",
        },
        "http://127.0.0.1:3000",
        400,
      ],
    ] as const) {
      const response = await POST(request(surfaceId, body, origin), {
        params: Promise.resolve({ surfaceId }),
      });
      expect(response.status).toBe(status);
    }
    expect(resetOwnPresentationSurfaceOverlay).not.toHaveBeenCalled();
  });
});
