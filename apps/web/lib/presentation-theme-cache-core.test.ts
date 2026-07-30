import { describe, expect, it, vi } from "vitest";
import {
  buildPresentationThemeInitializer,
  writePresentationThemeCache,
} from "./presentation-theme-cache-core";

const cacheKey = "esbla.presentation.cache.v1";
const scopeA = "a".repeat(43);
const scopeB = "b".repeat(43);
const darkCompact = {
  density: "compact" as const,
  highContrast: true,
  palette: "dark" as const,
  reducedMotion: "reduce" as const,
  version: 7,
};

function executeInitializer(input: {
  readonly cacheScope: string | null;
  readonly serverAvailable: boolean;
  readonly storageValue?: string;
}) {
  const state = new Map<string, string>();
  if (input.storageValue !== undefined) state.set(cacheKey, input.storageValue);
  const storage = {
    getItem: vi.fn((key: string) => state.get(key) ?? null),
    removeItem: vi.fn((key: string) => state.delete(key)),
    setItem: vi.fn((key: string, value: string) => state.set(key, value)),
  };
  const document = { documentElement: { dataset: {}, style: {} } };
  const source = buildPresentationThemeInitializer({
    cacheKey,
    cacheScope: input.cacheScope,
    density: "comfortable",
    highContrast: false,
    palette: "light",
    reducedMotion: "auto",
    serverAvailable: input.serverAvailable,
    version: 0,
  });
  Function("document", "localStorage", source)(document, storage);
  return { document, state, storage };
}

describe("presentation hydration cache isolation", () => {
  it("uses cache only for the exact opaque subject scope", () => {
    const matching = executeInitializer({
      cacheScope: scopeA,
      serverAvailable: false,
      storageValue: JSON.stringify({ ...darkCompact, scope: scopeA }),
    });
    expect(matching.document.documentElement).toEqual({
      dataset: {
        density: "compact",
        highContrast: "true",
        palette: "dark",
        preferenceVersion: "7",
        reducedMotion: "reduce",
      },
      style: { colorScheme: "dark" },
    });

    const mismatched = executeInitializer({
      cacheScope: scopeB,
      serverAvailable: false,
      storageValue: JSON.stringify({ ...darkCompact, scope: scopeA }),
    });
    expect(mismatched.document.documentElement.dataset).toMatchObject({
      density: "comfortable",
      highContrast: "false",
      palette: "light",
      reducedMotion: "auto",
    });
    expect(mismatched.storage.removeItem).toHaveBeenCalledWith(cacheKey);
    expect(mismatched.state.has(cacheKey)).toBe(false);
  });

  it("writes only scoped authoritative values and removes cache without a subject", () => {
    const authoritative = executeInitializer({
      cacheScope: scopeA,
      serverAvailable: true,
    });
    expect(JSON.parse(authoritative.state.get(cacheKey) ?? "")).toEqual({
      density: "comfortable",
      highContrast: false,
      palette: "light",
      reducedMotion: "auto",
      scope: scopeA,
      version: 0,
    });

    const state = new Map([[cacheKey, JSON.stringify({ ...darkCompact, scope: scopeA })]]);
    const storage = {
      removeItem: vi.fn((key: string) => state.delete(key)),
      setItem: vi.fn((key: string, value: string) => state.set(key, value)),
    };
    writePresentationThemeCache(storage, cacheKey, null, darkCompact);
    expect(storage.removeItem).toHaveBeenCalledWith(cacheKey);
    expect(state.has(cacheKey)).toBe(false);
  });
});
