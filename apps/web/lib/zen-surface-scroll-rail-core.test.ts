import { describe, expect, it } from "vitest";
import {
  groupZenSurfaceScrollRows,
  resolveActiveZenSurfaceScrollAnchor,
  resolveZenSurfaceScrollInputValue,
  shouldShowZenSurfaceScrollRail,
} from "./zen-surface-scroll-rail-core";

describe("Zen surface scroll rail core", () => {
  it("stays absent without overflow or at least two rendered anchors", () => {
    expect(shouldShowZenSurfaceScrollRail(720, 720, 3)).toBe(false);
    expect(shouldShowZenSurfaceScrollRail(720, 1_440, 1)).toBe(false);
    expect(shouldShowZenSurfaceScrollRail(720, 1_440, 3)).toBe(true);
  });

  it("selects the visible rendered anchor nearest the viewport centre", () => {
    expect(
      resolveActiveZenSurfaceScrollAnchor({ bottom: 700, top: 100 }, [
        { bottom: 280, top: 120 },
        { bottom: 510, top: 300 },
        { bottom: 760, top: 530 },
      ]),
    ).toBe(1);
  });

  it("uses stable source order when two same-row anchors have the same centre", () => {
    expect(
      resolveActiveZenSurfaceScrollAnchor({ bottom: 700, top: 100 }, [
        { bottom: 510, top: 300 },
        { bottom: 510, top: 300 },
      ]),
    ).toBe(0);
  });

  it("groups rendered widgets into stable spatial rows", () => {
    expect(
      groupZenSurfaceScrollRows([
        { bottom: 290, id: "second", label: "Second", left: 520, sourceIndex: 0, top: 100 },
        { bottom: 280, id: "first", label: "First", left: 20, sourceIndex: 1, top: 101 },
        { bottom: 520, id: "third", label: "Third", left: 20, sourceIndex: 2, top: 320 },
      ]),
    ).toEqual([
      {
        bottom: 290,
        id: "row-1:first+second",
        label: "Row 1: First, Second",
        memberIds: ["first", "second"],
        top: 100,
      },
      {
        bottom: 520,
        id: "row-2:third",
        label: "Row 2: Third",
        memberIds: ["third"],
        top: 320,
      },
    ]);
  });

  it("selects the nearest real anchor instead of resetting in a sparse layout gap", () => {
    expect(
      resolveActiveZenSurfaceScrollAnchor({ bottom: 200, top: 100 }, [
        { bottom: 50, top: 10 },
        { bottom: 260, top: 220 },
      ]),
    ).toBe(1);
  });

  it("rejects invalid geometry and metrics", () => {
    expect(() => resolveActiveZenSurfaceScrollAnchor({ bottom: 0, top: 0 }, [])).toThrow(
      "Invalid Zen surface scroll geometry",
    );
    expect(() => shouldShowZenSurfaceScrollRail(720, 1_440, -1)).toThrow(
      "Invalid Zen surface scroll metrics",
    );
    expect(() =>
      groupZenSurfaceScrollRows([
        { bottom: 0, id: "broken", label: "Broken", left: 0, sourceIndex: 0, top: 0 },
      ]),
    ).toThrow("Invalid Zen surface row candidates");
  });

  it("normalizes native keyboard and assistive range input to a real anchor", () => {
    expect(resolveZenSurfaceScrollInputValue(0, 4)).toBe(0);
    expect(resolveZenSurfaceScrollInputValue(2, 4)).toBe(2);
    expect(resolveZenSurfaceScrollInputValue(2.6, 4)).toBe(3);
    expect(resolveZenSurfaceScrollInputValue(-1, 4)).toBe(0);
    expect(resolveZenSurfaceScrollInputValue(9, 4)).toBe(3);
  });

  it("rejects non-finite native input and an empty anchor set", () => {
    expect(() => resolveZenSurfaceScrollInputValue(Number.NaN, 4)).toThrow(
      "Invalid Zen surface scroll input",
    );
    expect(() => resolveZenSurfaceScrollInputValue(0, 0)).toThrow(
      "Invalid Zen surface scroll input",
    );
  });
});
