import { type ChangeEvent, createElement, type ReactNode } from "react";
import type { ZenEligibleSurfaceSection } from "../../../../lib/zen-section-rail-core";

export function renderZenSectionRailMarkup(
  sections: readonly ZenEligibleSurfaceSection[],
  currentSectionId: string | undefined,
  select: (section: ZenEligibleSurfaceSection) => void,
): ReactNode {
  if (sections.length < 2) return null;
  const resolvedCurrentSectionId = sections.some(({ id }) => id === currentSectionId)
    ? currentSectionId
    : sections[0]?.id;
  return createElement(
    "div",
    { className: "zen-section-navigation" },
    createElement(
      "nav",
      { "aria-label": "On this surface", className: "zen-section-rail" },
      createElement(
        "ol",
        null,
        ...sections.map((section) =>
          createElement(
            "li",
            { key: section.id },
            createElement(
              "button",
              {
                "aria-label": section.label,
                "aria-current": resolvedCurrentSectionId === section.id ? "location" : undefined,
                onClick: () => select(section),
                type: "button",
              },
              createElement("span", { "aria-hidden": true }, section.label),
            ),
          ),
        ),
      ),
    ),
    createElement(
      "label",
      { className: "zen-section-compact" },
      createElement("span", null, "On this surface"),
      createElement(
        "select",
        {
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            const section = sections.find(
              (candidate) => candidate.id === event.currentTarget.value,
            );
            if (section) select(section);
          },
          value: resolvedCurrentSectionId,
        },
        ...sections.map((section) =>
          createElement("option", { key: section.id, value: section.id }, section.label),
        ),
      ),
    ),
  );
}
