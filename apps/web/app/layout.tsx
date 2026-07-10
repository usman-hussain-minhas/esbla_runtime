import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import { ESBLA_THEME_STORAGE_KEY } from "./theme-contract";
import "./globals.css";

export const metadata: Metadata = {
  description: "Esbla workspace",
  title: "Esbla",
};

const themeInitializer = `(() => {
  try {
    const stored = localStorage.getItem(${JSON.stringify(ESBLA_THEME_STORAGE_KEY)});
    const mode = stored === "light" || stored === "dark" || stored === "high-contrast"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode === "dark" ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html data-theme="light" lang="en" suppressHydrationWarning>
      <body>
        <Script id="esbla-theme-init" strategy="beforeInteractive">
          {themeInitializer}
        </Script>
        {children}
      </body>
    </html>
  );
}
