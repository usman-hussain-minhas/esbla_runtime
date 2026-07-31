import { describe, expect, it } from "vitest";
import {
  decodePresentationPersonalSurfaceEditorWorkspaceResponse,
  decodePresentationSurfaceLayoutResponse,
  decodePresentationSurfaceOverlayResetResponse,
  PresentationSurfaceError,
  parsePresentationSurfaceOverlayReset,
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
                widgetDefinitionVersion: 1,
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
                widgetDefinitionVersion: 1,
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
            widgetDefinitionVersion: 1,
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

  it("decodes one capability-bound personal editor workspace", async () => {
    await expect(
      decodePresentationPersonalSurfaceEditorWorkspaceResponse(
        Promise.resolve(
          Response.json({
            editable: false,
            layout: {
              baseDefinitionHash:
                "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
              basePlacements: [],
              baseVersion: 1,
              diagnostics: [],
              effectivePlacements: [],
              overlayVersion: 0,
              source: "code_default",
              surfaceId: "surface.mission-control",
            },
            lockReason: "layout_write_capability_absent",
            resettable: true,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      editable: false,
      layout: { surfaceId: "surface.mission-control" },
      lockReason: "layout_write_capability_absent",
      resettable: true,
    });
  });

  it("strictly parses and decodes an evidenced overlay reset", async () => {
    expect(
      parsePresentationSurfaceOverlayReset({
        expectedVersion: 2,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      expectedVersion: 2,
      idempotencyKey: "93000000-0000-4000-8000-000000000001",
    });
    expect(() =>
      parsePresentationSurfaceOverlayReset({
        expectedVersion: 0,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();

    await expect(
      decodePresentationSurfaceOverlayResetResponse(
        Promise.resolve(
          Response.json({
            baseDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
            basePlacements: [],
            baseVersion: 1,
            billingState: "non_billable",
            diagnostics: [],
            effectivePlacements: [],
            evidenceEventId: "94000000-0000-4000-8000-000000000001",
            overlayVersion: 0,
            replayed: false,
            source: "code_default",
            surfaceId: "surface.mission-control",
          }),
        ),
      ),
    ).resolves.toMatchObject({ overlayVersion: 0, source: "code_default" });
  });
});
