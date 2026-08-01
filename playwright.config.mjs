import { isAbsolute } from "node:path";
import { defineConfig } from "@playwright/test";

const outputRoot = process.env.ESBLA_BROWSER_ARTIFACT_DIR ?? process.env.TMPDIR;
if (!outputRoot || !isAbsolute(outputRoot)) throw new Error("Private browser output root required");
const t10Aggregate = process.env.ESBLA_T10_BROWSER_MATRIX === "1";
const t10RestoredReplay = process.env.ESBLA_T10_RESTORED_REPLAY === "1";
const t10CrossBrowserSpec = /hr-t10-cross-browser\.spec\.mjs/;
const supportedAggregateWebKit = process.platform !== "darwin" || process.env.CI === "true";

const projects = t10RestoredReplay
  ? [
      {
        name: "chromium-restored-t10",
        testMatch: t10CrossBrowserSpec,
        use: { browserName: "chromium" },
      },
    ]
  : t10Aggregate
    ? [
        { name: "chromium", use: { browserName: "chromium" } },
        { name: "firefox-t10", testMatch: t10CrossBrowserSpec, use: { browserName: "firefox" } },
        ...(supportedAggregateWebKit
          ? [
              {
                name: "webkit-t10",
                testMatch: t10CrossBrowserSpec,
                use: { browserName: "webkit" },
              },
            ]
          : []),
      ]
    : [
        {
          name: "chromium",
          testIgnore: t10CrossBrowserSpec,
          use: { browserName: "chromium" },
        },
      ];

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: true,
  fullyParallel: false,
  globalTimeout: t10Aggregate ? 1_500_000 : 480_000,
  outputDir: `${outputRoot}/esbla-playwright-results`,
  preserveOutput: "always",
  projects,
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
