import {
  ZEN_THEME_ALIASES,
  ZEN_THEME_CACHE_KEY,
  ZEN_THEME_DEFINITION,
} from "../theme/zen-theme/v1/identity";

export const ESBLA_THEME_ID = ZEN_THEME_DEFINITION.id;
export const ESBLA_THEME_ALIASES = ZEN_THEME_ALIASES;
export const ESBLA_THEME_VERSION = ZEN_THEME_DEFINITION.compatibilityVersion;
export const ESBLA_THEME_CACHE_KEY = ZEN_THEME_CACHE_KEY;
export const ESBLA_THEME_PALETTES = ZEN_THEME_DEFINITION.palettes;

export type EsblaThemePalette = (typeof ESBLA_THEME_PALETTES)[number];
