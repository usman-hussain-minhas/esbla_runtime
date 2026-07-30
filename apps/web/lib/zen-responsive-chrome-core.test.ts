import { describe, expect, it } from "vitest";
import { resolveZenResponsiveChrome } from "./zen-responsive-chrome-core";

const roomyGeometry = {
  availableInlineSize: 1_024,
  buttonInlineSize: 46,
  clusterGap: 18,
  controlGap: 8,
  endInset: 18,
  startInset: 18,
} as const;

describe("Zen responsive chrome resolver", () => {
  it("keeps every backed launcher direct on desktop", () => {
    expect(
      resolveZenResponsiveChrome({
        ...roomyGeometry,
        availableInlineSize: 1_100,
        hasAppearance: true,
        hasContextualMenu: true,
        hasSettings: true,
        hasServiceGroups: true,
      }),
    ).toEqual({
      breakpoint: "desktop",
      collapsed: [],
      direct: ["contextual", "service-groups", "appearance", "settings"],
      systemRequired: true,
    });
  });

  it("uses tablet priority: Theme, Settings, Current Page, then Service Groups collapse", () => {
    expect(
      resolveZenResponsiveChrome({
        ...roomyGeometry,
        availableInlineSize: 1_099,
        buttonInlineSize: 260,
        controlGap: 20,
        hasAppearance: true,
        hasContextualMenu: true,
        hasSettings: true,
        hasServiceGroups: true,
      }),
    ).toEqual({
      breakpoint: "tablet",
      collapsed: ["appearance", "settings", "contextual"],
      direct: ["service-groups"],
      systemRequired: true,
    });
  });

  it("always contains Theme and Settings in System on phone before navigation collapse", () => {
    expect(
      resolveZenResponsiveChrome({
        ...roomyGeometry,
        availableInlineSize: 390,
        buttonInlineSize: 88,
        clusterGap: 28,
        controlGap: 14,
        endInset: 20,
        hasAppearance: true,
        hasContextualMenu: true,
        hasSettings: true,
        hasServiceGroups: true,
        startInset: 20,
      }),
    ).toEqual({
      breakpoint: "phone",
      collapsed: ["appearance", "settings", "service-groups"],
      direct: ["contextual"],
      systemRequired: true,
    });
  });

  it("keeps Home alone when no backed panel or eligible navigation exists", () => {
    expect(
      resolveZenResponsiveChrome({
        ...roomyGeometry,
        availableInlineSize: 767,
        hasAppearance: false,
        hasContextualMenu: false,
        hasSettings: false,
        hasServiceGroups: false,
      }),
    ).toEqual({
      breakpoint: "phone",
      collapsed: [],
      direct: [],
      systemRequired: false,
    });
  });

  it("creates System only when geometry must contain otherwise eligible navigation", () => {
    expect(
      resolveZenResponsiveChrome({
        ...roomyGeometry,
        availableInlineSize: 250,
        buttonInlineSize: 88,
        hasAppearance: false,
        hasContextualMenu: true,
        hasSettings: false,
        hasServiceGroups: true,
      }),
    ).toEqual({
      breakpoint: "phone",
      collapsed: ["service-groups", "contextual"],
      direct: [],
      systemRequired: true,
    });
  });

  it("uses exact 1100 and 768 Product boundaries", () => {
    const input = {
      ...roomyGeometry,
      hasAppearance: true,
      hasContextualMenu: true,
      hasSettings: true,
      hasServiceGroups: true,
    };
    expect(resolveZenResponsiveChrome({ ...input, availableInlineSize: 1_100 }).breakpoint).toBe(
      "desktop",
    );
    expect(resolveZenResponsiveChrome({ ...input, availableInlineSize: 1_099 }).breakpoint).toBe(
      "tablet",
    );
    expect(resolveZenResponsiveChrome({ ...input, availableInlineSize: 768 }).breakpoint).toBe(
      "tablet",
    );
    expect(resolveZenResponsiveChrome({ ...input, availableInlineSize: 767 }).breakpoint).toBe(
      "phone",
    );
  });

  it("fails closed on invalid geometry without inventing direct controls", () => {
    expect(
      resolveZenResponsiveChrome({
        ...roomyGeometry,
        availableInlineSize: Number.NaN,
        hasAppearance: true,
        hasContextualMenu: true,
        hasSettings: true,
        hasServiceGroups: true,
      }),
    ).toEqual({
      breakpoint: "phone",
      collapsed: ["appearance", "settings", "service-groups", "contextual"],
      direct: [],
      systemRequired: true,
    });
  });
});
