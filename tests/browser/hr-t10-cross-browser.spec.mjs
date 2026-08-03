import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

const aggregateMatrix = process.env.ESBLA_T10_BROWSER_MATRIX === "1";
const restoredReplay = process.env.ESBLA_T10_RESTORED_REPLAY === "1";

async function openEmployee(browser) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const diagnostics = { console: [], external: [], page: [], server: [] };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.console.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.page.push(`${error.name}: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      diagnostics.server.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  await page.route("**/*", async (route) => {
    const requestOrigin = new URL(route.request().url()).origin;
    if (requestOrigin !== fixture.employeeOrigin) {
      diagnostics.external.push(requestOrigin);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return { context, diagnostics, page };
}

async function closeEmployee(employee) {
  expect.soft(employee.diagnostics.console, "console errors").toEqual([]);
  expect.soft(employee.diagnostics.external, "external requests").toEqual([]);
  expect.soft(employee.diagnostics.page, "page errors").toEqual([]);
  expect.soft(employee.diagnostics.server, "server errors").toEqual([]);
  await employee.context.close();
}

async function openNotifications(page) {
  const direct = page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ });
  if (await direct.isVisible()) {
    await direct.focus();
    await expect(direct).toBeFocused();
    await direct.press("Enter");
  } else {
    const system = page.getByRole("button", { exact: true, name: "User and system" });
    await system.focus();
    await expect(system).toBeFocused();
    await system.press("Enter");
    const systemPanel = page.getByRole("region", { exact: true, name: "User and system" });
    await expect(systemPanel.getByRole("heading", { name: "User and system" })).toBeFocused();
    await systemPanel
      .getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ })
      .press("Enter");
  }
  const panel = page.getByRole("region", { exact: true, name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { exact: true, name: "Notifications" })).toBeFocused();
  return panel;
}

async function assertBoundedSurface(page) {
  await expect(page.getByRole("heading", { name: "Your work, one surface" })).toBeVisible();
  await expect(page.locator("main .zen-widget").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

async function recordEngineReceipt({ browserName, browserVersion, testInfo, viewports }) {
  const receiptRoot = process.env.ESBLA_T10_ENGINE_RECEIPT_DIR;
  if (!receiptRoot) return;
  const artifactRoot = process.env.ESBLA_BROWSER_ARTIFACT_DIR;
  if (!artifactRoot || !isAbsolute(artifactRoot) || !isAbsolute(receiptRoot)) {
    throw new Error("T10 engine receipt root is invalid");
  }
  const selected = relative(resolve(artifactRoot), resolve(receiptRoot));
  if (!selected || selected.startsWith("..") || isAbsolute(selected)) {
    throw new Error("T10 engine receipt root is outside the private artifact root");
  }
  const expectedBrowser = {
    chromium: "chromium",
    "firefox-t10": "firefox",
    "webkit-t10": "webkit",
  }[testInfo.project.name];
  if (!expectedBrowser || expectedBrowser !== browserName) {
    throw new Error("T10 project and browser identity diverged");
  }
  await writeFile(
    join(receiptRoot, `${testInfo.project.name}.json`),
    `${JSON.stringify({
      browserName,
      browserVersion,
      keyboardActivatedNotifications: true,
      notificationsStateTruthful: true,
      platform: process.platform,
      projectName: testInfo.project.name,
      schemaVersion: 1,
      status: "T10_ENGINE_MATRIX_GREEN",
      surfaceEditorTablet: true,
      viewports,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

test("T10 renders the bounded Zen HR matrix on stable Chromium, Firefox, and WebKit", async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(!aggregateMatrix || restoredReplay, "aggregate browser matrix only");
  const employee = await openEmployee(browser);
  const viewports = [
    { colorScheme: "light", height: 900, label: "desktop-light", width: 1_440 },
    {
      colorScheme: "dark",
      height: 768,
      label: "tablet-dark-reduced",
      reducedMotion: "reduce",
      width: 1_024,
    },
    { colorScheme: "light", height: 900, label: "edge-light", width: 768 },
    { colorScheme: "light", height: 844, label: "phone-light", width: 390 },
    { colorScheme: "dark", height: 844, label: "phone-dark", width: 390 },
    {
      colorScheme: "dark",
      forcedColors: "active",
      height: 568,
      label: "phone-high-contrast-reflow",
      reducedMotion: "reduce",
      width: 320,
    },
  ];
  try {
    await testInfo.attach("browser-runtime", {
      body: Buffer.from(
        JSON.stringify({
          browserName,
          browserVersion: browser.version(),
          platform: process.platform,
          project: testInfo.project.name,
          viewports,
        }),
      ),
      contentType: "application/json",
    });
    for (const [index, viewport] of viewports.entries()) {
      await employee.page.emulateMedia({
        colorScheme: viewport.colorScheme,
        forcedColors: viewport.forcedColors ?? "none",
        reducedMotion: viewport.reducedMotion ?? "no-preference",
      });
      await employee.page.setViewportSize({ height: viewport.height, width: viewport.width });
      if (index === 0) {
        await employee.page.goto(fixture.employeeOrigin, { waitUntil: "networkidle" });
      }
      await assertBoundedSurface(employee.page);
      const path = testInfo.outputPath(`${browserName}-${viewport.label}.png`);
      await employee.page.screenshot({ animations: "disabled", path });
      await testInfo.attach(`${browserName}-${viewport.label}`, {
        contentType: "image/png",
        path,
      });
    }

    await employee.page.emulateMedia({
      colorScheme: "light",
      forcedColors: "none",
      reducedMotion: "no-preference",
    });
    await employee.page.setViewportSize({ height: 900, width: 1_440 });
    await employee.page.reload({ waitUntil: "networkidle" });
    const notifications = await openNotifications(employee.page);
    const firstNotification = notifications.locator("li").first();
    if ((await firstNotification.count()) > 0) await expect(firstNotification).toBeVisible();
    else
      await expect(notifications.getByText("You’re all caught up", { exact: true })).toBeVisible();
    await employee.page.keyboard.press("Escape");
    await expect(notifications).toBeHidden();

    await employee.page.setViewportSize({ height: 768, width: 1_024 });
    await employee.page.waitForLoadState("networkidle");
    await employee.page.goto(
      `${fixture.employeeOrigin}/studio/surfaces/surface.mission-control/personal`,
      { waitUntil: "networkidle" },
    );
    await expect(
      employee.page.getByRole("heading", { name: "Shape your Mission Control" }),
    ).toBeVisible();
    await employee.page.getByRole("button", { name: "Tablet preview" }).click();
    await expect(employee.page.locator(".surface-editor-viewport")).toHaveAttribute(
      "data-preview-mode",
      "tablet",
    );
    const editorPath = testInfo.outputPath(`${browserName}-surface-editor-tablet.png`);
    await employee.page.screenshot({ animations: "disabled", path: editorPath });
    await testInfo.attach(`${browserName}-surface-editor-tablet`, {
      contentType: "image/png",
      path: editorPath,
    });
    await recordEngineReceipt({
      browserName,
      browserVersion: browser.version(),
      testInfo,
      viewports,
    });
  } finally {
    await closeEmployee(employee);
  }
});

test("T10 restored Product reads preserved state, writes, restarts, and reads the write", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  test.skip(!restoredReplay, "restored Product replay only");
  const receiptPath = process.env.ESBLA_T10_RESTORED_RECEIPT;
  if (!receiptPath || !isAbsolute(receiptPath)) throw new Error("Restored receipt path is missing");
  const testControlOrigin = process.env.ESBLA_TEST_CONTROL_ORIGIN;
  const testControlToken = process.env.ESBLA_TEST_CONTROL_TOKEN;
  if (
    testControlOrigin !== "http://127.0.0.1:41900" ||
    !/^[0-9a-f]{64}$/.test(testControlToken ?? "")
  ) {
    throw new Error("Restored Product test control is missing");
  }
  const employee = await openEmployee(browser);
  try {
    await employee.page.setViewportSize({ height: 900, width: 1_440 });
    await employee.page.goto(fixture.employeeOrigin);
    await assertBoundedSurface(employee.page);
    const notifications = await openNotifications(employee.page);
    await expect(notifications.getByText("Your workforce profile is available")).toBeVisible();
    await employee.page.keyboard.press("Escape");

    await employee.page.goto(`${fixture.employeeOrigin}/settings`);
    await expect(
      employee.page.getByRole("heading", { name: "Your Esbla, with its source visible" }),
    ).toBeVisible();
    const density = employee.page.getByLabel("Density");
    const densityBefore = await density.inputValue();
    const densityAfter = densityBefore === "compact" ? "comfortable" : "compact";
    await density.selectOption(densityAfter);
    const response = employee.page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/presentation/preferences",
    );
    await employee.page.getByRole("button", { name: "Save my appearance" }).click();
    expect((await response).status()).toBe(200);

    await employee.page.goto("about:blank");
    const restart = await fetch(new URL("/__esbla-test-control/restart-web", testControlOrigin), {
      body: JSON.stringify({ persona: "employee" }),
      headers: {
        "content-type": "application/json",
        "x-esbla-test-control": testControlToken,
      },
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    expect(restart.status, await restart.text()).toBe(200);
    await employee.page.goto(`${fixture.employeeOrigin}/settings`);
    await expect(employee.page.getByLabel("Density")).toHaveValue(densityAfter);
    const path = testInfo.outputPath("restored-product-after-application-restart.png");
    await employee.page.screenshot({ animations: "disabled", path });
    await testInfo.attach("restored-product-after-application-restart", {
      contentType: "image/png",
      path,
    });
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        densityAfter,
        densityBefore,
        notificationTitle: "Your workforce profile is available",
        status: "RESTORED_PRODUCT_BROWSER_RESTART_GREEN",
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } finally {
    await closeEmployee(employee);
  }
});
