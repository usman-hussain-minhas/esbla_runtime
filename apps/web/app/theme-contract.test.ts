import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ESBLA_THEME_ID, ESBLA_THEME_MODES } from "./theme-contract";

describe("Esbla Theme v1 host contract", () => {
  it("names the normalized theme and all three required modes", () => {
    expect(ESBLA_THEME_ID).toBe("esbla_v1");
    expect(ESBLA_THEME_MODES).toEqual(["light", "dark", "high-contrast"]);
  });

  it("keeps one scroll surface, safe-area tokens, responsive geometry, and reduced motion", async () => {
    const css = await readFile(new URL("./globals.css", import.meta.url), "utf8");
    expect(css).toContain("--surface-frame-top: 72px");
    expect(css).toContain("--corner-button: 46px");
    expect(css).toContain(".surface-scroll");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("renders an honest My Work host without an HR business surface", async () => {
    const page = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).toContain("My Work");
    expect(page).toContain("Nothing needs your attention");
    expect(page).not.toContain("Leave request");
    expect(page).not.toContain("Approve leave");
  });
});
