import { getZenV1SurfaceContract } from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  createPersonalSurfaceEditorState,
  isPersonalSurfaceWidgetRemovable,
  personalSurfaceEditorReducer,
  surfaceEditorKeyboardAction,
} from "./surface-editor-core";

describe("personal surface editor core", () => {
  const available = getZenV1SurfaceContract("surface.mission-control").basePlacements;

  it("uses one bounded geometry path for pointer-equivalent and keyboard movement", () => {
    const initial = createPersonalSurfaceEditorState({
      availablePlacements: available,
      effectivePlacements: available,
      overlayVersion: 0,
      surfaceId: "surface.mission-control",
    });
    const selected = personalSurfaceEditorReducer(initial, {
      instanceId: "mission-control.my-profile",
      type: "select",
    });
    const pointerEquivalent = personalSurfaceEditorReducer(selected, {
      columnDelta: 0,
      instanceId: "mission-control.my-profile",
      rowDelta: 1,
      type: "move",
    });
    const keyboard = surfaceEditorKeyboardAction(selected, {
      key: "ArrowDown",
      shiftKey: false,
    });

    expect(keyboard).toEqual(pointerEquivalent);
    expect(
      keyboard.placements.find(({ instanceId }) => instanceId === "mission-control.my-profile"),
    ).toMatchObject({ row: 8 });
    expect(keyboard.announcement).toBe("My Profile moved to column 5, row 8.");
    expect(keyboard.dirty).toBe(true);
  });

  it("removes and restores an optional registered widget without inventing an instance binding", () => {
    const initial = createPersonalSurfaceEditorState({
      availablePlacements: available,
      effectivePlacements: available,
      overlayVersion: 0,
      surfaceId: "surface.mission-control",
    });
    const selected = personalSurfaceEditorReducer(initial, {
      instanceId: "mission-control.my-leave",
      type: "select",
    });
    expect(
      isPersonalSurfaceWidgetRemovable("surface.mission-control", "mission-control.my-leave"),
    ).toBe(true);
    const removed = personalSurfaceEditorReducer(selected, { type: "remove_selected" });
    expect(removed.placements.map(({ instanceId }) => instanceId)).not.toContain(
      "mission-control.my-leave",
    );
    const restored = personalSurfaceEditorReducer(removed, {
      instanceId: "mission-control.my-leave",
      type: "add",
    });
    expect(restored.placements).toContainEqual(
      expect.objectContaining({
        instanceId: "mission-control.my-leave",
        widgetDefinitionId: "hr.leave.my-requests",
      }),
    );
    expect(new Set(restored.placements.map(({ instanceId }) => instanceId)).size).toBe(
      restored.placements.length,
    );
  });

  it("resizes within the registry bounds and rejects collision without partial movement", () => {
    const initial = createPersonalSurfaceEditorState({
      availablePlacements: available,
      effectivePlacements: available,
      overlayVersion: 3,
      surfaceId: "surface.mission-control",
    });
    const staleSelection = personalSurfaceEditorReducer(initial, {
      instanceId: "mission-control.my-profile",
      type: "select",
    });
    const resized = surfaceEditorKeyboardAction(staleSelection, {
      instanceId: "mission-control.my-timesheets",
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(
      resized.placements.find(({ instanceId }) => instanceId === "mission-control.my-timesheets"),
    ).toMatchObject({ rowSpan: 4 });
    expect(
      resized.placements.find(({ instanceId }) => instanceId === "mission-control.my-profile"),
    ).toMatchObject({ rowSpan: 3 });
    expect(resized.announcement).toBe("My Timesheets resized to 4 columns by 4 rows.");

    const collisionSelected = personalSurfaceEditorReducer(initial, {
      instanceId: "mission-control.my-work",
      type: "select",
    });
    const collision = personalSurfaceEditorReducer(collisionSelected, {
      columnDelta: 0,
      instanceId: "mission-control.my-work",
      rowDelta: 3,
      type: "move",
    });
    expect(collision.placements).toEqual(collisionSelected.placements);
    expect(collision.issue).toBe("That position is occupied.");
    expect(collision.overlayVersion).toBe(3);
  });
});
