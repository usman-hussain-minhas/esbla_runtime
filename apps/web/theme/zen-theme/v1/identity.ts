export const ZEN_THEME_ALIASES = ["zen", "zen_theme", "esbla_v1", "zen_v1", "zen-theme"] as const;

export const ZEN_THEME_DEFINITION = Object.freeze({
  aliases: ZEN_THEME_ALIASES,
  canonicalName: "esbla_theme_v1",
  compatibilityVersion: 1,
  displayName: "Zen",
  highContrast: "independent",
  id: "THEME-ESBLA-V1",
  palettes: ["light", "dark"] as const,
});

export type ZenPalette = (typeof ZEN_THEME_DEFINITION.palettes)[number];
