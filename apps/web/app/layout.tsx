import type { PresentationPreferences } from "@esbla/contracts";
import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import {
  loadOwnPresentationPreferences,
  loadPresentationPreferenceCacheScope,
} from "../lib/presentation-preferences";
import { buildPresentationThemeInitializer } from "../lib/presentation-theme-cache-core";
import { ESBLA_THEME_CACHE_KEY } from "./theme-contract";
import "./globals.css";

export const metadata: Metadata = {
  description: "Esbla workspace",
  title: "Esbla",
};

export default async function RootLayout({
  children,
  modal,
}: Readonly<{ children: ReactNode; modal?: ReactNode }>) {
  let preferences: PresentationPreferences = {
    appearance: {
      density: {
        effectiveValue: "comfortable",
        key: "appearance.density.v1",
        locked: false,
        lockReason: null,
        source: "product_default",
        tenantValue: null,
        userValue: null,
      },
      highContrast: {
        effectiveValue: false,
        key: "appearance.high_contrast.v1",
        locked: false,
        lockReason: null,
        source: "product_default",
        tenantValue: null,
        userValue: null,
      },
      palette: {
        effectiveValue: "light",
        key: "appearance.palette.v1",
        locked: false,
        lockReason: null,
        source: "product_default",
        tenantValue: null,
        userValue: null,
      },
      reducedMotion: {
        effectiveValue: "auto",
        key: "appearance.reduced_motion.v1",
        locked: false,
        lockReason: null,
        source: "product_default",
        tenantValue: null,
        userValue: null,
      },
    },
    canManageTenantDefaults: false,
    tenantVersion: 0,
    userVersion: 0,
  };
  let cacheScope: string | null = null;
  let serverAvailable = false;
  try {
    cacheScope = loadPresentationPreferenceCacheScope();
  } catch {
    // Without an exact subject scope, any prior hydration cache is discarded.
  }
  try {
    preferences = await loadOwnPresentationPreferences();
    serverAvailable = true;
  } catch {
    // The cache may hydrate visual preference only; it never grants Product authority.
  }
  const appearance = preferences.appearance;
  return (
    <html
      data-density={appearance.density.effectiveValue}
      data-density-locked={String(appearance.density.locked)}
      data-high-contrast={String(appearance.highContrast.effectiveValue)}
      data-high-contrast-locked={String(appearance.highContrast.locked)}
      data-palette={appearance.palette.effectiveValue}
      data-preference-cache-scope={cacheScope ?? undefined}
      data-preference-status={serverAvailable ? "authoritative" : "cache-fallback"}
      data-preference-version={String(preferences.userVersion)}
      data-reduced-motion={appearance.reducedMotion.effectiveValue}
      data-reduced-motion-locked={String(appearance.reducedMotion.locked)}
      data-user-density={appearance.density.userValue ?? appearance.density.effectiveValue}
      data-user-high-contrast={String(
        appearance.highContrast.userValue ?? appearance.highContrast.effectiveValue,
      )}
      data-user-palette={appearance.palette.userValue ?? appearance.palette.effectiveValue}
      data-user-reduced-motion={
        appearance.reducedMotion.userValue ?? appearance.reducedMotion.effectiveValue
      }
      lang="en"
      suppressHydrationWarning
    >
      <body>
        <Script id="esbla-theme-init" strategy="beforeInteractive">
          {buildPresentationThemeInitializer({
            cacheKey: ESBLA_THEME_CACHE_KEY,
            cacheScope,
            density: appearance.density.effectiveValue,
            highContrast: appearance.highContrast.effectiveValue,
            palette: appearance.palette.effectiveValue,
            reducedMotion: appearance.reducedMotion.effectiveValue,
            serverAvailable,
            version: preferences.userVersion,
          })}
        </Script>
        {children}
        {modal}
      </body>
    </html>
  );
}
