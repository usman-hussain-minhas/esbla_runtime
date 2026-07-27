/**
 * Shared UI primitives deliberately do not choose a Product theme.
 * The Runtime theme registry is the single source of active Theme identity.
 */
export const uiThemeBinding = "runtime-theme-registry" as const;
