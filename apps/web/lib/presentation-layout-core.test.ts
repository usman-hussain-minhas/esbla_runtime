import {
  getZenV1SurfaceContract,
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
  type PresentationSurfaceLayout,
} from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  getResponsivePresentationWidgetPlacement,
  PresentationLayoutError,
  resolvePresentationBreakpointLayout,
  resolveResponsivePresentationSurfaceLayout,
} from "./presentation-layout-core";

const positioned = [
  {
    column: 1,
    columnSpan: 4,
    instanceId: "surface.first",
    row: 1,
    rowSpan: 3,
    widgetDefinitionId: "hr.leave.my-requests",
    widgetDefinitionVersion: 1,
  },
  {
    column: 3,
    columnSpan: 4,
    instanceId: "surface.second",
    row: 1,
    rowSpan: 3,
    widgetDefinitionId: "hr.leave.my-requests",
    widgetDefinitionVersion: 1,
  },
] as const;

const unpositioned = {
  instanceId: "surface.third",
  widgetDefinitionId: "hr.leave.my-requests",
  widgetDefinitionVersion: 1,
} as const;

describe("presentation layout resolver", () => {
  it("normalizes collisions and unpositioned widgets deterministically on the 12-column grid", () => {
    const first = resolvePresentationBreakpointLayout([...positioned, unpositioned], "desktop", [
      HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
    ]);
    const replay = resolvePresentationBreakpointLayout([...positioned, unpositioned], "desktop", [
      HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
    ]);

    expect(first).toEqual(replay);
    expect(first.columnCount).toBe(12);
    expect(first.placements).toEqual([
      expect.objectContaining({ column: 1, instanceId: "surface.first", row: 1 }),
      expect.objectContaining({ column: 5, instanceId: "surface.second", row: 1 }),
      expect.objectContaining({ column: 9, instanceId: "surface.third", row: 1 }),
    ]);
    expect(first.diagnostics).toEqual([
      expect.objectContaining({
        code: "collision_repositioned",
        instanceId: "surface.second",
      }),
      expect.objectContaining({
        code: "unpositioned_placed",
        instanceId: "surface.third",
      }),
    ]);
  });

  it("derives stable 8-column packing and a full-width 4-column phone stack", () => {
    const items = [...positioned, unpositioned];
    expect(
      resolvePresentationBreakpointLayout(items, "tablet", [HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION])
        .placements,
    ).toEqual([
      expect.objectContaining({
        column: 1,
        columnSpan: 4,
        instanceId: "surface.first",
        row: 1,
      }),
      expect.objectContaining({
        column: 5,
        columnSpan: 4,
        instanceId: "surface.second",
        row: 1,
      }),
      expect.objectContaining({
        column: 1,
        columnSpan: 4,
        instanceId: "surface.third",
        row: 4,
      }),
    ]);
    expect(
      resolvePresentationBreakpointLayout(items, "phone", [HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION])
        .placements,
    ).toEqual([
      expect.objectContaining({
        column: 1,
        columnSpan: 4,
        instanceId: "surface.first",
        row: 1,
      }),
      expect.objectContaining({
        column: 1,
        columnSpan: 4,
        instanceId: "surface.second",
        row: 4,
      }),
      expect.objectContaining({
        column: 1,
        columnSpan: 4,
        instanceId: "surface.third",
        row: 7,
      }),
    ]);
  });

  it("clamps valid geometry with diagnostics and rejects invalid or duplicate identities", () => {
    const clamped = resolvePresentationBreakpointLayout(
      [
        {
          column: 99,
          columnSpan: 99,
          instanceId: "surface.clamped",
          row: 1,
          rowSpan: 1,
          widgetDefinitionId: "hr.leave.my-requests",
          widgetDefinitionVersion: 1,
        },
      ],
      "desktop",
      [HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION],
    );
    expect(clamped.placements[0]).toMatchObject({
      column: 1,
      columnSpan: 12,
      rowSpan: 3,
    });
    expect(clamped.diagnostics.map(({ code }) => code)).toEqual([
      "column_span_clamped",
      "row_span_clamped",
      "column_position_clamped",
    ]);

    expect(() =>
      resolvePresentationBreakpointLayout(
        [
          {
            column: 1,
            columnSpan: 0,
            instanceId: "surface.invalid",
            row: 1,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
            widgetDefinitionVersion: 1,
          },
        ],
        "desktop",
        [HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION],
      ),
    ).toThrowError(PresentationLayoutError);
    expect(() =>
      resolvePresentationBreakpointLayout([positioned[0], { ...positioned[0] }], "desktop", [
        HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
      ]),
    ).toThrowError("Duplicate presentation widget instance");
  });

  it("returns explicit diagnostics rather than silently rendering an unsupported breakpoint", () => {
    const desktopOnly = {
      ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
      supportedBreakpointVariants: ["desktop"],
    } as const;
    expect(resolvePresentationBreakpointLayout([positioned[0]], "tablet", [desktopOnly])).toEqual({
      breakpoint: "tablet",
      columnCount: 8,
      diagnostics: [
        {
          code: "unsupported_breakpoint",
          instanceId: "surface.first",
        },
      ],
      placements: [],
    });
  });

  it("binds all three rendered layouts to the persisted surface identity and versions", () => {
    const contract = getZenV1SurfaceContract("surface.mission-control");
    const basePlacement = contract.basePlacements.find(
      ({ instanceId }) => instanceId === "mission-control.my-leave",
    );
    if (!basePlacement) throw new Error("Mission Control base placement is missing");
    const persisted = {
      baseDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
      basePlacements: [basePlacement],
      baseVersion: 1,
      diagnostics: [],
      effectivePlacements: [basePlacement],
      overlayVersion: 0,
      source: "code_default",
      surfaceId: "surface.mission-control",
    } as const satisfies PresentationSurfaceLayout;
    const resolved = resolveResponsivePresentationSurfaceLayout(persisted, [
      HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
    ]);
    expect(resolved).toMatchObject({
      baseVersion: 1,
      overlayVersion: 0,
      source: "code_default",
      surfaceDiagnostics: [],
      surfaceId: "surface.mission-control",
    });
    expect(
      resolved.layouts.map(({ breakpoint, columnCount }) => [breakpoint, columnCount]),
    ).toEqual([
      ["desktop", 12],
      ["tablet", 8],
      ["phone", 4],
    ]);
    expect(
      getResponsivePresentationWidgetPlacement(resolved, "mission-control.my-leave"),
    ).toMatchObject({
      desktop: { instanceId: "mission-control.my-leave" },
      phone: { column: 1, instanceId: "mission-control.my-leave", row: 7 },
      tablet: { column: 1, instanceId: "mission-control.my-leave", row: 4 },
    });
    expect(resolved.layouts[1].placements).toEqual(
      contract.basePlacementsByBreakpoint.tablet.filter(
        ({ instanceId }) => instanceId === "mission-control.my-leave",
      ),
    );
    expect(resolved.layouts[2].placements).toEqual(
      contract.basePlacementsByBreakpoint.phone.filter(
        ({ instanceId }) => instanceId === "mission-control.my-leave",
      ),
    );
  });

  it("compacts a personalized subset for tablet and phone preview without stale gaps", () => {
    const contract = getZenV1SurfaceContract("surface.mission-control");
    const leave = contract.basePlacements.find(
      ({ instanceId }) => instanceId === "mission-control.my-leave",
    );
    if (!leave) throw new Error("Mission Control leave placement is missing");
    const resolved = resolveResponsivePresentationSurfaceLayout(
      {
        baseDefinitionHash: contract.definitionHash,
        basePlacements: contract.basePlacements,
        baseVersion: 1,
        diagnostics: [],
        effectivePlacements: [leave],
        overlayVersion: 1,
        source: "user_overlay",
        surfaceId: contract.surfaceId,
      },
      [HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION],
    );

    expect(resolved.layouts[1].placements).toEqual([
      expect.objectContaining({ column: 1, instanceId: leave.instanceId, row: 1 }),
    ]);
    expect(resolved.layouts[2].placements).toEqual([
      expect.objectContaining({ column: 1, instanceId: leave.instanceId, row: 1 }),
    ]);
  });
});
