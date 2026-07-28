"use client";

import { useEffect, useState } from "react";
import type { ZenEligibleSurfaceSection } from "../../../../lib/zen-section-rail-core";
import { renderZenSectionRailMarkup } from "./zen-section-rail-markup";

function activateSection(section: ZenEligibleSurfaceSection): void {
  const scrollOwner = document.querySelector<HTMLElement>(".surface-scroll");
  const heading = document.getElementById(section.headingId);
  if (!scrollOwner || !heading || !scrollOwner.contains(heading)) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  heading.tabIndex = -1;
  heading.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start",
    inline: "nearest",
  });
  heading.focus({ preventScroll: true });
}

export function ZenSectionRail({
  sections,
}: Readonly<{ sections: readonly ZenEligibleSurfaceSection[] }>) {
  const [currentSectionId, setCurrentSectionId] = useState(sections[0]?.id);
  const resolvedCurrentSectionId = sections.some(({ id }) => id === currentSectionId)
    ? currentSectionId
    : sections[0]?.id;

  useEffect(() => {
    if (sections.length < 2) return;
    const scrollOwner = document.querySelector<HTMLElement>(".surface-scroll");
    if (!scrollOwner) return;
    const visible = new Set<string>();
    const headings = sections.flatMap((section) => {
      const heading = document.getElementById(section.headingId);
      return heading && scrollOwner.contains(heading) ? [{ heading, section }] : [];
    });
    if (headings.length < 2) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const section = headings.find(({ heading }) => heading === entry.target)?.section;
          if (!section) continue;
          if (entry.isIntersecting) visible.add(section.id);
          else visible.delete(section.id);
        }
        const current = headings
          .filter(({ section }) => visible.has(section.id))
          .sort(
            (left, right) =>
              Math.abs(left.heading.getBoundingClientRect().top) -
              Math.abs(right.heading.getBoundingClientRect().top),
          )[0];
        if (current) setCurrentSectionId(current.section.id);
      },
      {
        root: scrollOwner,
        rootMargin: "-8% 0px -68% 0px",
        threshold: [0, 0.25, 0.5, 1],
      },
    );
    for (const { heading } of headings) observer.observe(heading);
    return () => observer.disconnect();
  }, [sections]);

  function select(section: ZenEligibleSurfaceSection): void {
    setCurrentSectionId(section.id);
    activateSection(section);
  }

  return renderZenSectionRailMarkup(sections, resolvedCurrentSectionId, select);
}
