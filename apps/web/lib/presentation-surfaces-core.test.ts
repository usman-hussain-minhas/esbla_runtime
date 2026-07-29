import { describe, expect, it } from "vitest";
import {
  decodePresentationSurfaceLayoutResponse,
  PresentationSurfaceError,
  parsePresentationSurfaceOverlayUpdate,
} from "./presentation-surfaces-core";

describe("presentation surface web boundary", () => {
  it("accepts an exact bound surface response and rejects non-200 bodies", async () => {
    await expect(
      decodePresentationSurfaceLayoutResponse(
        Promise.resolve(
          Response.json({
            baseDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
            basePlacements: [
              {
                column: 1,
                columnSpan: 4,
                instanceId: "mission-control.my-leave",
                row: 4,
                rowSpan: 3,
                widgetDefinitionId: "hr.leave.my-requests",
              },
            ],
            baseVersion: 1,
            diagnostics: [],
            effectivePlacements: [
              {
                column: 1,
                columnSpan: 4,
                instanceId: "mission-control.my-leave",
                row: 4,
                rowSpan: 3,
                widgetDefinitionId: "hr.leave.my-requests",
              },
            ],
            overlayVersion: 0,
            source: "code_default",
            surfaceId: "surface.mission-control",
          }),
        ),
      ),
    ).resolves.toMatchObject({ surfaceId: "surface.mission-control" });
    await expect(
      decodePresentationSurfaceLayoutResponse(Promise.resolve(new Response("{}", { status: 201 }))),
    ).rejects.toBeInstanceOf(PresentationSurfaceError);
  });

  it("requires an exact overlay body and UUID idempotency key", () => {
    expect(
      parsePresentationSurfaceOverlayUpdate({
        expectedVersion: 0,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
        placements: [
          {
            column: 1,
            columnSpan: 4,
            instanceId: "mission-control.my-leave",
            row: 4,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
          },
        ],
      }),
    ).toMatchObject({ expectedVersion: 0 });
    expect(() =>
      parsePresentationSurfaceOverlayUpdate({
        expectedVersion: 0,
        idempotencyKey: "not-a-uuid",
        placements: [],
      }),
    ).toThrow();
  });
});
