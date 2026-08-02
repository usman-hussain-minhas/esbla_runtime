import { getZenV1RegisteredSurfacePlacements, getZenV1SurfaceContract } from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  beginSurfaceEditorInteraction,
  cancelSurfaceEditorInteraction,
  commitSurfaceEditorInteraction,
  createPersonalSurfaceEditorState,
  isPersonalSurfaceWidgetRemovable,
  personalSurfaceEditorReducer,
  stepSurfaceEditorInteraction,
  surfaceEditorKeyboardAction,
  updateSurfaceEditorInteraction,
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

  it("adds and removes a catalogue-only widget through the same bounded editor path", () => {
    const registered = getZenV1RegisteredSurfacePlacements("surface.mission-control");
    const initial = createPersonalSurfaceEditorState({
      availablePlacements: registered,
      effectivePlacements: available,
      overlayVersion: 0,
      surfaceId: "surface.mission-control",
    });
    const added = personalSurfaceEditorReducer(initial, {
      instanceId: "mission-control.my-tasks",
      type: "add",
    });
    expect(
      added.placements.find(({ instanceId }) => instanceId === "mission-control.my-tasks"),
    ).toMatchObject({
      widgetDefinitionId: "workspace.tasks.mine",
      widgetDefinitionVersion: 1,
    });
    expect(
      isPersonalSurfaceWidgetRemovable("surface.mission-control", "mission-control.my-tasks"),
    ).toBe(true);
    const selected = personalSurfaceEditorReducer(added, {
      instanceId: "mission-control.my-tasks",
      type: "select",
    });
    expect(personalSurfaceEditorReducer(selected, { type: "remove_selected" }).placements).toEqual(
      available,
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
      instanceId: "mission-control.my-expenses",
      key: "ArrowDown",
      shiftKey: true,
    });
    expect(
      resized.placements.find(({ instanceId }) => instanceId === "mission-control.my-expenses"),
    ).toMatchObject({ rowSpan: 4 });
    expect(
      resized.placements.find(({ instanceId }) => instanceId === "mission-control.my-profile"),
    ).toMatchObject({ rowSpan: 3 });
    expect(resized.announcement).toBe("My Expense Claims resized to 4 columns by 4 rows.");

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

  it("previews one snapped pointer interaction without mutating the draft, then commits once", () => {
    const initial = createPersonalSurfaceEditorState({
      availablePlacements: available,
      effectivePlacements: available,
      overlayVersion: 4,
      surfaceId: "surface.mission-control",
    });
    const started = beginSurfaceEditorInteraction(initial, {
      columnStep: 80,
      instanceId: "mission-control.my-profile",
      mode: "move",
      pointerId: 7,
      rowStep: 56,
      startClientX: 100,
      startClientY: 100,
    });
    expect(started).toBeDefined();
    if (!started) throw new Error("Expected a surface interaction session");

    const preview = updateSurfaceEditorInteraction(initial, started, {
      clientX: 100,
      clientY: 156,
    });
    expect(preview.proposal).toMatchObject({
      column: 5,
      columnSpan: 4,
      row: 8,
      rowSpan: 3,
    });
    expect(preview.valid).toBe(true);
    expect(preview.changed).toBe(true);
    expect(initial.dirty).toBe(false);
    expect(initial.placements).toEqual(available);

    const committed = commitSurfaceEditorInteraction(initial, preview);
    expect(
      committed.placements.find(({ instanceId }) => instanceId === "mission-control.my-profile"),
    ).toMatchObject({ row: 8 });
    expect(committed.dirty).toBe(true);
    expect(committed.announcement).toBe("Dropped My Profile at column 5, row 8.");
  });

  it("steps a keyboard-picked handle before one explicit drop", () => {
    const initial = createPersonalSurfaceEditorState({
      availablePlacements: available,
      effectivePlacements: available,
      overlayVersion: 4,
      surfaceId: "surface.mission-control",
    });
    const started = beginSurfaceEditorInteraction(initial, {
      columnStep: 1,
      instanceId: "mission-control.my-profile",
      mode: "move",
      pointerId: -1,
      rowStep: 1,
      startClientX: 0,
      startClientY: 0,
    });
    expect(started).toBeDefined();
    if (!started) throw new Error("Expected a keyboard interaction session");

    const stepped = stepSurfaceEditorInteraction(initial, started, {
      horizontalDelta: 0,
      verticalDelta: 1,
    });
    expect(stepped.proposal).toMatchObject({ column: 5, row: 8 });
    expect(stepped.announcement).toBe("My Profile move target column 5, row 8 is available.");
    expect(initial.placements).toEqual(available);

    const dropped = commitSurfaceEditorInteraction(initial, stepped);
    expect(
      dropped.placements.find(({ instanceId }) => instanceId === "mission-control.my-profile"),
    ).toMatchObject({ row: 8 });
  });

  it("exposes an invalid snapped footprint and cancellation without moving the draft", () => {
    const initial = createPersonalSurfaceEditorState({
      availablePlacements: available,
      effectivePlacements: available,
      overlayVersion: 2,
      surfaceId: "surface.mission-control",
    });
    const started = beginSurfaceEditorInteraction(initial, {
      columnStep: 80,
      instanceId: "mission-control.my-work",
      mode: "move",
      pointerId: 9,
      rowStep: 56,
      startClientX: 0,
      startClientY: 0,
    });
    expect(started).toBeDefined();
    if (!started) throw new Error("Expected a surface interaction session");

    const collision = updateSurfaceEditorInteraction(initial, started, {
      clientX: 0,
      clientY: 168,
    });
    expect(collision.proposal).toMatchObject({ row: 4 });
    expect(collision.valid).toBe(false);
    expect(collision.issue).toBe("That position is occupied.");
    expect(commitSurfaceEditorInteraction(initial, collision).placements).toEqual(
      initial.placements,
    );

    const cancelled = cancelSurfaceEditorInteraction(initial, collision);
    expect(cancelled.placements).toEqual(initial.placements);
    expect(cancelled.dirty).toBe(false);
    expect(cancelled.announcement).toBe("Cancelled moving My Work. It remains at column 1, row 1.");
  });

  it("undoes the latest personal removal at its exact draft geometry before save", () => {
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
    const moved = personalSurfaceEditorReducer(selected, {
      columnDelta: 0,
      instanceId: "mission-control.my-leave",
      rowDelta: 7,
      type: "move",
    });
    const removed = personalSurfaceEditorReducer(moved, { type: "remove_selected" });
    expect(removed.lastRemoved?.placement.instanceId).toBe("mission-control.my-leave");
    expect(removed.lastRemoved?.placement.row).toBe(11);

    const restored = personalSurfaceEditorReducer(removed, { type: "undo_remove" });
    expect(
      restored.placements.find(({ instanceId }) => instanceId === "mission-control.my-leave"),
    ).toMatchObject({ row: 11 });
    expect(restored.lastRemoved).toBeNull();
    expect(restored.announcement).toBe("Restored My Leave Requests to this draft.");
  });
});
