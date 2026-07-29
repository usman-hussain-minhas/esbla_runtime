import { describe, expect, it } from "vitest";
import { resolveZenShortcutVisibleItemCount } from "./zen-shortcut-layout-core";

describe("Zen shortcut stack geometry", () => {
  it("shows at most five items after reserving the picker and top chrome", () => {
    expect(
      resolveZenShortcutVisibleItemCount({
        availableBlockSize: 844,
        buttonBlockSize: 46,
        controlGap: 8,
        endInset: 18,
        startInset: 18,
        topChromeBlockSize: 118,
      }),
    ).toBe(5);
  });

  it("reduces visible items under measured short-height pressure", () => {
    expect(
      resolveZenShortcutVisibleItemCount({
        availableBlockSize: 300,
        buttonBlockSize: 46,
        controlGap: 8,
        endInset: 18,
        startInset: 18,
        topChromeBlockSize: 118,
      }),
    ).toBe(1);
    expect(
      resolveZenShortcutVisibleItemCount({
        availableBlockSize: 220,
        buttonBlockSize: 46,
        controlGap: 8,
        endInset: 18,
        startInset: 18,
        topChromeBlockSize: 118,
      }),
    ).toBe(0);
  });

  it("fails closed on non-finite or non-positive geometry", () => {
    for (const candidate of [
      {
        availableBlockSize: Number.NaN,
        buttonBlockSize: 46,
        controlGap: 8,
        endInset: 18,
        startInset: 18,
        topChromeBlockSize: 118,
      },
      {
        availableBlockSize: 844,
        buttonBlockSize: 0,
        controlGap: 8,
        endInset: 18,
        startInset: 18,
        topChromeBlockSize: 118,
      },
      {
        availableBlockSize: 844,
        buttonBlockSize: 46,
        controlGap: -1,
        endInset: 18,
        startInset: 18,
        topChromeBlockSize: 118,
      },
    ]) {
      expect(resolveZenShortcutVisibleItemCount(candidate)).toBe(0);
    }
  });
});
