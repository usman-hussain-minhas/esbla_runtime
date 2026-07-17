import { isAbsolute } from "node:path";
import { defineConfig } from "@playwright/test";

const outputRoot = process.env.ESBLA_BROWSER_ARTIFACT_DIR ?? process.env.TMPDIR;
if (!outputRoot || !isAbsolute(outputRoot)) throw new Error("Private browser output root required");

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: true,
  fullyParallel: false,
  globalTimeout: 120_000,
  outputDir: `${outputRoot}/esbla-playwright-results`,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: "line",
  retries: 0,
  testDir: "tests/browser",
  timeout: 45_000,
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    viewport: { height: 800, width: 1280 },
  },
  workers: 1,
});
