export interface PresentationThemeAppearance {
  readonly density: "comfortable" | "compact";
  readonly highContrast: boolean;
  readonly palette: "dark" | "light";
  readonly reducedMotion: "auto" | "reduce";
  readonly version: number;
}

interface PresentationThemeInitializerInput extends PresentationThemeAppearance {
  readonly cacheKey: string;
  readonly cacheScope: string | null;
  readonly serverAvailable: boolean;
}

interface PresentationThemeCacheStorage {
  removeItem(key: string): unknown;
  setItem(key: string, value: string): unknown;
}

const CACHE_SCOPE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function writePresentationThemeCache(
  storage: PresentationThemeCacheStorage,
  cacheKey: string,
  cacheScope: string | null,
  appearance: PresentationThemeAppearance,
): void {
  if (!cacheScope || !CACHE_SCOPE_PATTERN.test(cacheScope)) {
    storage.removeItem(cacheKey);
    return;
  }
  storage.setItem(
    cacheKey,
    JSON.stringify({
      ...appearance,
      scope: cacheScope,
    }),
  );
}

export function buildPresentationThemeInitializer(
  input: PresentationThemeInitializerInput,
): string {
  return `(() => {
  const cacheKey = ${JSON.stringify(input.cacheKey)};
  const cacheScope = ${JSON.stringify(input.cacheScope)};
  const serverAvailable = ${JSON.stringify(input.serverAvailable)};
  let density = ${JSON.stringify(input.density)};
  let palette = ${JSON.stringify(input.palette)};
  let highContrast = ${JSON.stringify(input.highContrast)};
  let reducedMotion = ${JSON.stringify(input.reducedMotion)};
  let version = ${JSON.stringify(input.version)};
  if (!serverAvailable) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cacheScope && /^[A-Za-z0-9_-]{43}$/.test(cacheScope)
          && cached && cached.scope === cacheScope
          && (cached.palette === "light" || cached.palette === "dark")
          && (cached.density === "comfortable" || cached.density === "compact")
          && typeof cached.highContrast === "boolean"
          && (cached.reducedMotion === "auto" || cached.reducedMotion === "reduce")
          && Number.isSafeInteger(cached.version) && cached.version >= 0) {
        ({ density, palette, highContrast, reducedMotion, version } = cached);
      } else {
        localStorage.removeItem(cacheKey);
      }
    } catch {
      try { localStorage.removeItem(cacheKey); } catch {}
    }
  }
  document.documentElement.dataset.density = density;
  document.documentElement.dataset.palette = palette;
  document.documentElement.dataset.highContrast = String(highContrast);
  document.documentElement.dataset.reducedMotion = reducedMotion;
  document.documentElement.dataset.preferenceVersion = String(version);
  document.documentElement.style.colorScheme = palette;
  if (serverAvailable) {
    try {
      if (cacheScope && /^[A-Za-z0-9_-]{43}$/.test(cacheScope)) {
        localStorage.setItem(cacheKey, JSON.stringify({
          density, highContrast, palette, reducedMotion, scope: cacheScope, version
        }));
      } else {
        localStorage.removeItem(cacheKey);
      }
    } catch {}
  }
})();`;
}
