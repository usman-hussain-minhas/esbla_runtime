import { createRequire } from "node:module";
import path from "node:path";

const playwrightRequire = createRequire(
  new URL("./scripts/test/browser-tooling/package.json", import.meta.url),
);
const { defineConfig } = playwrightRequire("@playwright/test");

function artifactDirectory() {
  const value = process.env.ESBLA_E2E_ARTIFACT_DIR?.trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error("ESBLA_E2E_ARTIFACT_DIR must be an absolute path");
  }
  return value;
}

function browserEndpoint() {
  const value = process.env.ESBLA_E2E_BROWSER_WS_ENDPOINT?.trim();
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("ESBLA_E2E_BROWSER_WS_ENDPOINT must be a valid URL");
  }
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    Number(endpoint.port) < 1 ||
    Number(endpoint.port) > 65_535 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^\/[0-9a-f]{32}$/.test(endpoint.pathname)
  ) {
    throw new Error(
      "ESBLA_E2E_BROWSER_WS_ENDPOINT must be an exact tokenized IPv4 loopback WebSocket",
    );
  }
  return endpoint.href;
}

const artifacts = artifactDirectory();
const wsEndpoint = browserEndpoint();

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  forbidOnly: true,
  fullyParallel: false,
  globalTimeout: 120_000,
  outputDir: path.join(artifacts, "test-results"),
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
  reporter: [["line"], ["json", { outputFile: path.join(artifacts, "playwright-results.json") }]],
  retries: 0,
  testDir: "./tests/browser",
  timeout: 45_000,
  use: {
    actionTimeout: 10_000,
    connectOptions: {
      timeout: 15_000,
      wsEndpoint,
    },
    navigationTimeout: 15_000,
    screenshot: "off",
    trace: "off",
    video: "off",
    viewport: {
      height: 720,
      width: 1280,
    },
  },
  workers: 1,
});
