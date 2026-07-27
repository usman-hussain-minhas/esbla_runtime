import { ZEN_THEME_ALIASES, ZEN_THEME_DEFINITION } from "./zen-theme/v1/identity";

export const ACTIVE_THEME = ZEN_THEME_DEFINITION;
export const THEME_REGISTRY = [ZEN_THEME_DEFINITION] as const;

export function resolveThemeIdentity(value: string) {
  if (value === ZEN_THEME_DEFINITION.id || ZEN_THEME_ALIASES.includes(value as never)) {
    return ZEN_THEME_DEFINITION;
  }
  throw new Error("Unknown Product theme");
}
