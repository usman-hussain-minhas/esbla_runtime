import type { PresentationPreferences } from "@esbla/contracts";
import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import { loadOwnPresentationPreferences } from "../lib/presentation-preferences";
import { ESBLA_THEME_CACHE_KEY } from "./theme-contract";
import "./globals.css";

export const metadata: Metadata = {
  description: "Esbla workspace",
  title: "Esbla",
};

function themeInitializer(input: {
  readonly highContrast: boolean;
  readonly palette: "dark" | "light";
  readonly serverAvailable: boolean;
  readonly version: number;
}) {
  return `(() => {
  const serverAvailable = ${JSON.stringify(input.serverAvailable)};
  let palette = ${JSON.stringify(input.palette)};
  let highContrast = ${JSON.stringify(input.highContrast)};
  let version = ${JSON.stringify(input.version)};
  if (!serverAvailable) {
    try {
      const cached = JSON.parse(localStorage.getItem(${JSON.stringify(ESBLA_THEME_CACHE_KEY)}) || "null");
      if (cached && (cached.palette === "light" || cached.palette === "dark")
          && typeof cached.highContrast === "boolean"
          && Number.isSafeInteger(cached.version) && cached.version >= 0) {
        ({ palette, highContrast, version } = cached);
      }
    } catch {}
  }
  document.documentElement.dataset.palette = palette;
  document.documentElement.dataset.highContrast = String(highContrast);
  document.documentElement.dataset.preferenceVersion = String(version);
  document.documentElement.style.colorScheme = palette;
  if (serverAvailable) {
    try {
      localStorage.setItem(${JSON.stringify(ESBLA_THEME_CACHE_KEY)}, JSON.stringify({
        highContrast, palette, version
      }));
    } catch {}
  }
})();`;
}

export default async function RootLayout({
  children,
  modal,
}: Readonly<{ children: ReactNode; modal?: ReactNode }>) {
  let preferences: PresentationPreferences = {
    highContrast: false,
    palette: "light" as const,
    source: "code_default" as const,
    version: 0,
  };
  let serverAvailable = false;
  try {
    preferences = await loadOwnPresentationPreferences();
    serverAvailable = true;
  } catch {
    // The cache may hydrate visual preference only; it never grants Product authority.
  }
  return (
    <html
      data-high-contrast={String(preferences.highContrast)}
      data-palette={preferences.palette}
      data-preference-status={serverAvailable ? "authoritative" : "cache-fallback"}
      data-preference-version={String(preferences.version)}
      lang="en"
      suppressHydrationWarning
    >
      <body>
        <Script id="esbla-theme-init" strategy="beforeInteractive">
          {themeInitializer({ ...preferences, serverAvailable })}
        </Script>
        {children}
        {modal}
      </body>
    </html>
  );
}
