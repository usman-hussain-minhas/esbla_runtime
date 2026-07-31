import { beforeEach, describe, expect, it, vi } from "vitest";

const { persistOwnPresentationSurfaceOverlay } = vi.hoisted(() => ({
  persistOwnPresentationSurfaceOverlay: vi.fn(),
}));

vi.mock("../../../../lib/presentation-surfaces", () => ({
  persistOwnPresentationSurfaceOverlay,
}));

import { POST } from "./route";

const idempotencyKey = "93000000-0000-4000-8000-000000000001";
const validBody = {
  expectedVersion: 0,
  idempotencyKey,
  placements: [
    {
      column: 1,
      columnSpan: 4,
      instanceId: "mission-control.my-leave",
      row: 4,
      rowSpan: 3,
      widgetDefinitionId: "hr.leave.my-requests",
      widgetDefinitionVersion: 1,
    },
  ],
};

function request(surfaceId: string, body: unknown, origin = "http://127.0.0.1:3000") {
  return new Request(`http://127.0.0.1:3000/presentation/surfaces/${surfaceId}`, {
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

describe("presentation surface overlay web transport", () => {
  beforeEach(() => persistOwnPresentationSurfaceOverlay.mockReset());

  it("fails closed for an unknown surface before calling the API", async () => {
    const response = await POST(request("surface.private", validBody), {
      params: Promise.resolve({ surfaceId: "surface.private" }),
    });
    expect(response.status).toBe(400);
    expect(persistOwnPresentationSurfaceOverlay).not.toHaveBeenCalled();
  });
});
