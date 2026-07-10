export const ESBLA_THEME_ID = "esbla_v1";
export const ESBLA_THEME_STORAGE_KEY = "esbla.theme.mode";
export const ESBLA_THEME_MODES = ["light", "dark", "high-contrast"] as const;

export type EsblaThemeMode = (typeof ESBLA_THEME_MODES)[number];
