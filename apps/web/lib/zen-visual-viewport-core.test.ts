import { describe, expect, it } from "vitest";
import { resolveZenVisualViewport } from "./zen-visual-viewport-core";

const layout = {
  layoutBlockSize: 900,
  layoutInlineSize: 1_200,
} as const;

describe("Zen visual viewport resolver", () => {
  it("derives a bounded software-keyboard obstruction", () => {
    expect(
      resolveZenVisualViewport({
        ...layout,
        viewportBlockSize: 540,
        viewportBlockStart: 0,
        viewportInlineSize: 1_200,
        viewportInlineStart: 0,
      }),
    ).toEqual({
      blockEnd: 360,
      blockSize: 540,
      blockStart: 0,
      inlineEnd: 0,
      inlineSize: 1_200,
      inlineStart: 0,
    });
  });

  it("preserves exact visual offsets for zoomed or panned viewports", () => {
    expect(
      resolveZenVisualViewport({
        ...layout,
        viewportBlockSize: 600,
        viewportBlockStart: 75,
        viewportInlineSize: 700,
        viewportInlineStart: 125,
      }),
    ).toEqual({
      blockEnd: 225,
      blockSize: 600,
      blockStart: 75,
      inlineEnd: 375,
      inlineSize: 700,
      inlineStart: 125,
    });
  });

  it("clamps imprecise browser geometry inside the layout viewport", () => {
    expect(
      resolveZenVisualViewport({
        ...layout,
        viewportBlockSize: 920,
        viewportBlockStart: -10,
        viewportInlineSize: 1_300,
        viewportInlineStart: -5,
      }),
    ).toEqual({
      blockEnd: 0,
      blockSize: 900,
      blockStart: 0,
      inlineEnd: 0,
      inlineSize: 1_200,
      inlineStart: 0,
    });
  });

  it("retains the visual size when a reported start extends past the layout edge", () => {
    expect(
      resolveZenVisualViewport({
        ...layout,
        viewportBlockSize: 600,
        viewportBlockStart: 800,
        viewportInlineSize: 700,
        viewportInlineStart: 900,
      }),
    ).toEqual({
      blockEnd: 0,
      blockSize: 600,
      blockStart: 300,
      inlineEnd: 0,
      inlineSize: 700,
      inlineStart: 500,
    });
  });

  it("falls back to the layout viewport when optional geometry is invalid", () => {
    expect(
      resolveZenVisualViewport({
        ...layout,
        viewportBlockSize: Number.NaN,
        viewportBlockStart: 0,
        viewportInlineSize: 0,
        viewportInlineStart: 0,
      }),
    ).toEqual({
      blockEnd: 0,
      blockSize: 900,
      blockStart: 0,
      inlineEnd: 0,
      inlineSize: 1_200,
      inlineStart: 0,
    });
  });

  it("rejects an invalid layout basis", () => {
    expect(() =>
      resolveZenVisualViewport({
        layoutBlockSize: 0,
        layoutInlineSize: 1_200,
        viewportBlockSize: 600,
        viewportBlockStart: 0,
        viewportInlineSize: 800,
        viewportInlineStart: 0,
      }),
    ).toThrowError("Zen visual viewport requires a positive finite layout");
  });
});
