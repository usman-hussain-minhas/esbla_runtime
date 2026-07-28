import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderZenSectionRailMarkup } from "./zen-section-rail-markup";

const sections = [
  { headingId: "summary-heading", id: "summary", label: "Summary" },
  { headingId: "history-heading", id: "history", label: "History" },
] as const;

describe("Zen section rail", () => {
  it("renders nothing for the one-section initial surface contract", () => {
    expect(
      renderToStaticMarkup(
        createElement(
          () => renderZenSectionRailMarkup([sections[0]], sections[0].id, () => undefined),
          {},
        ),
      ),
    ).toBe("");
  });

  it("renders a readable desktop rail and compact section chooser without history links", () => {
    const html = renderToStaticMarkup(
      createElement(
        () => renderZenSectionRailMarkup(sections, sections[0].id, () => undefined),
        {},
      ),
    );
    expect(html).toContain('aria-label="On this surface"');
    expect(html).toContain(
      '<label class="zen-section-compact"><span>On this surface</span><select>',
    );
    expect(html).not.toContain('aria-label="Jump to section"');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('aria-label="Summary"');
    expect(html).toContain('aria-label="History"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Summary");
    expect(html).toContain("History");
    expect(html).not.toContain('href="#');
  });

  it("reconciles a filtered current section before rendering controls", () => {
    const html = renderToStaticMarkup(
      createElement(
        () => renderZenSectionRailMarkup(sections, "removed-section", () => undefined),
        {},
      ),
    );
    expect(html).toContain('aria-label="Summary" aria-current="location"');
    expect(html).toContain('<option value="summary" selected="">Summary</option>');
  });

  it("uses the one surface scroll owner, actual intersections, focus, and reduced motion", async () => {
    const source = await readFile(new URL("./zen-section-rail.tsx", import.meta.url), "utf8");
    const css = await readFile(new URL("../../../../app/globals.css", import.meta.url), "utf8");
    expect(source).toContain('document.querySelector<HTMLElement>(".surface-scroll")');
    expect(source).toContain("new IntersectionObserver");
    expect(source).toContain("root: scrollOwner");
    expect(source).toContain("scrollIntoView");
    expect(source).toContain("preventScroll: true");
    expect(source).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(source).not.toContain("history.");
    expect(source).not.toContain("location.hash");
    expect(css).toMatch(
      /@media \(max-width: 1099px\)[\s\S]*?\[data-zen-section-heading\][\s\S]*?scroll-margin-block-start: 64px;/,
    );
  });
});
