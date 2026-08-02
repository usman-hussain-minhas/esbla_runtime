import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

test.describe.configure({ mode: "serial" });
const employmentActionWorkerProfileId = process.env.ESBLA_TEST_EMPLOYMENT_ACTION_WORKER_PROFILE_ID;
const fixtureId = /^[0-9a-f-]{36}$/;
if (!fixtureId.test(employmentActionWorkerProfileId ?? "")) {
  throw new Error("Employment action Worker Profile fixture is missing");
}
const shiftEmployeeWorkerProfileId = process.env.ESBLA_TEST_SHIFT_EMPLOYEE_WORKER_PROFILE_ID;
if (!fixtureId.test(shiftEmployeeWorkerProfileId ?? "")) {
  throw new Error("Shift Worker Profile fixtures are missing");
}
const testControlOrigin = process.env.ESBLA_TEST_CONTROL_ORIGIN;
const testControlToken = process.env.ESBLA_TEST_CONTROL_TOKEN;
if (
  testControlOrigin !== "http://127.0.0.1:41900" ||
  !/^[0-9a-f]{64}$/.test(testControlToken ?? "")
) {
  throw new Error("Browser test control is missing");
}

async function testControl(pathname, body) {
  const response = await fetch(new URL(pathname, testControlOrigin), {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-esbla-test-control": testControlToken,
    },
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  const responseBody = await response.text();
  expect(response.status, responseBody).toBe(200);
  return JSON.parse(responseBody);
}

async function setEmployeeLeavePresentationEligibility(active, capabilities) {
  expect(
    await testControl("/__esbla-test-control/leave-presentation-eligibility", {
      active,
      capabilities,
    }),
  ).toEqual({ status: "updated" });
}

async function setForcedMissingLeaveRequest(leaveRequestId) {
  expect(
    await testControl("/__esbla-test-control/leave-detail-missing", { leaveRequestId }),
  ).toEqual({ status: "updated" });
}

async function setEmployeeSessionPrincipal(principal) {
  expect(
    await testControl("/__esbla-test-control/employee-session-principal", { principal }),
  ).toEqual({
    status: "restarted",
  });
}

function consumeCooperativeRestartDiagnostics(actor, fromIndex) {
  const diagnostics = actor.diagnostics.console.splice(fromIndex);
  expect(
    diagnostics.every(
      (message) => message === "Failed to load resource: net::ERR_CONNECTION_REFUSED",
    ),
    "the cooperative web restart emits only bounded connection-refused diagnostics",
  ).toBe(true);
}

async function setEmployeeWorkforcePresentationEligibility(eligible) {
  expect(
    await testControl("/__esbla-test-control/workforce-presentation-eligibility", {
      eligible,
    }),
  ).toEqual({ status: "updated" });
}

async function setEmployeePresentationLayoutWrite(enabled) {
  expect(
    await testControl("/__esbla-test-control/presentation-layout-write", {
      enabled,
    }),
  ).toEqual({ status: "updated" });
}

async function setMissionControlPersonalization(enabled) {
  expect(
    await testControl("/__esbla-test-control/presentation-surface-personalization", {
      enabled,
    }),
  ).toEqual({ status: "updated" });
}

async function setStudioSurfaceBaseCapability(capabilityId, enabled) {
  expect(
    await testControl("/__esbla-test-control/studio-surface-base-capability", {
      capabilityId,
      enabled,
    }),
  ).toEqual({ status: "updated" });
}

async function restartEmployeeApplication() {
  expect(await testControl("/__esbla-test-control/restart-web", { persona: "employee" })).toEqual({
    status: "restarted",
  });
}
async function openActor(browser, origin, label, contextOptions = {}, initScript) {
  const context = await browser.newContext({ ...contextOptions, serviceWorkers: "block" });
  if (initScript) await context.addInitScript(initScript);
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
    if (requestOrigin !== origin) {
      diagnostics.external.push(requestOrigin);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  return { context, diagnostics, label, origin, page };
}

function installBoundedVisualViewport() {
  const state = {
    height: 520,
    offsetLeft: 25,
    offsetTop: 60,
    width: 340,
  };
  const viewport = new EventTarget();
  for (const key of ["height", "offsetLeft", "offsetTop", "width"]) {
    Object.defineProperty(viewport, key, {
      configurable: false,
      enumerable: true,
      get: () => state[key],
    });
  }
  Object.defineProperties(viewport, {
    pageLeft: { get: () => state.offsetLeft },
    pageTop: { get: () => state.offsetTop },
    scale: { get: () => 1 },
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    get: () => viewport,
  });
  window.__setEsblaVisualViewport = (next) => {
    Object.assign(state, next);
    viewport.dispatchEvent(new Event("resize"));
  };
}
async function closeActors(...actors) {
  for (const actor of actors) {
    expect.soft(actor.diagnostics.console, `${actor.label} console errors`).toEqual([]);
    expect.soft(actor.diagnostics.external, `${actor.label} external requests`).toEqual([]);
    expect.soft(actor.diagnostics.page, `${actor.label} page errors`).toEqual([]);
    expect.soft(actor.diagnostics.server, `${actor.label} server errors`).toEqual([]);
  }
  const receipts = await Promise.allSettled(
    actors.map(async (actor) => await actor.context.close()),
  );
  expect
    .soft(
      receipts.every((receipt) => receipt.status === "fulfilled"),
      "actor contexts close cleanly",
    )
    .toBe(true);
}

async function openAppearance(actor) {
  const directLauncher = actor.page.getByRole("button", {
    exact: true,
    name: "Appearance settings",
  });
  const panel = actor.page.getByRole("region", { name: "Appearance settings" });
  if (await directLauncher.isVisible()) {
    await expect(directLauncher).toBeEnabled();
    if ((await directLauncher.getAttribute("aria-expanded")) !== "true") {
      await directLauncher.click();
    }
    await expect(directLauncher).toHaveAttribute("aria-expanded", "true");
  } else {
    const systemLauncher = actor.page.getByRole("button", {
      exact: true,
      name: "User and system",
    });
    await expect(systemLauncher).toBeVisible();
    await expect(systemLauncher).toBeEnabled();
    if ((await systemLauncher.getAttribute("aria-expanded")) !== "true") {
      await systemLauncher.click();
    }
    const systemPanel = actor.page.getByRole("region", { name: "User and system" });
    await expect(systemPanel).toBeVisible();
    await systemPanel.getByRole("button", { exact: true, name: "Appearance" }).click();
    await expect(systemLauncher).toHaveAttribute("aria-expanded", "true");
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function openNotifications(actor) {
  const viewport = actor.page.viewportSize();
  if (viewport) {
    const responsiveClass =
      viewport.width >= 1_100 ? "desktop" : viewport.width >= 768 ? "tablet" : "phone";
    await expect(actor.page.locator(".zen-shell-chrome")).toHaveAttribute(
      "data-responsive-class",
      responsiveClass,
    );
  }
  const directLauncher = actor.page.getByRole("button", {
    name: /^Notifications(?:, \d+ unread)?$/,
  });
  if (await directLauncher.isVisible()) {
    await directLauncher.press("Enter");
  } else {
    const systemLauncher = actor.page.getByRole("button", {
      exact: true,
      name: "User and system",
    });
    await systemLauncher.focus();
    await expect(systemLauncher).toBeFocused();
    await systemLauncher.press("Enter");
    const systemPanel = actor.page.getByRole("region", { name: "User and system" });
    await expect(systemPanel).toBeVisible();
    await expect(systemPanel.getByRole("heading", { name: "User and system" })).toBeFocused();
    await systemPanel
      .getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ })
      .press("Enter");
  }
  const panel = actor.page.getByRole("region", { exact: true, name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { exact: true, name: "Notifications" })).toBeFocused();
  return panel;
}

async function enableHighContrast(actor) {
  if ((await actor.page.locator("html").getAttribute("data-high-contrast")) === "true") return;
  const panel = await openAppearance(actor);
  await panel.getByRole("button", { name: "High contrast" }).click();
  await expect(actor.page.locator("html")).toHaveAttribute("data-high-contrast", "true");
}

async function enableDarkHighContrast(actor) {
  const panel = await openAppearance(actor);
  if ((await actor.page.locator("html").getAttribute("data-palette")) !== "dark") {
    const responsePromise = actor.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/preferences",
    );
    await panel.getByRole("button", { name: "Dark" }).click();
    const response = await responsePromise;
    if (response.status() !== 200) {
      throw new Error(`Appearance update ${response.status()}: ${await response.text()}`);
    }
    await expect(actor.page.locator("html")).toHaveAttribute("data-palette", "dark");
  }
  if ((await actor.page.locator("html").getAttribute("data-high-contrast")) !== "true") {
    await panel.getByRole("button", { name: "High contrast" }).click();
    await expect(actor.page.locator("html")).toHaveAttribute("data-high-contrast", "true");
  }
}

async function submitLeave(actor, values) {
  await actor.page.goto(`${actor.origin}/workspace/hr/leave/new`);
  await expect(actor.page).toHaveTitle("Esbla");
  await expect(actor.page.getByRole("heading", { name: "New leave request" })).toBeVisible();
  await expect(actor.page.locator(".esbla-shell")).toHaveAttribute("data-current-surface", "HR");

  const leaveType = actor.page.getByLabel("Leave type");
  const startDate = actor.page.getByLabel("Start date");
  await leaveType.focus();
  await leaveType.press("Tab");
  await expect(startDate).toBeFocused();

  await leaveType.selectOption("annual");
  await startDate.fill(values.startDate);
  await actor.page.getByLabel("End date").fill(values.endDate);
  await actor.page.getByLabel("Reason").fill(values.reason);
  const submit = actor.page.getByRole("button", { name: "Submit request" });
  await submit.focus();
  await actor.page.keyboard.press("Enter");

  await expect(actor.page).toHaveURL(
    /\/workspace\/hr\/leave\/[0-9a-f-]+\?returnContext=leave-list$/,
  );
  const match = new URL(actor.page.url()).pathname.match(/\/workspace\/hr\/leave\/([^/]+)$/);
  expect(match?.[1]).toBeTruthy();
  const leaveRequestId = match?.[1] ?? "";
  await expect(actor.page.locator("[data-leave-detail-face] .leave-status")).toHaveText(
    "Submitted",
  );
  await expect(actor.page.getByRole("heading", { name: "Evidence history" })).toBeVisible();
  await expect(actor.page.locator(".leave-history-item strong")).toHaveText(["Submitted"]);
  return leaveRequestId;
}
function assignedCard(page, leaveRequestId) {
  return page.locator('ol[aria-label="Assigned leave approvals"] > li').filter({
    has: page.locator(`a[href="/workspace/hr/leave/${leaveRequestId}?returnContext=my-work"]`),
  });
}
async function openAssignedWork(actor, leaveRequestId) {
  await actor.page.goto(`${actor.origin}/workspace/my-work`);
  await expect(actor.page.getByRole("heading", { name: "Assigned work" })).toBeVisible();
  await expect(actor.page.locator(".esbla-shell")).toHaveAttribute(
    "data-current-surface",
    "My Work",
  );
  await expect(
    actor.page.getByRole("heading", { name: "No workspace tasks on this page" }),
  ).toBeVisible();
  const card = assignedCard(actor.page, leaveRequestId);
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("heading", { name: fixture.employeeDisplayName })).toBeVisible();
  return card;
}

async function expectHistory(actor, status, states) {
  const detail = actor.page.locator("[data-leave-detail-face]");
  await expect(detail.locator(".leave-status")).toHaveText(status);
  await expect(detail.locator(".leave-history-item strong")).toHaveText(states);
}

function workforceRecordVersion(page) {
  return page
    .locator(".leave-detail-facts > div")
    .filter({ hasText: "Record version" })
    .locator("dd");
}

function serviceControlFact(page, label) {
  return page
    .locator(".leave-detail-facts > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");
}

function tenantSurfaceFact(page, label) {
  return page
    .locator(".tenant-surface-facts > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");
}

function employmentRecordCard(page, workerProfileId) {
  return page
    .locator('section[aria-labelledby="employment-maintain-heading"] > ol > li')
    .filter({ hasText: workerProfileId });
}

function employmentFact(page, label) {
  return page.locator(".leave-detail-facts > div").filter({ hasText: label }).locator("dd");
}

async function waitForShellHydration(actor) {
  const appearance = actor.page.getByRole("button", {
    exact: true,
    name: "Appearance settings",
  });
  if ((await appearance.count()) > 0) await expect(appearance).toBeEnabled();
}

async function submitEmploymentForm(actor, button) {
  await waitForShellHydration(actor);
  const form = button.locator("xpath=ancestor::form");
  expect(await form.evaluate((element) => element.checkValidity())).toBe(true);
  const [request] = await Promise.all([
    actor.page.waitForRequest(
      (candidate) =>
        candidate.method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/employment/action",
      { timeout: 20_000 },
    ),
    button.press("Enter"),
  ]);
  expect((await request.response())?.status()).toBe(303);
  await expect(actor.page).toHaveURL(
    /\/workspace\/hr\/employment\/(admin|settings)\?result=success/,
  );
  await expect(actor.page.locator(".success-banner")).toBeFocused();
  await waitForShellHydration(actor);
}

async function proveRepresentativeRouteBackedWidget(
  actor,
  { dialogName, expectedHref, launcherName, screenshotStem, standaloneHeading },
  testInfo,
) {
  await actor.page.setViewportSize({ height: 800, width: 1280 });
  await actor.page.goto(`${actor.origin}/workspace/hr`);
  await waitForShellHydration(actor);
  const launcher = actor.page.getByRole("link", {
    exact: true,
    name: launcherName,
  });
  await expect(launcher).toHaveAttribute("href", expectedHref);
  await launcher.press("Enter");
  await expect(actor.page).toHaveURL(`${actor.origin}${expectedHref}`);

  const overlay = actor.page.getByRole("dialog", {
    exact: true,
    name: dialogName,
  });
  await expect(overlay).toBeVisible();
  await expect(overlay).toBeFocused();
  await expect(
    overlay.getByRole("heading", { exact: true, level: 1, name: standaloneHeading }),
  ).toBeVisible();
  await expect(actor.page.locator(".esbla-shell")).toHaveAttribute("aria-hidden", "true");
  await expect(actor.page.locator(".esbla-shell")).toHaveAttribute("inert", "");

  await actor.page.keyboard.press("Shift+Tab");
  expect(
    await overlay.evaluate((element) => element.contains(document.activeElement)),
    `${dialogName} keeps reverse-tab focus inside`,
  ).toBe(true);
  await actor.page.keyboard.press("Tab");
  expect(
    await overlay.evaluate((element) => element.contains(document.activeElement)),
    `${dialogName} keeps forward-tab focus inside`,
  ).toBe(true);

  const desktopPath = testInfo.outputPath(`${screenshotStem}-desktop.png`);
  await actor.page.screenshot({ fullPage: false, path: desktopPath });
  await testInfo.attach(`${screenshotStem}-desktop`, {
    contentType: "image/png",
    path: desktopPath,
  });

  await actor.page.setViewportSize({ height: 844, width: 390 });
  expect(
    await actor.page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    `${dialogName} has no horizontal overflow at 390px`,
  ).toBe(true);
  const mobilePath = testInfo.outputPath(`${screenshotStem}-mobile.png`);
  await actor.page.screenshot({ fullPage: false, path: mobilePath });
  await testInfo.attach(`${screenshotStem}-mobile`, {
    contentType: "image/png",
    path: mobilePath,
  });

  await actor.page.reload();
  await expect(actor.page.getByRole("dialog")).toHaveCount(0);
  await expect(
    actor.page.getByRole("heading", {
      exact: true,
      level: 1,
      name: standaloneHeading,
    }),
  ).toBeVisible();
  await expect(actor.page.locator(".esbla-shell")).not.toHaveAttribute("aria-hidden", "true");
  await expect(actor.page.locator(".esbla-shell")).not.toHaveAttribute("inert", "");
}

test("employee Profile and Leave-list widgets render as responsive route-backed products", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  try {
    await proveRepresentativeRouteBackedWidget(
      employee,
      {
        dialogName: "Workforce profile",
        expectedHref:
          "/workspace/hr/profile?originFocusId=hr-mission-control.my-profile.full-screen&returnSurface=hr-mission-control",
        launcherName: "Open My Profile",
        screenshotStem: "representative-workforce-profile",
        standaloneHeading: "Workforce profile",
      },
      testInfo,
    );
    await proveRepresentativeRouteBackedWidget(
      employee,
      {
        dialogName: "My leave requests",
        expectedHref:
          "/workspace/hr/leave?originFocusId=hr-mission-control.my-leave.full-screen&returnSurface=hr-mission-control",
        launcherName: "View all My Leave Requests",
        screenshotStem: "representative-leave-list",
        standaloneHeading: "My Leave Requests",
      },
      testInfo,
    );
  } finally {
    await closeActors(employee);
  }
});

test("Leave focus workspace preserves origin, nested Back, dirty guard and mobile single pane", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  try {
    await employee.page.setViewportSize({ height: 800, width: 1_280 });
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await waitForShellHydration(employee);
    await employee.page
      .getByRole("link", { exact: true, name: "View all My Leave Requests" })
      .press("Enter");

    const listOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "My leave requests",
    });
    await expect(listOverlay).toBeVisible();
    await listOverlay.getByRole("link", { exact: true, name: "New request" }).press("Enter");

    const newOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "New leave request",
    });
    const workspace = newOverlay.locator('[data-focus-workspace="hr-leave"]');
    await expect(newOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/leave/new?returnContext=hr-mission-control&originFocusId=hr-mission-control.my-leave.full-screen`,
    );
    await expect(workspace).toHaveAttribute("data-focus-layout", "master-detail");
    await expect(workspace.locator('[data-focus-pane="master"]')).toBeVisible();
    await expect(workspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    await expect(
      newOverlay.getByRole("link", { exact: true, name: "Back to requests" }),
    ).toBeVisible();
    await expect(newOverlay.getByRole("button", { name: "Close new leave request" })).toBeVisible();

    const desktopPath = testInfo.outputPath("leave-new-focus-workspace-desktop.png");
    await employee.page.screenshot({ fullPage: false, path: desktopPath });
    await testInfo.attach("leave-new-focus-workspace-desktop", {
      contentType: "image/png",
      path: desktopPath,
    });

    await employee.page.getByLabel("Reason").fill("Unsaved focus workspace draft");
    const failedSubmission = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/workspace/hr/leave/new/submit" &&
        response.request().method() === "POST",
    );
    await newOverlay.getByRole("button", { name: "Submit request" }).click();
    expect((await failedSubmission).status()).toBe(400);
    await expect(newOverlay.getByRole("alert")).toContainText("Review the highlighted fields.");
    expect(employee.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 400 (Bad Request)",
    ]);
    employee.diagnostics.console.length = 0;
    const dismissedPrompt = new Promise((resolve) => {
      employee.page.once("dialog", async (dialog) => {
        resolve(dialog.message());
        await dialog.dismiss();
      });
    });
    await newOverlay.getByRole("link", { exact: true, name: "Back to requests" }).click();
    expect(await dismissedPrompt).toBe("Discard unsaved changes and leave this view?");
    await expect(newOverlay).toBeVisible();
    await expect(employee.page.getByLabel("Reason")).toHaveValue("Unsaved focus workspace draft");

    const acceptedPrompt = new Promise((resolve) => {
      employee.page.once("dialog", async (dialog) => {
        resolve(dialog.message());
        await dialog.accept();
      });
    });
    await newOverlay.getByRole("link", { exact: true, name: "Back to requests" }).click();
    expect(await acceptedPrompt).toBe("Discard unsaved changes and leave this view?");
    await expect(listOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/leave?originFocusId=hr-mission-control.my-leave.full-screen&returnSurface=hr-mission-control`,
    );

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await listOverlay.getByRole("link", { exact: true, name: "New request" }).press("Enter");
    await expect(newOverlay).toBeVisible();
    await expect(workspace.locator('[data-focus-pane="master"]')).toBeHidden();
    await expect(workspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const mobilePath = testInfo.outputPath("leave-new-focus-workspace-mobile.png");
    await employee.page.screenshot({ fullPage: false, path: mobilePath });
    await testInfo.attach("leave-new-focus-workspace-mobile", {
      contentType: "image/png",
      path: mobilePath,
    });

    await employee.page.goBack();
    await expect(listOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/leave?originFocusId=hr-mission-control.my-leave.full-screen&returnSurface=hr-mission-control`,
    );

    await employee.page.goForward();
    await expect(newOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/leave/new?returnContext=hr-mission-control&originFocusId=hr-mission-control.my-leave.full-screen`,
    );
    await expect(workspace.locator('[data-focus-pane="master"]')).toBeHidden();
    await employee.page.goBack();
    await expect(listOverlay).toBeVisible();

    await listOverlay.getByRole("link", { exact: true, name: "New request" }).press("Enter");
    const revalidatedOrigin = employee.page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        response.url() === `${employee.origin}/workspace/hr`,
    );
    await newOverlay.getByRole("button", { name: "Close new leave request" }).press("Enter");
    expect((await revalidatedOrigin).status()).toBe(200);
    await employee.page.waitForLoadState("load");
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr`);
    await expect(employee.page.getByRole("dialog")).toHaveCount(0);
    await expect(
      employee.page.locator("#hr-mission-control\\.my-leave\\.full-screen"),
    ).toBeFocused();
  } finally {
    await closeActors(employee);
  }
});

test("Leave focus workspace fails closed after authorization loss, deactivation and stale detail", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  let eligibilityChanged = false;
  let forcedMissing = false;
  let leaveRequestId;
  let sessionChanged = false;
  const detailReason = "Focus fail-closed proof";
  try {
    leaveRequestId = await submitLeave(employee, {
      endDate: "2027-03-09",
      reason: detailReason,
      startDate: "2027-03-09",
    });
    const openFromCurrentList = async () => {
      await employee.page.goto(`${employee.origin}/workspace/hr`);
      await employee.page
        .getByRole("link", { exact: true, name: "View all My Leave Requests" })
        .press("Enter");
      const listOverlay = employee.page.getByRole("dialog", {
        exact: true,
        name: "My leave requests",
      });
      await expect(listOverlay).toBeVisible();
      const detailLink = listOverlay.locator(`a[href*="/workspace/hr/leave/${leaveRequestId}?"]`);
      await expect(detailLink).toBeVisible();
      return detailLink;
    };
    const expectSafeError = async (actor) => {
      const overlay = actor.page.getByRole("dialog", {
        exact: true,
        name: "Leave request detail",
      });
      await expect(overlay).toBeVisible();
      await expect(overlay.locator('[data-focus-workspace="hr-leave"]')).toHaveAttribute(
        "data-focus-layout",
        "single",
      );
      await expect(overlay.getByRole("alert")).toContainText("Request details could not be loaded");
      await expect(overlay).not.toContainText(detailReason);
    };

    let detailLink = await openFromCurrentList();
    let restartDiagnosticsStart = employee.diagnostics.console.length;
    await setEmployeeSessionPrincipal("alternate");
    sessionChanged = true;
    await detailLink.press("Enter");
    await expectSafeError(employee);
    consumeCooperativeRestartDiagnostics(employee, restartDiagnosticsStart);
    restartDiagnosticsStart = employee.diagnostics.console.length;
    await setEmployeeSessionPrincipal("employee");
    sessionChanged = false;

    detailLink = await openFromCurrentList();
    consumeCooperativeRestartDiagnostics(employee, restartDiagnosticsStart);
    await setEmployeeLeavePresentationEligibility(false, ["hr.leave.list_own", "hr.leave.view"]);
    eligibilityChanged = true;
    await detailLink.press("Enter");
    await expectSafeError(employee);

    await setEmployeeLeavePresentationEligibility(true, ["hr.leave.list_own", "hr.leave.view"]);
    await restartEmployeeApplication();
    detailLink = await openFromCurrentList();
    await setForcedMissingLeaveRequest(leaveRequestId);
    forcedMissing = true;
    await detailLink.press("Enter");
    const missingOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "Leave request detail",
    });
    await expect(missingOverlay).toBeVisible();
    await expect(
      missingOverlay.getByRole("heading", { name: "Leave request not found" }),
    ).toBeVisible();
    await expect(missingOverlay.locator('[data-focus-pane="master"]')).toBeVisible();
    await expect(missingOverlay.locator('[data-focus-pane="detail"]')).toBeVisible();
    await expect(missingOverlay).not.toContainText(detailReason);

    const assignedMissingCard = await openAssignedWork(manager, leaveRequestId);
    await assignedMissingCard
      .locator(`a[href="/workspace/hr/leave/${leaveRequestId}?returnContext=my-work"]`)
      .press("Enter");
    await expect(manager.page).toHaveURL(
      `${manager.origin}/workspace/hr/leave/${leaveRequestId}?returnContext=my-work`,
    );
    await expect(
      manager.page.getByRole("heading", { name: "Leave request not found" }),
    ).toBeVisible();
    const returnToMyWork = manager.page.getByRole("link", {
      exact: true,
      name: "Back to My Work",
    });
    await expect(returnToMyWork).toHaveAttribute("href", "/workspace/my-work");
    await expect(manager.page.getByRole("dialog")).toHaveCount(0);
    await expect(manager.page.locator("main")).not.toContainText(detailReason);
    await returnToMyWork.press("Enter");
    await expect(manager.page).toHaveURL(`${manager.origin}/workspace/my-work`);

    await setForcedMissingLeaveRequest(null);
    forcedMissing = false;
    await setEmployeeLeavePresentationEligibility(true, [
      "hr.leave.list_own",
      "hr.leave.submit",
      "hr.leave.view",
    ]);
    eligibilityChanged = false;
    const assignedCard = await openAssignedWork(manager, leaveRequestId);
    await assignedCard.getByRole("button", { name: "Approve leave request" }).click();
    await assignedCard.getByRole("button", { name: "Confirm approval" }).click();
    await expectHistory(manager, "Approved", ["Submitted", "Approved"]);
  } finally {
    if (forcedMissing) await setForcedMissingLeaveRequest(null).catch(() => undefined);
    if (sessionChanged) {
      const restartDiagnosticsStart = employee.diagnostics.console.length;
      await setEmployeeSessionPrincipal("employee").catch(() => undefined);
      consumeCooperativeRestartDiagnostics(employee, restartDiagnosticsStart);
    }
    if (eligibilityChanged) {
      await setEmployeeLeavePresentationEligibility(true, [
        "hr.leave.list_own",
        "hr.leave.submit",
        "hr.leave.view",
      ]).catch(() => undefined);
    }
    await closeActors(employee, manager);
  }
});

test("employee Employment and Shift widgets render as responsive route-backed products", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  try {
    await proveRepresentativeRouteBackedWidget(
      employee,
      {
        dialogName: "Employment facts",
        expectedHref:
          "/workspace/hr/employment?originFocusId=hr-mission-control.current-employment.full-screen&returnSurface=hr-mission-control",
        launcherName: "Open Current Employment Facts",
        screenshotStem: "representative-employment-facts",
        standaloneHeading: "Employment facts",
      },
      testInfo,
    );
    await proveRepresentativeRouteBackedWidget(
      employee,
      {
        dialogName: "My shifts",
        expectedHref:
          "/workspace/hr/shifts?originFocusId=hr-mission-control.my-published-shifts.full-screen&returnSurface=hr-mission-control",
        launcherName: "Open My Published Shifts",
        screenshotStem: "representative-published-shifts",
        standaloneHeading: "My shifts",
      },
      testInfo,
    );
  } finally {
    await closeActors(employee);
  }
});

test("manager My Work widget renders as a responsive route-backed product", async ({
  browser,
}, testInfo) => {
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    await proveRepresentativeRouteBackedWidget(
      manager,
      {
        dialogName: "My Work",
        expectedHref:
          "/workspace/my-work?originFocusId=hr-mission-control.my-work.full-screen&returnSurface=hr-mission-control",
        launcherName: "Open My Work",
        screenshotStem: "representative-my-work",
        standaloneHeading: "Assigned work",
      },
      testInfo,
    );
  } finally {
    await closeActors(manager);
  }
});

test("Mission Control reuses the real Leave widget and persists four independent appearance values", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  let eligibilityChanged = false;
  let workforceEligibilityChanged = false;
  try {
    await employee.page.goto(employee.origin);
    await expect(
      employee.page.getByRole("heading", { name: "Your work, one surface" }),
    ).toBeVisible();
    await expect(employee.page.getByRole("navigation", { name: "On this surface" })).toHaveCount(0);
    await expect(employee.page.getByRole("combobox", { name: "On this surface" })).toHaveCount(0);
    await employee.page.setViewportSize({ height: 1_440, width: 2_560 });
    const surfaceGeometry = await employee.page
      .locator(".mission-control-surface")
      .evaluate((surface) => {
        const frame = surface.closest(".surface-frame");
        if (!(frame instanceof HTMLElement)) throw new Error("Surface frame is unavailable");
        const frameStyle = getComputedStyle(frame);
        return {
          bodyBackgroundImage: getComputedStyle(document.body).backgroundImage,
          documentOverflow: getComputedStyle(document.documentElement).overflow,
          frameBorderWidth: frameStyle.borderTopWidth,
          frameRadius: frameStyle.borderRadius,
          frameShadow: frameStyle.boxShadow,
          scrollOwners: document.querySelectorAll(".surface-scroll").length,
          surfaceWidth: surface.getBoundingClientRect().width,
        };
      });
    expect(surfaceGeometry.scrollOwners).toBe(1);
    expect(surfaceGeometry.documentOverflow).toBe("hidden");
    expect(surfaceGeometry.frameBorderWidth).toBe("0px");
    expect(surfaceGeometry.frameRadius).toBe("0px");
    expect(surfaceGeometry.frameShadow).toBe("none");
    expect(surfaceGeometry.bodyBackgroundImage).toContain("radial-gradient");
    expect(surfaceGeometry.bodyBackgroundImage).not.toContain("linear-gradient");
    expect(Math.abs(surfaceGeometry.surfaceWidth - 1_920)).toBeLessThanOrEqual(1);

    const userControl = employee.page.getByRole("button", {
      exact: true,
      name: "User and system",
    });
    const settingsControl = employee.page.getByRole("link", {
      exact: true,
      name: "Universal Settings",
    });
    const appearanceControl = employee.page.getByRole("button", {
      exact: true,
      name: "Appearance settings",
    });
    const editControl = employee.page.getByRole("link", {
      exact: true,
      name: "Edit Mission Control personal layout",
    });
    const notificationControl = employee.page.getByRole("button", {
      name: /^Notifications(?:, \d+ unread)?$/,
    });
    for (const control of [
      userControl,
      settingsControl,
      appearanceControl,
      editControl,
      notificationControl,
    ]) {
      await expect(control).toBeVisible();
    }
    const controlXs = await Promise.all(
      [userControl, settingsControl, appearanceControl, editControl, notificationControl].map(
        async (control) => (await control.boundingBox())?.x,
      ),
    );
    expect(controlXs.every((value) => value !== undefined)).toBe(true);
    expect(controlXs[0]).toBeGreaterThan(controlXs[1]);
    expect(controlXs[1]).toBeGreaterThan(controlXs[2]);
    expect(controlXs[2]).toBeGreaterThan(controlXs[3]);
    expect(controlXs[3]).toBeGreaterThan(controlXs[4]);
    expect(
      await employee.page.evaluate(() =>
        [...document.querySelectorAll(".theme-control > .chrome-button")].map((element) =>
          element.getAttribute("aria-label"),
        ),
      ),
    ).toEqual([
      "User and system",
      "Universal Settings",
      "Appearance settings",
      "Edit Mission Control personal layout",
      expect.stringMatching(/^Notifications(?:, \d+ unread)?$/),
    ]);
    await userControl.focus();
    await employee.page.keyboard.press("Tab");
    await expect(settingsControl).toBeFocused();
    await employee.page.keyboard.press("Tab");
    await expect(appearanceControl).toBeFocused();
    await employee.page.keyboard.press("Tab");
    await expect(editControl).toBeFocused();
    await employee.page.keyboard.press("Tab");
    await expect(notificationControl).toBeFocused();
    await expect(employee.page.getByText("Team", { exact: true })).toHaveCount(0);
    await expect(employee.page.getByRole("button", { exact: true, name: "Search" })).toHaveCount(0);
    await expect(
      employee.page.getByRole("button", { exact: true, name: "System Status" }),
    ).toHaveCount(0);
    const universalWidget = employee.page.locator(
      '[data-surface-instance="mission-control.my-leave"]:not([data-widget-state="loading"])',
    );
    await expect(universalWidget).toHaveAttribute("data-widget-definition", "hr.leave.my-requests");
    await expect(
      universalWidget.getByRole("link", { name: "View all My leave requests" }),
    ).toHaveAttribute(
      "href",
      "/workspace/hr/leave?originFocusId=mission-control.my-leave.full-screen&returnSurface=mission-control",
    );
    await expect(employee.page.locator('.zen-widget[data-widget-state="loading"]')).toHaveCount(0);

    const overlayResponse = await employee.page.evaluate(async () => {
      const placements = [...document.querySelectorAll("main .zen-widget")].map((element) => {
        if (!(element instanceof HTMLElement)) throw new Error("Invalid widget element");
        const value = (name) => Number(element.style.getPropertyValue(name));
        return {
          column: value("--widget-desktop-column"),
          columnSpan: value("--widget-desktop-column-span"),
          instanceId: element.dataset.surfaceInstance,
          row: value("--widget-desktop-row"),
          rowSpan: value("--widget-desktop-row-span"),
          widgetDefinitionId: element.dataset.widgetDefinition,
          widgetDefinitionVersion: Number(element.dataset.widgetDefinitionVersion),
        };
      });
      const response = await fetch("/presentation/surfaces/surface.mission-control", {
        body: JSON.stringify({
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          placements: placements.map((placement) =>
            placement.instanceId === "mission-control.my-leave"
              ? { ...placement, column: 2, row: 11 }
              : placement,
          ),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    });
    expect(overlayResponse.status, overlayResponse.body).toBe(200);
    await employee.page.reload();
    await expect(universalWidget).toHaveCSS("--widget-column", "2");
    await expect(universalWidget).toHaveCSS("--widget-row", "11");

    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await expect(
      employee.page.getByRole("link", {
        exact: true,
        name: "Edit HR Mission Control personal layout",
      }),
    ).toBeVisible();
    await expect(employee.page.getByRole("navigation", { name: "On this surface" })).toHaveCount(0);
    await expect(employee.page.getByRole("combobox", { name: "On this surface" })).toHaveCount(0);
    await expect(
      employee.page.locator(
        '[data-surface-instance="hr-mission-control.my-leave"]:not([data-widget-state="loading"])',
      ),
    ).toHaveAttribute("data-widget-definition", "hr.leave.my-requests");
    const contextualLauncher = employee.page.getByRole("button", {
      exact: true,
      name: "HR pages",
    });
    await expect(contextualLauncher).toBeVisible();
    await contextualLauncher.click();
    const contextualNavigation = employee.page.getByRole("navigation", {
      exact: true,
      name: "HR pages",
    });
    await expect(
      contextualNavigation.getByRole("link", { exact: true, name: "HR Mission Control" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      contextualNavigation.getByRole("link", { exact: true, name: "HR Mission Control" }),
    ).toBeFocused();
    await expect(
      contextualNavigation.getByRole("link", { exact: true, name: "Leave Requests" }),
    ).toHaveAttribute("href", "/workspace/hr/leave");
    await employee.page.keyboard.press("Escape");
    await expect(contextualLauncher).toBeFocused();

    await enableDarkHighContrast(employee);
    const completeAppearance = await openAppearance(employee);
    const compactResponse = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/preferences",
    );
    await completeAppearance.getByRole("button", { name: "Compact" }).click();
    expect((await compactResponse).status()).toBe(200);
    await expect(employee.page.locator("html")).toHaveAttribute("data-density", "compact");
    const motionResponse = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/preferences",
    );
    await completeAppearance.getByRole("button", { name: "Reduce motion" }).click();
    expect((await motionResponse).status()).toBe(200);
    await expect(employee.page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    await employee.page.reload();
    await expect(employee.page.locator("html")).toHaveAttribute("data-density", "compact");
    await expect(employee.page.locator("html")).toHaveAttribute("data-palette", "dark");
    await expect(employee.page.locator("html")).toHaveAttribute("data-high-contrast", "true");
    await expect(employee.page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    await expect(employee.page.locator("html")).toHaveAttribute(
      "data-preference-status",
      "authoritative",
    );
    const preferenceCacheScope = await employee.page
      .locator("html")
      .getAttribute("data-preference-cache-scope");
    expect(preferenceCacheScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await employee.page.evaluate(() =>
        JSON.parse(localStorage.getItem("esbla.presentation.cache.v1") ?? "null"),
      ),
    ).toMatchObject({
      density: "compact",
      highContrast: true,
      palette: "dark",
      reducedMotion: "reduce",
      scope: preferenceCacheScope,
    });

    const serverDocumentBeforeRestart = await (await fetch(employee.origin)).text();
    expect(serverDocumentBeforeRestart).toContain('data-density="compact"');
    expect(serverDocumentBeforeRestart).toContain('data-high-contrast="true"');
    expect(serverDocumentBeforeRestart).toContain('data-palette="dark"');
    expect(serverDocumentBeforeRestart).toContain('data-reduced-motion="reduce"');
    expect(serverDocumentBeforeRestart).toContain('data-preference-status="authoritative"');
    const ssrContext = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    const ssrPage = await ssrContext.newPage();
    try {
      await ssrPage.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== employee.origin) {
          await route.abort("blockedbyclient");
        } else await route.continue();
      });
      await ssrPage.goto(employee.origin);
      await expect(ssrPage.locator("html")).toHaveAttribute("data-density", "compact");
      await expect(ssrPage.locator("html")).toHaveAttribute("data-palette", "dark");
      await expect(ssrPage.locator("html")).toHaveAttribute("data-high-contrast", "true");
      await expect(ssrPage.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
      await expect(ssrPage.locator("html")).toHaveAttribute(
        "data-preference-status",
        "authoritative",
      );
      expect(
        await ssrPage.locator("html").evaluate((element) => getComputedStyle(element).colorScheme),
      ).toBe("dark");
      const ssrEvidencePath = testInfo.outputPath(
        "mission-control-ssr-dark-high-contrast-no-js.png",
      );
      await ssrPage.screenshot({ fullPage: false, path: ssrEvidencePath });
      await testInfo.attach("mission-control-ssr-dark-high-contrast-no-js", {
        contentType: "image/png",
        path: ssrEvidencePath,
      });
    } finally {
      await ssrContext.close();
    }
    const storageFailureActor = await openActor(
      browser,
      fixture.employeeOrigin,
      "Browser Employee storage-failure session",
    );
    try {
      await storageFailureActor.context.addInitScript(() => {
        Storage.prototype.getItem = () => {
          throw new DOMException("Storage unavailable", "SecurityError");
        };
        Storage.prototype.setItem = () => {
          throw new DOMException("Storage unavailable", "SecurityError");
        };
      });
      await storageFailureActor.page.goto(storageFailureActor.origin);
      await expect(storageFailureActor.page.locator("html")).toHaveAttribute(
        "data-density",
        "compact",
      );
      await expect(storageFailureActor.page.locator("html")).toHaveAttribute(
        "data-palette",
        "dark",
      );
      await expect(storageFailureActor.page.locator("html")).toHaveAttribute(
        "data-high-contrast",
        "true",
      );
      await expect(storageFailureActor.page.locator("html")).toHaveAttribute(
        "data-reduced-motion",
        "reduce",
      );
      expect(
        await storageFailureActor.page
          .locator("html")
          .evaluate((element) => getComputedStyle(element).colorScheme),
      ).toBe("dark");
      const storageFailureAppearance = await openAppearance(storageFailureActor);
      const lightResponsePromise = storageFailureActor.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/presentation/preferences",
      );
      await storageFailureAppearance.getByRole("button", { name: "Light" }).click();
      expect((await lightResponsePromise).status()).toBe(200);
      await expect(storageFailureActor.page.locator("html")).toHaveAttribute(
        "data-palette",
        "light",
      );
      await expect(storageFailureAppearance.locator(".panel-error")).toHaveCount(0);
      const darkResponsePromise = storageFailureActor.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/presentation/preferences",
      );
      await storageFailureAppearance.getByRole("button", { name: "Dark" }).click();
      expect((await darkResponsePromise).status()).toBe(200);
      await expect(storageFailureActor.page.locator("html")).toHaveAttribute(
        "data-palette",
        "dark",
      );
      await expect(storageFailureAppearance.locator(".panel-error")).toHaveCount(0);
    } finally {
      await closeActors(storageFailureActor);
    }

    await restartEmployeeApplication();
    await employee.page.goto(employee.origin);
    await expect(employee.page.locator("html")).toHaveAttribute("data-density", "compact");
    await expect(employee.page.locator("html")).toHaveAttribute("data-palette", "dark");
    await expect(employee.page.locator("html")).toHaveAttribute("data-high-contrast", "true");
    await expect(employee.page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    await expect(employee.page.locator("html")).toHaveAttribute(
      "data-preference-status",
      "authoritative",
    );
    await expect(universalWidget).toHaveCSS("--widget-column", "2");
    await expect(universalWidget).toHaveCSS("--widget-row", "11");

    for (const [width, columns] of [
      [1_100, 12],
      [1_099, 8],
      [768, 8],
      [767, 4],
    ]) {
      await employee.page.setViewportSize({ height: 844, width });
      await expect
        .poll(
          async () =>
            await employee.page.locator(".widget-grid").evaluate((element) => {
              const tracks = getComputedStyle(element).gridTemplateColumns.trim();
              return tracks ? tracks.split(/\s+/).length : 0;
            }),
        )
        .toBe(columns);
      const expectedPlacement =
        width >= 1_100
          ? { column: "2", columnSpan: "span 4", row: "11", rowSpan: "span 3" }
          : { column: "1", columnSpan: "span 4", row: "1", rowSpan: "span 3" };
      await expect
        .poll(async () =>
          universalWidget.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              column: style.gridColumnStart,
              columnSpan: style.gridColumnEnd,
              row: style.gridRowStart,
              rowSpan: style.gridRowEnd,
            };
          }),
        )
        .toEqual(expectedPlacement);
    }

    const shellChrome = employee.page.locator(".zen-shell-chrome");
    await employee.page.setViewportSize({ height: 844, width: 1_100 });
    const directAppearanceLauncher = employee.page.getByRole("button", {
      exact: true,
      name: "Appearance settings",
    });
    await expect(directAppearanceLauncher).toBeVisible();
    await directAppearanceLauncher.click();
    const appearancePanel = employee.page.getByRole("region", { name: "Appearance settings" });
    await expect(appearancePanel).toBeVisible();
    await employee.page.setViewportSize({ height: 844, width: 1_099 });
    await employee.page.evaluate(() => {
      document.documentElement.style.setProperty("--corner-button", "260px");
      document.documentElement.style.setProperty("--corner-gap", "20px");
    });
    await expect(shellChrome).toHaveAttribute(
      "data-collapsed-controls",
      "notifications appearance settings edit-surface",
    );
    await expect(directAppearanceLauncher).toBeHidden();
    await expect(appearancePanel).toBeVisible();
    await appearancePanel.getByRole("button", { name: "Close appearance settings" }).click();
    await expect(
      employee.page.getByRole("button", { exact: true, name: "User and system" }),
    ).toBeFocused();
    await employee.page.evaluate(() => {
      document.documentElement.style.removeProperty("--corner-button");
      document.documentElement.style.removeProperty("--corner-gap");
    });

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await expect(universalWidget).toBeVisible();
    await expect
      .poll(async () => {
        const [phoneWidgetBox, phoneGridBox] = await Promise.all([
          universalWidget.boundingBox(),
          employee.page.locator(".widget-grid").boundingBox(),
        ]);
        if (!phoneWidgetBox || !phoneGridBox) return Number.POSITIVE_INFINITY;
        return Math.abs(phoneWidgetBox.width - phoneGridBox.width);
      })
      .toBeLessThanOrEqual(1);
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const systemLauncher = employee.page.getByRole("button", {
      exact: true,
      name: "User and system",
    });
    const serviceGroupsLauncher = employee.page.getByRole("button", {
      exact: true,
      name: "Service Groups",
    });
    const eligibleServiceGroups = employee.page.getByRole("navigation", {
      name: "Eligible service groups",
    });
    await expect(systemLauncher).toBeVisible();
    await serviceGroupsLauncher.click();
    await expect(eligibleServiceGroups).toBeVisible();
    await systemLauncher.click();
    const systemPanel = employee.page.getByRole("region", { name: "User and system" });
    await expect(eligibleServiceGroups).toBeHidden();
    await expect(systemPanel).toBeVisible();
    await expect(systemPanel.getByRole("heading", { name: "User and system" })).toBeFocused();
    await employee.page.keyboard.press("Escape");
    await expect(systemLauncher).toBeFocused();

    const serviceGroupsLauncherBox = await serviceGroupsLauncher.boundingBox();
    expect(serviceGroupsLauncherBox?.width).toBe(serviceGroupsLauncherBox?.height);
    await serviceGroupsLauncher.focus();
    await expect
      .poll(async () =>
        serviceGroupsLauncher.evaluate((element) => {
          const tooltip = getComputedStyle(element, "::after");
          return {
            content: tooltip.content.replace(/^["']|["']$/g, ""),
            visibility: tooltip.visibility,
          };
        }),
      )
      .toEqual({ content: "Service Groups", visibility: "visible" });
    await serviceGroupsLauncher.click();
    const hrServiceGroupLink = employee.page
      .getByRole("navigation", { name: "Eligible service groups" })
      .getByRole("link", { exact: true, name: "HR" });
    await expect(hrServiceGroupLink).toBeVisible();
    await expect(hrServiceGroupLink).toBeFocused();
    await employee.page.keyboard.press("Escape");
    await expect(serviceGroupsLauncher).toBeFocused();
    await expect(
      employee.page.getByRole("button", { exact: true, name: "Appearance settings" }),
    ).toBeHidden();
    await systemLauncher.click();
    await expect(systemPanel).toBeVisible();
    const systemPanelEvidencePath = testInfo.outputPath("mission-control-phone-system-panel.png");
    await employee.page.screenshot({ fullPage: false, path: systemPanelEvidencePath });
    await testInfo.attach("mission-control-phone-system-panel", {
      contentType: "image/png",
      path: systemPanelEvidencePath,
    });
    await systemPanel.getByRole("button", { exact: true, name: "Appearance" }).click();
    await expect(employee.page.getByRole("region", { name: "Appearance settings" })).toBeVisible();
    await employee.page.getByRole("button", { name: "Close appearance settings" }).click();
    await expect(systemLauncher).toBeFocused();

    await serviceGroupsLauncher.click();
    await expect(eligibleServiceGroups).toBeVisible();
    await expect(hrServiceGroupLink).toBeFocused();
    await employee.page.evaluate(() => {
      document.documentElement.style.setProperty("--corner-button", "120px");
      document.documentElement.style.setProperty("--corner-gap", "14px");
      document.documentElement.style.setProperty("--chrome-cluster-gap", "28px");
      document.documentElement.style.setProperty("--edge", "20px");
    });
    await expect(shellChrome).toHaveAttribute(
      "data-collapsed-controls",
      "notifications appearance settings edit-surface service-groups",
    );
    await expect(serviceGroupsLauncher).toHaveCount(0);
    const collapsedServiceGroups = employee.page.getByRole("region", {
      exact: true,
      name: "Service Groups",
    });
    await expect(
      collapsedServiceGroups
        .getByRole("navigation", { name: "Eligible service groups" })
        .getByRole("link", { exact: true, name: "HR" }),
    ).toBeFocused();
    await employee.page.keyboard.press("Escape");
    await expect(systemPanel).toBeVisible();
    await employee.page.keyboard.press("Escape");
    await expect(systemLauncher).toBeFocused();
    await employee.page.evaluate(() => {
      document.documentElement.style.removeProperty("--corner-button");
      document.documentElement.style.removeProperty("--corner-gap");
      document.documentElement.style.removeProperty("--chrome-cluster-gap");
      document.documentElement.style.removeProperty("--edge");
    });
    await expect(shellChrome).toHaveAttribute(
      "data-collapsed-controls",
      "notifications appearance settings edit-surface",
    );
    await expect(serviceGroupsLauncher).toBeVisible();

    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await expect(employee.page.getByRole("heading", { name: "People and work" })).toBeVisible();
    const [phoneContextualBox, phoneServiceGroupsBox] = await Promise.all([
      contextualLauncher.boundingBox(),
      serviceGroupsLauncher.boundingBox(),
    ]);
    expect(phoneContextualBox).not.toBeNull();
    expect(phoneServiceGroupsBox).not.toBeNull();
    expect(phoneContextualBox.x).toBeLessThan(phoneServiceGroupsBox.x);
    await contextualLauncher.click();
    await expect(contextualNavigation).toBeVisible();
    await systemLauncher.click();
    await expect(contextualNavigation).toBeHidden();
    await expect(systemPanel).toBeVisible();
    await employee.page.keyboard.press("Escape");
    await expect(systemLauncher).toBeFocused();
    await contextualLauncher.click();
    await contextualNavigation.getByRole("link", { exact: true, name: "Leave Requests" }).click();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr/leave`);
    await expect(employee.page.getByRole("heading", { name: "My Leave Requests" })).toBeFocused();
    await expect(
      employee.page.getByRole("link", {
        exact: true,
        name: "Edit HR Mission Control personal layout",
      }),
    ).toHaveCount(0);
    await systemLauncher.click();
    await expect(systemPanel).toBeVisible();
    await employee.page.goBack();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr`);
    await expect(systemPanel).toBeHidden();
    await expect(employee.page.getByRole("heading", { name: "People and work" })).toBeFocused();
    await systemLauncher.click();
    await systemPanel.getByRole("button", { exact: true, name: "Appearance" }).click();
    await expect(employee.page.getByRole("region", { name: "Appearance settings" })).toBeVisible();
    await employee.page.goForward();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr/leave`);
    await expect(employee.page.getByRole("region", { name: "Appearance settings" })).toBeHidden();
    await expect(employee.page.getByRole("heading", { name: "My Leave Requests" })).toBeFocused();
    await employee.page.goBack();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr`);
    await systemLauncher.click();
    await expect(systemPanel).toBeVisible();
    await employee.page.evaluate(() => {
      const heading = document.querySelector("main h1");
      if (!heading) throw new Error("Route heading is unavailable");
      window.history.pushState(null, "", "/workspace/hr/focus-settlement-probe");
    });
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr/focus-settlement-probe`);
    await expect(employee.page.getByRole("region", { name: "User and system" })).toBeHidden();
    await employee.page.evaluate(() => {
      const heading = document.querySelector("main h1");
      if (!heading) throw new Error("Route heading is unavailable");
      const loading = document.createElement("h1");
      loading.textContent = "Loading People and work";
      heading.replaceWith(loading);
    });
    await expect(
      employee.page.getByRole("heading", { name: "Loading People and work" }),
    ).toBeFocused();
    await employee.page.evaluate(() => {
      const loading = document.querySelector("main h1");
      if (!loading) throw new Error("Loading route heading is unavailable");
      const settled = document.createElement("h1");
      settled.textContent = "People and work";
      loading.replaceWith(settled);
    });
    await expect(employee.page.getByRole("heading", { name: "People and work" })).toBeFocused();
    await employee.page.goto(employee.origin);
    await expect(
      employee.page.getByRole("heading", { name: "Your work, one surface" }),
    ).toBeVisible();

    const phoneEvidencePath = testInfo.outputPath("mission-control-phone.png");
    await employee.page.screenshot({ fullPage: false, path: phoneEvidencePath });
    await testInfo.attach("mission-control-phone", {
      contentType: "image/png",
      path: phoneEvidencePath,
    });

    eligibilityChanged = true;
    await setEmployeeLeavePresentationEligibility(true, ["hr.leave.list_own"]);
    await employee.page.reload();
    await expect(
      employee.page.locator('[data-widget-definition="hr.leave.my-requests"]'),
    ).toHaveCount(0);
    await expect(serviceGroupsLauncher).toBeVisible();
    await serviceGroupsLauncher.click();
    await employee.page
      .getByRole("navigation", { name: "Eligible service groups" })
      .getByRole("link", { exact: true, name: "HR" })
      .click();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr`);
    await expect(employee.page.getByRole("heading", { name: "People and work" })).toBeFocused();
    await expect(
      employee.page.getByRole("link", { name: "View all My leave requests" }),
    ).toHaveCount(0);
    await expect(employee.page.getByRole("link", { name: "Open My Profile" })).toBeVisible();
    await employee.page.goto(employee.origin);
    const deniedCapabilityMutation = await employee.page.evaluate(async () => {
      const response = await fetch("/presentation/surfaces/surface.mission-control", {
        body: JSON.stringify({
          expectedVersion: 1,
          idempotencyKey: crypto.randomUUID(),
          placements: [
            {
              column: 2,
              columnSpan: 4,
              instanceId: "mission-control.my-leave",
              row: 5,
              rowSpan: 3,
              widgetDefinitionId: "hr.leave.my-requests",
              widgetDefinitionVersion: 1,
            },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    });
    expect(deniedCapabilityMutation.status).toBe(403);
    expect(deniedCapabilityMutation.body).not.toContain("hr.leave.my-requests");
    expect(employee.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
    employee.diagnostics.console.length = 0;

    await setEmployeeLeavePresentationEligibility(false, ["hr.leave.list_own", "hr.leave.view"]);
    await employee.page.reload();
    await expect(
      employee.page.locator('[data-widget-definition="hr.leave.my-requests"]'),
    ).toHaveCount(0);
    await expect(serviceGroupsLauncher).toBeVisible();

    await setEmployeeWorkforcePresentationEligibility(false);
    workforceEligibilityChanged = true;
    await employee.page.reload();
    await expect(serviceGroupsLauncher).toHaveCount(0);

    await setEmployeeLeavePresentationEligibility(true, ["hr.leave.submit"]);
    await employee.page.reload();
    await expect(serviceGroupsLauncher).toHaveCount(0);
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await expect(employee.page.getByRole("link", { name: "Open My Profile" })).toHaveCount(0);
    await expect(
      employee.page.getByRole("link", { name: "View all My leave requests" }),
    ).toHaveCount(0);

    await setEmployeeLeavePresentationEligibility(false, ["hr.leave.list_own", "hr.leave.view"]);
    await setEmployeeWorkforcePresentationEligibility(true);
    workforceEligibilityChanged = false;
    await employee.page.reload();
    await expect(serviceGroupsLauncher).toBeVisible();

    await setEmployeeLeavePresentationEligibility(true, ["hr.leave.list_own", "hr.leave.view"]);
    eligibilityChanged = false;
    await employee.page.reload();
    await expect(
      employee.page.locator('[data-widget-definition="hr.leave.my-requests"]'),
    ).toHaveCount(1);
  } finally {
    if (workforceEligibilityChanged) {
      await setEmployeeWorkforcePresentationEligibility(true).catch(() => undefined);
    }
    if (eligibilityChanged) {
      await setEmployeeLeavePresentationEligibility(true, [
        "hr.leave.list_own",
        "hr.leave.view",
      ]).catch(() => undefined);
    }
    await closeActors(employee);
  }
});

test("personal Surface Editor saves pointer and keyboard layout changes and fails closed", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  let leaveActivationChanged = false;
  let personalizationDisabled = false;
  let staleEditor;
  let writeCapabilityRemoved = false;
  try {
    await employee.page.setViewportSize({ height: 900, width: 1_280 });
    await employee.page.goto(employee.origin);
    const editLauncher = employee.page.getByRole("link", {
      exact: true,
      name: "Edit Mission Control personal layout",
    });
    await expect(editLauncher).toBeVisible();
    await editLauncher.press("Enter");
    await expect(employee.page).toHaveURL(
      `${employee.origin}/studio/surfaces/surface.mission-control/personal`,
    );
    await expect(
      employee.page.getByRole("heading", { name: "Shape your Mission Control" }),
    ).toBeFocused();

    const reset = employee.page.getByRole("button", { name: "Restore tenant layout" });
    if (await reset.isEnabled()) {
      employee.page.once("dialog", (dialog) => dialog.accept());
      const resetResponse = employee.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/presentation/surfaces/surface.mission-control/reset",
      );
      await reset.click();
      expect((await resetResponse).status()).toBe(200);
    }

    staleEditor = await openActor(browser, fixture.employeeOrigin, "stale personal editor");
    await staleEditor.page.goto(
      `${staleEditor.origin}/studio/surfaces/surface.mission-control/personal`,
    );
    await expect(
      staleEditor.page.getByRole("heading", { name: "Shape your Mission Control" }),
    ).toBeVisible();

    const profileWidget = employee.page.getByRole("button", {
      name: /My Profile, 4 columns by 3 rows/,
    });
    const profileFrame = employee.page.locator(".surface-editor-widget").filter({
      has: employee.page.getByRole("button", { name: /^My Profile, / }),
    });
    const leaveFrame = employee.page
      .getByRole("button", { name: /My Leave Requests, / })
      .locator("..");
    await expect(profileWidget).toBeVisible();
    await expect(leaveFrame).toBeVisible();
    await profileWidget.scrollIntoViewIfNeeded();
    const initialReducedMotion = await employee.page
      .locator("html")
      .getAttribute("data-reduced-motion");
    expect(initialReducedMotion).toMatch(/^(auto|reduce)$/);
    const motionAppearance = await openAppearance(employee);
    if (initialReducedMotion === "reduce") {
      const automaticMotionResponse = employee.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/presentation/preferences",
      );
      await motionAppearance.getByRole("button", { name: "Reduce motion" }).click();
      expect((await automaticMotionResponse).status()).toBe(200);
    }
    await expect(employee.page.locator("html")).toHaveAttribute("data-reduced-motion", "auto");
    await motionAppearance.getByRole("button", { name: "Close appearance settings" }).click();
    await employee.page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(profileFrame).toHaveCSS("transition-duration", /0\.12s/);
    await employee.page.emulateMedia({ reducedMotion: "reduce" });
    await expect(profileFrame).toHaveCSS("transition-duration", /0\.001s/);
    await employee.page.emulateMedia({ reducedMotion: "no-preference" });
    if (initialReducedMotion === "reduce") {
      const restoreMotionAppearance = await openAppearance(employee);
      const reducedMotionResponse = employee.page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/presentation/preferences",
      );
      await restoreMotionAppearance.getByRole("button", { name: "Reduce motion" }).click();
      expect((await reducedMotionResponse).status()).toBe(200);
      await expect(employee.page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
      await restoreMotionAppearance
        .getByRole("button", { name: "Close appearance settings" })
        .click();
    }
    const profileMove = employee.page.getByRole("button", {
      exact: true,
      name: "Move My Profile",
    });
    const profileMoveBox = await profileMove.boundingBox();
    const leaveFrameBox = await leaveFrame.boundingBox();
    const profileFrameBox = await profileFrame.boundingBox();
    if (!profileMoveBox || !leaveFrameBox || !profileFrameBox) {
      throw new Error("Surface Editor collision targets have no pointer geometry");
    }
    await employee.page.mouse.move(
      profileMoveBox.x + profileMoveBox.width / 2,
      profileMoveBox.y + profileMoveBox.height / 2,
    );
    await employee.page.mouse.down();
    await employee.page.mouse.move(
      profileMoveBox.x + profileMoveBox.width / 2 + leaveFrameBox.x - profileFrameBox.x,
      profileMoveBox.y + profileMoveBox.height / 2 + leaveFrameBox.y - profileFrameBox.y,
    );
    await expect(profileFrame).toHaveAttribute("data-interaction-valid", "false");
    await expect(employee.page.getByText(/That position is occupied\./)).toBeVisible();
    await employee.page.keyboard.press("Escape");
    await employee.page.mouse.up();
    await expect(profileFrame).toHaveCSS("grid-row-start", "7");
    await expect(
      employee.page.getByText("Cancelled moving My Profile. It remains at column 5, row 7."),
    ).toBeVisible();

    await employee.page.mouse.move(
      profileMoveBox.x + profileMoveBox.width / 2,
      profileMoveBox.y + profileMoveBox.height / 2,
    );
    await employee.page.mouse.down();
    await employee.page.mouse.move(
      profileMoveBox.x + profileMoveBox.width / 2,
      profileMoveBox.y + profileMoveBox.height / 2 + 56,
    );
    await expect(profileFrame).toHaveAttribute("data-interaction-active", "true");
    await expect(profileFrame).toHaveAttribute("data-interaction-valid", "true");
    await expect(profileFrame).toHaveCSS("opacity", "0.75");
    await expect(employee.page.locator(".surface-editor-widget-placeholder")).toHaveCount(1);
    await expect(
      employee.page.getByText("My Profile move target column 5, row 8 is available."),
    ).toBeVisible();
    await employee.page.mouse.up();
    await expect(profileFrame).toHaveCSS("grid-row-start", "8");
    await expect(employee.page.getByText("Dropped My Profile at column 5, row 8.")).toBeVisible();
    await profileMove.focus();
    await expect(profileMove).toBeFocused();
    await profileMove.press("Enter");
    await expect(profileMove).toHaveAttribute("aria-pressed", "true");
    await expect(employee.page.getByText("Picked up My Profile to move.")).toBeVisible();
    await profileMove.press("ArrowDown");
    await expect(profileFrame).toHaveCSS("grid-row-start", "9");
    await expect(
      employee.page.getByText("My Profile move target column 5, row 9 is available."),
    ).toBeVisible();
    await profileMove.press("Escape");
    await expect(profileMove).toHaveAttribute("aria-pressed", "false");
    await expect(profileFrame).toHaveCSS("grid-row-start", "8");
    await expect(
      employee.page.getByText("Cancelled moving My Profile. It remains at column 5, row 8."),
    ).toBeVisible();
    const resizeHandle = employee.page.getByRole("button", {
      exact: true,
      name: "Resize My Profile",
    });
    const resizeBox = await resizeHandle.boundingBox();
    if (!resizeBox) throw new Error("Surface Editor profile widget has no pointer resize target");
    await employee.page.mouse.move(
      resizeBox.x + resizeBox.width / 2,
      resizeBox.y + resizeBox.height / 2,
    );
    await employee.page.mouse.down();
    await employee.page.mouse.move(
      resizeBox.x + resizeBox.width / 2,
      resizeBox.y + resizeBox.height / 2 + 56,
    );
    await expect(profileFrame).toHaveAttribute("data-interaction-valid", "true");
    await expect(
      employee.page.getByText("My Profile resize target 4 columns by 4 rows is available."),
    ).toBeVisible();
    await employee.page.mouse.up();
    const resizedProfile = employee.page.getByRole("button", {
      name: /My Profile, 4 columns by 4 rows/,
    });
    await expect(resizedProfile).toBeVisible();
    await expect(
      employee.page.getByText("Dropped My Profile at 4 columns by 4 rows."),
    ).toBeVisible();
    await resizeHandle.focus();
    await expect(resizeHandle).toBeFocused();
    await resizeHandle.press("Enter");
    await expect(resizeHandle).toHaveAttribute("aria-pressed", "true");
    await resizeHandle.press("ArrowUp");
    await expect(
      employee.page.getByText("My Profile resize target 4 columns by 3 rows is available."),
    ).toBeVisible();
    await resizeHandle.press("Escape");
    await expect(resizeHandle).toHaveAttribute("aria-pressed", "false");
    await expect(resizedProfile).toBeVisible();
    const profileRow = employee.page.getByRole("spinbutton", { name: "My Profile row" });
    await profileRow.fill("9");
    await expect(resizedProfile.locator("..")).toHaveCSS("grid-row-start", "9");
    await expect(employee.page.getByText("My Profile moved to column 5, row 9.")).toBeVisible();
    await resizedProfile.press("ArrowDown");
    await expect(resizedProfile.locator("..")).toHaveCSS("grid-row-start", "10");
    await resizedProfile.press("ArrowUp");
    await expect(resizedProfile.locator("..")).toHaveCSS("grid-row-start", "9");
    await expect(employee.page.getByText("Unsaved changes", { exact: true })).toBeVisible();

    const save = employee.page.getByRole("button", { name: "Save personal layout" });
    const saveResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await save.click();
    expect((await saveResponse).status()).toBe(200);
    await expect(employee.page.getByText("Saved", { exact: true })).toBeVisible();
    await employee.page.reload();
    await expect(
      employee.page.getByRole("button", { name: /My Profile, 4 columns by 4 rows/ }).locator(".."),
    ).toHaveCSS("grid-row-start", "9");
    const desktopEvidencePath = testInfo.outputPath("surface-editor-personal-desktop.png");
    await employee.page.screenshot({ fullPage: false, path: desktopEvidencePath });
    await testInfo.attach("surface-editor-personal-desktop", {
      contentType: "image/png",
      path: desktopEvidencePath,
    });

    const staleProfile = staleEditor.page.getByRole("button", { name: /My Profile, / });
    await staleProfile.click();
    await staleEditor.page.getByRole("button", { name: "Remove from surface" }).click();
    const staleResponse = staleEditor.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await staleEditor.page.getByRole("button", { name: "Save personal layout" }).click();
    expect((await staleResponse).status()).toBe(409);
    await expect(
      staleEditor.page.getByText(
        "This layout changed in another tab. Reload before editing again.",
      ),
    ).toBeVisible();
    expect(staleEditor.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 409 (Conflict)",
    ]);
    staleEditor.diagnostics.console.length = 0;
    await staleEditor.page.getByRole("button", { name: "Reload" }).click();
    await expect(
      staleEditor.page
        .getByRole("button", { name: /My Profile, 4 columns by 4 rows/ })
        .locator(".."),
    ).toHaveCSS("grid-row-start", "9");
    await closeActors(staleEditor);
    staleEditor = undefined;

    await employee.page.getByRole("button", { name: /My Profile, 4 columns by 4 rows/ }).click();
    await employee.page.getByRole("button", { name: "Remove from surface" }).click();
    const undoRemoved = employee.page.getByRole("button", { name: "Undo removed widget" });
    await expect(undoRemoved).toBeVisible();
    await undoRemoved.click();
    await expect(
      employee.page.getByRole("button", { name: /My Profile, / }).locator(".."),
    ).toHaveCSS("grid-row-start", "9");
    await expect(employee.page.getByText("Restored My Profile to this draft.")).toBeVisible();
    await employee.page.getByRole("button", { name: /My Profile, / }).click();
    await employee.page.getByRole("button", { name: "Remove from surface" }).click();
    const removeResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await save.click();
    expect((await removeResponse).status()).toBe(200);
    await employee.page.reload();
    await expect(employee.page.getByRole("button", { name: /My Profile, / })).toHaveCount(0);
    const addProfile = employee.page.getByRole("button", { name: "Add My Profile" });
    await expect(addProfile).toBeVisible();
    await addProfile.click();
    const addResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await save.click();
    expect((await addResponse).status()).toBe(200);
    await employee.page.reload();
    await expect(employee.page.getByRole("button", { name: /My Profile, / })).toHaveCount(1);

    await employee.page.getByRole("button", { name: "Tablet preview" }).click();
    await expect(employee.page.locator(".surface-editor-viewport")).toHaveAttribute(
      "data-preview-mode",
      "tablet",
    );
    await employee.page.getByRole("button", { name: "Phone preview" }).click();
    await expect(employee.page.locator(".surface-editor-viewport")).toHaveAttribute(
      "data-preview-mode",
      "phone",
    );
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    await employee.page.setViewportSize({ height: 720, width: 390 });
    await expect(
      employee.page.getByText(
        "Editing controls are available on tablet and desktop. Phone preview remains read-only.",
      ),
    ).toBeVisible();
    await expect(save).toBeHidden();
    const phoneEvidencePath = testInfo.outputPath("surface-editor-personal-phone.png");
    await employee.page.screenshot({ fullPage: false, path: phoneEvidencePath });
    await testInfo.attach("surface-editor-personal-phone", {
      contentType: "image/png",
      path: phoneEvidencePath,
    });

    await employee.page.setViewportSize({ height: 900, width: 1_280 });
    await employee.page.getByRole("link", { name: "Return to Mission Control" }).press("Enter");
    await expect(employee.page).toHaveURL(employee.origin);
    await expect(
      employee.page.getByRole("heading", { name: "Your work, one surface" }),
    ).toBeFocused();
    await editLauncher.press("Enter");
    await expect(
      employee.page.getByRole("heading", { name: "Shape your Mission Control" }),
    ).toBeVisible();

    const currentProfileBeforeDeactivation = employee.page.getByRole("button", {
      name: /My Profile, /,
    });
    await currentProfileBeforeDeactivation.click();
    await employee.page.getByRole("button", { name: "Remove from surface" }).click();
    await setEmployeeLeavePresentationEligibility(false, ["hr.leave.list_own", "hr.leave.view"]);
    leaveActivationChanged = true;
    const deactivatedResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await save.click();
    expect((await deactivatedResponse).status()).toBe(403);
    await expect(
      employee.page.getByText("Your access or this service’s availability is no longer current."),
    ).toBeVisible();
    await expect(employee.page.getByText("Personal editing is locked")).toBeVisible();
    expect(employee.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
    employee.diagnostics.console.length = 0;
    await setEmployeeLeavePresentationEligibility(true, ["hr.leave.list_own", "hr.leave.view"]);
    leaveActivationChanged = false;
    await employee.page.reload();
    await expect(employee.page.getByRole("button", { name: /My Profile, / })).toHaveCount(1);
    await expect(employee.page.getByRole("button", { name: /My Leave Requests, / })).toHaveCount(1);

    const profileBeforeTenantLock = employee.page.getByRole("button", { name: /My Profile, / });
    await profileBeforeTenantLock.click();
    await employee.page.getByRole("button", { name: "Remove from surface" }).click();
    await setMissionControlPersonalization(false);
    personalizationDisabled = true;
    const tenantLockedResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await save.click();
    expect((await tenantLockedResponse).status()).toBe(403);
    await expect(
      employee.page.getByText("Your access or this service’s availability is no longer current."),
    ).toBeVisible();
    await employee.page.reload();
    await expect(employee.page.getByText("Personal editing is locked")).toBeVisible();
    await expect(employee.page.getByRole("button", { name: /My Profile, / })).toHaveCount(1);
    await expect(save).toBeDisabled();
    expect(employee.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
    employee.diagnostics.console.length = 0;
    await setMissionControlPersonalization(true);
    personalizationDisabled = false;
    await employee.page.reload();
    await expect(employee.page.getByText("Personal editing is locked")).toHaveCount(0);
    await expect(employee.page.getByRole("button", { name: /My Profile, / })).toBeEnabled();

    writeCapabilityRemoved = true;
    await setEmployeePresentationLayoutWrite(false);
    const currentProfile = employee.page.getByRole("button", { name: /My Profile, / });
    await currentProfile.click();
    await employee.page.getByRole("button", { name: "Remove from surface" }).click();
    await expect(employee.page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    const deniedResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await save.click();
    expect((await deniedResponse).status()).toBe(403);
    await expect(
      employee.page.getByText("Your access or this service’s availability is no longer current."),
    ).toBeVisible();
    await expect(employee.page.getByText("Personal editing is locked")).toBeVisible();
    expect(employee.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
    employee.diagnostics.console.length = 0;
  } finally {
    if (staleEditor) {
      await closeActors(staleEditor).catch(() => undefined);
    }
    if (leaveActivationChanged) {
      await setEmployeeLeavePresentationEligibility(true, [
        "hr.leave.list_own",
        "hr.leave.view",
      ]).catch(() => undefined);
    }
    if (personalizationDisabled) {
      await setMissionControlPersonalization(true).catch(() => undefined);
    }
    if (writeCapabilityRemoved) {
      await setEmployeePresentationLayoutWrite(true).catch(() => undefined);
    }
    await employee.page.setViewportSize({ height: 900, width: 1_280 }).catch(() => undefined);
    await employee.page.reload().catch(() => undefined);
    const reset = employee.page.getByRole("button", { name: "Restore tenant layout" });
    if (await reset.isEnabled().catch(() => false)) {
      employee.page.once("dialog", (dialog) => dialog.accept());
      await reset.click().catch(() => undefined);
    }
    await closeActors(employee);
  }
});

test("eligible catalogue faces add through Surface Editor and render from real service reads", async ({
  browser,
}, testInfo) => {
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const actors = [operator, manager];
  try {
    await operator.page.setViewportSize({ height: 900, width: 1_280 });
    await operator.page.goto(`${operator.origin}/studio/surfaces/surface.mission-control/personal`);
    for (const displayName of [
      "Employment Administration Queue",
      "Employment History",
      "Workforce Administration Queue",
      "Workforce Status Reporting",
    ]) {
      const add = operator.page.getByRole("button", { name: `Add ${displayName}` });
      await expect(add).toBeVisible();
      await add.click();
    }
    const operatorSaveResponse = operator.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await operator.page.getByRole("button", { name: "Save personal layout" }).click();
    expect((await operatorSaveResponse).status()).toBe(200);
    await operator.page.goto(operator.origin);
    for (const widgetDefinition of [
      "hr.employment.admin-queue",
      "hr.employment.history",
      "hr.workforce.admin-queue",
      "hr.workforce.status-reporting",
    ]) {
      await expect(
        operator.page.locator(`[data-widget-definition="${widgetDefinition}"]`),
      ).toHaveCount(1);
    }
    const operatorEvidencePath = testInfo.outputPath("catalogue-hr-operator-widgets.png");
    await operator.page.screenshot({ fullPage: false, path: operatorEvidencePath });
    await testInfo.attach("catalogue-hr-operator-widgets", {
      contentType: "image/png",
      path: operatorEvidencePath,
    });

    await manager.page.setViewportSize({ height: 900, width: 1_280 });
    await manager.page.goto(`${manager.origin}/studio/surfaces/surface.mission-control/personal`);
    const addTasks = manager.page.getByRole("button", { name: "Add My Tasks" });
    await expect(addTasks).toBeVisible();
    await addTasks.click();
    const managerSaveResponse = manager.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await manager.page.getByRole("button", { name: "Save personal layout" }).click();
    expect((await managerSaveResponse).status()).toBe(200);
    await manager.page.goto(manager.origin);
    await expect(
      manager.page.locator('[data-widget-definition="workspace.tasks.mine"]'),
    ).toHaveCount(1);

    for (const actor of actors) {
      expect(actor.diagnostics.external).toEqual([]);
      expect(actor.diagnostics.page).toEqual([]);
      expect(actor.diagnostics.server).toEqual([]);
      expect(actor.diagnostics.console).toEqual([]);
    }
  } finally {
    for (const actor of actors) {
      await actor.page
        .goto(`${actor.origin}/studio/surfaces/surface.mission-control/personal`)
        .catch(() => undefined);
      const reset = actor.page.getByRole("button", { name: "Restore tenant layout" });
      if (await reset.isEnabled().catch(() => false)) {
        actor.page.once("dialog", (dialog) => dialog.accept());
        const resetResponse = actor.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            "/presentation/surfaces/surface.mission-control/reset",
        );
        await reset.click();
        expect((await resetResponse).status()).toBe(200);
      }
    }
    await closeActors(...actors);
  }
});

test("Timesheet and Expense catalogue faces add through Surface Editor and render from current service authority", async ({
  browser,
}, testInfo) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  const actors = [admin, manager, employee, operator];
  let expenseReactivated = false;
  const runExpenseServiceAction = async (buttonName) => {
    const button = admin.page.getByRole("button", { exact: true, name: buttonName });
    const [response] = await Promise.all([
      admin.page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).pathname === "/workspace/hr/expenses/action",
      ),
      admin.page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      button.click(),
    ]);
    expect(response.status()).toBe(303);
  };
  const addAndSave = async (actor, displayNames) => {
    await actor.page.setViewportSize({ height: 900, width: 1_280 });
    await actor.page.goto(`${actor.origin}/studio/surfaces/surface.mission-control/personal`);
    for (const displayName of displayNames) {
      const add = actor.page.getByRole("button", { name: `Add ${displayName}` });
      await expect(add).toBeVisible();
      await add.click();
    }
    const saveResponse = actor.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await actor.page.getByRole("button", { name: "Save personal layout" }).click();
    expect((await saveResponse).status()).toBe(200);
    await actor.page.goto(actor.origin);
  };
  try {
    await admin.page.goto(`${admin.origin}/workspace/hr/expenses/settings`);
    const activateExpense = admin.page.getByRole("button", {
      exact: true,
      name: "Activate Expense Claim",
    });
    if (await activateExpense.isVisible()) {
      await runExpenseServiceAction("Activate Expense Claim");
      expenseReactivated = true;
      await expect(admin.page.locator(".leave-status")).toHaveText("Active");
    }

    await addAndSave(manager, ["Assigned Timesheets", "Assigned Expense Claims"]);
    for (const definitionId of ["hr.timesheet.assigned", "hr.expense.assigned"]) {
      const widget = manager.page.locator(`[data-widget-definition="${definitionId}"]`);
      await expect(widget).toHaveCount(1);
      await expect(widget).toHaveAttribute("data-widget-state", /^(empty|populated)$/);
      await expect(widget.getByRole("link", { name: /^Open / })).toHaveAttribute(
        "href",
        /\/workspace\/my-work\?/,
      );
    }

    await addAndSave(employee, [
      "Timesheet Draft",
      "Expense Claim Draft",
      "Expense Claim Corrections",
    ]);
    for (const definitionId of [
      "hr.timesheet.draft",
      "hr.expense.draft",
      "hr.expense.corrections",
    ]) {
      const widget = employee.page.locator(`[data-widget-definition="${definitionId}"]`);
      await expect(widget).toHaveCount(1);
      await expect(widget).toHaveAttribute("data-widget-state", /^(empty|populated)$/);
    }

    await addAndSave(operator, ["Timesheet Corrections"]);
    const corrections = operator.page.locator(
      '[data-widget-definition="hr.timesheet.corrections"]',
    );
    await expect(corrections).toHaveCount(1);
    await expect(corrections).toHaveAttribute("data-widget-state", "populated");
    await expect(
      corrections.getByRole("link", { exact: true, name: "Open Timesheet corrections" }),
    ).toHaveAttribute("href", "/workspace/hr/timesheets/admin/corrections");

    for (const [actor, name] of [
      [manager, "catalogue-timesheet-expense-manager.png"],
      [employee, "catalogue-timesheet-expense-employee.png"],
      [operator, "catalogue-timesheet-expense-operator.png"],
    ]) {
      const evidencePath = testInfo.outputPath(name);
      await actor.page.screenshot({ fullPage: false, path: evidencePath });
      await testInfo.attach(name.replace(/\.png$/, ""), {
        contentType: "image/png",
        path: evidencePath,
      });
      expect(actor.diagnostics.external).toEqual([]);
      expect(actor.diagnostics.page).toEqual([]);
      expect(actor.diagnostics.server).toEqual([]);
      expect(actor.diagnostics.console).toEqual([]);
    }
  } finally {
    for (const actor of [manager, employee, operator]) {
      await actor.page
        .goto(`${actor.origin}/studio/surfaces/surface.mission-control/personal`)
        .catch(() => undefined);
      const reset = actor.page.getByRole("button", { name: "Restore tenant layout" });
      if (await reset.isEnabled().catch(() => false)) {
        actor.page.once("dialog", (dialog) => dialog.accept());
        const resetResponse = actor.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            "/presentation/surfaces/surface.mission-control/reset",
        );
        await reset.click();
        expect((await resetResponse).status()).toBe(200);
      }
    }
    if (expenseReactivated) {
      await admin.page.goto(`${admin.origin}/workspace/hr/expenses/settings`);
      await runExpenseServiceAction("Deactivate Expense Claim");
      await expect(admin.page.locator(".leave-status")).toHaveText("Inactive");
    }
    await closeActors(...actors);
  }
});

test("tenant appearance floors render locked while stale browser tabs fail closed", async ({
  browser,
}, testInfo) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const staleEmployee = await openActor(
    browser,
    fixture.employeeOrigin,
    "Browser Employee stale appearance tab",
  );
  let tenantDefaultsCreated = false;
  try {
    await admin.page.goto(admin.origin);
    const tenantUpdate = await admin.page.evaluate(async () => {
      const response = await fetch("/presentation/tenant-defaults", {
        body: JSON.stringify({
          density: "comfortable",
          expectedVersion: 0,
          highContrast: true,
          idempotencyKey: crypto.randomUUID(),
          lockDensity: true,
          palette: "light",
          reducedMotion: "reduce",
          requireHighContrast: true,
          requireReducedMotion: true,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    });
    expect(tenantUpdate.status, tenantUpdate.body).toBe(200);
    tenantDefaultsCreated = true;

    await Promise.all([
      employee.page.goto(employee.origin),
      staleEmployee.page.goto(employee.origin),
    ]);
    for (const actor of [employee, staleEmployee]) {
      await expect(actor.page.locator("html")).toHaveAttribute("data-density", "comfortable");
      await expect(actor.page.locator("html")).toHaveAttribute("data-density-locked", "true");
      await expect(actor.page.locator("html")).toHaveAttribute("data-high-contrast", "true");
      await expect(actor.page.locator("html")).toHaveAttribute("data-high-contrast-locked", "true");
      await expect(actor.page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
      await expect(actor.page.locator("html")).toHaveAttribute(
        "data-reduced-motion-locked",
        "true",
      );
    }
    const employeePanel = await openAppearance(employee);
    await expect(employeePanel.getByRole("button", { name: "Comfortable" })).toBeDisabled();
    await expect(employeePanel.getByRole("button", { name: /High contrast/ })).toBeDisabled();
    await expect(employeePanel.getByRole("button", { name: /Reduce motion/ })).toBeDisabled();
    await expect(employeePanel.getByRole("button", { name: "Light" })).toBeEnabled();

    const stalePanel = await openAppearance(staleEmployee);
    const employeePalette =
      (await employee.page.locator("html").getAttribute("data-palette")) === "dark"
        ? "Light"
        : "Dark";
    const employeeSave = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/preferences",
    );
    await employeePanel.getByRole("button", { name: employeePalette }).click();
    expect((await employeeSave).status()).toBe(200);
    const staleSave = staleEmployee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/preferences",
    );
    await stalePanel.getByRole("button", { name: employeePalette }).click();
    expect((await staleSave).status()).toBe(409);
    await expect(stalePanel.getByRole("alert")).toContainText("Appearance could not be saved");
    await expect
      .poll(() => staleEmployee.diagnostics.console)
      .toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
    staleEmployee.diagnostics.console.length = 0;
    await staleEmployee.page.reload();
    await expect(staleEmployee.page.locator("html")).toHaveAttribute(
      "data-palette",
      employeePalette.toLowerCase(),
    );

    await employee.page.setViewportSize({ height: 844, width: 390 });
    const lockedEvidencePath = testInfo.outputPath("appearance-tenant-floors-mobile.png");
    await employee.page.screenshot({ fullPage: false, path: lockedEvidencePath });
    await testInfo.attach("appearance-tenant-floors-mobile", {
      contentType: "image/png",
      path: lockedEvidencePath,
    });
  } finally {
    if (tenantDefaultsCreated) {
      await admin.page.goto(admin.origin);
      const reset = await admin.page.evaluate(async () => {
        const response = await fetch("/presentation/tenant-defaults/reset", {
          body: JSON.stringify({
            expectedVersion: 1,
            idempotencyKey: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return { body: await response.text(), status: response.status };
      });
      expect(reset.status, reset.body).toBe(200);
    }
    await closeActors(admin, employee, staleEmployee);
  }
});

test("Zen chrome remains inside the visual viewport without Product placeholders", async ({
  browser,
}, testInfo) => {
  const actor = await openActor(
    browser,
    fixture.employeeOrigin,
    `${fixture.employeeLabel} bounded viewport`,
    { viewport: { height: 844, width: 390 } },
    installBoundedVisualViewport,
  );
  try {
    await actor.page.goto(`${actor.origin}/workspace/hr`);
    await expect(actor.page.locator(".esbla-shell")).toHaveAttribute("data-current-surface", "HR");
    await expect(actor.page.getByLabel("Development identity status")).toHaveCount(0);
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-block-start", "60px");
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-block-end", "264px");
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-inline-start", "25px");
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-inline-end", "25px");

    const visualBounds = { bottom: 580, left: 25, right: 365, top: 60 };
    for (const locator of [
      actor.page.getByRole("link", { exact: true, name: "Mission Control" }),
      actor.page.getByRole("button", { exact: true, name: "User and system" }),
      actor.page.locator(".surface-frame"),
      actor.page.locator(".zen-shortcut-universal"),
      actor.page.locator(".zen-shortcut-contextual"),
    ]) {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(visualBounds.left);
      expect(box.y).toBeGreaterThanOrEqual(visualBounds.top);
      expect(box.x + box.width).toBeLessThanOrEqual(visualBounds.right);
      expect(box.y + box.height).toBeLessThanOrEqual(visualBounds.bottom);
    }

    const universalLauncher = actor.page.getByRole("button", {
      exact: true,
      name: "Universal shortcuts",
    });
    await universalLauncher.click();
    const panel = actor.page.getByRole("dialog", {
      exact: true,
      name: "Universal shortcuts",
    });
    await expect(panel).toBeVisible();
    await universalLauncher.hover();
    await expect
      .poll(async () =>
        universalLauncher.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element, "::after").opacity),
        ),
      )
      .toBe(1);
    const tooltipBox = await universalLauncher.evaluate((element) => {
      const launcher = element.getBoundingClientRect();
      const tooltip = getComputedStyle(element, "::after");
      const pixels = (value) => Number.parseFloat(value) || 0;
      const left = Number.parseFloat(tooltip.left);
      const top = Number.parseFloat(tooltip.top);
      const contentHeight = Number.parseFloat(tooltip.height);
      const contentWidth = Number.parseFloat(tooltip.width);
      const borderBoxHeight =
        contentHeight +
        (tooltip.boxSizing === "border-box"
          ? 0
          : pixels(tooltip.paddingTop) +
            pixels(tooltip.paddingBottom) +
            pixels(tooltip.borderTopWidth) +
            pixels(tooltip.borderBottomWidth));
      const borderBoxWidth =
        contentWidth +
        (tooltip.boxSizing === "border-box"
          ? 0
          : pixels(tooltip.paddingLeft) +
            pixels(tooltip.paddingRight) +
            pixels(tooltip.borderLeftWidth) +
            pixels(tooltip.borderRightWidth));
      const borderBoxLeft = launcher.x + element.clientLeft + left;
      const borderBoxTop = launcher.y + element.clientTop + top;
      return {
        bottom: borderBoxTop + borderBoxHeight,
        left: borderBoxLeft,
        right: borderBoxLeft + borderBoxWidth,
        top: borderBoxTop,
        visibility: tooltip.visibility,
      };
    });
    expect(tooltipBox.visibility).toBe("visible");
    expect(tooltipBox.left).toBeGreaterThanOrEqual(visualBounds.left);
    expect(tooltipBox.top).toBeGreaterThanOrEqual(visualBounds.top);
    expect(tooltipBox.right).toBeLessThanOrEqual(visualBounds.right);
    expect(tooltipBox.bottom).toBeLessThanOrEqual(visualBounds.bottom);
    await panel.getByRole("heading", { name: "Universal shortcuts" }).hover();
    await expect
      .poll(async () =>
        universalLauncher.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element, "::after").opacity),
        ),
      )
      .toBe(0);
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox.x).toBeGreaterThanOrEqual(visualBounds.left);
    expect(panelBox.y).toBeGreaterThanOrEqual(visualBounds.top);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(visualBounds.right);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(visualBounds.bottom);

    await actor.page.evaluate(() => {
      window.__setEsblaVisualViewport({
        height: 600,
        offsetLeft: 0,
        offsetTop: 20,
        width: 390,
      });
    });
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-block-start", "20px");
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-block-end", "224px");
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-inline-start", "0px");
    await expect(actor.page.locator("html")).toHaveCSS("--zen-visual-inline-end", "0px");

    const evidencePath = testInfo.outputPath("zen-visual-viewport-chrome.png");
    await actor.page.screenshot({ fullPage: false, path: evidencePath });
    await testInfo.attach("zen-visual-viewport-chrome", {
      contentType: "image/png",
      path: evidencePath,
    });
  } finally {
    await closeActors(actor);
  }
});

test("Mission Control surface shortcuts persist and fail closed at activation", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  let eligibilityChanged = false;
  let shortcutAdded = false;
  try {
    await employee.page.setViewportSize({ height: 900, width: 1_440 });
    await employee.page.goto(employee.origin);
    const launcher = employee.page.getByRole("button", {
      exact: true,
      name: "Mission Control surface shortcuts",
    });
    await expect(launcher).toBeVisible();
    await launcher.click();
    let panel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Mission Control surface shortcuts",
    });
    await expect(
      panel.getByRole("heading", { name: "Mission Control surface shortcuts" }),
    ).toBeFocused();
    await expect(panel.getByText("Current surface", { exact: true })).toBeVisible();
    await expect(panel.getByText("Current service", { exact: true })).toHaveCount(0);
    await panel.getByRole("button", { exact: true, name: "Add shortcut" }).click();
    await expect(
      panel.getByRole("button", {
        exact: true,
        name: "Add Mission Control to Mission Control surface shortcuts",
      }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", {
        exact: true,
        name: "Add HR Mission Control to Mission Control surface shortcuts",
      }),
    ).toBeVisible();
    const appendResponse = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/shortcuts",
    );
    await panel
      .getByRole("button", {
        exact: true,
        name: "Add Leave Requests to Mission Control surface shortcuts",
      })
      .click();
    expect((await appendResponse).status()).toBe(200);
    shortcutAdded = true;
    await panel.getByRole("button", { name: "Close mission control surface shortcuts" }).click();
    const surfaceLeaveShortcut = employee.page
      .locator(".zen-shortcut-contextual")
      .getByRole("link", { exact: true, name: "Leave Requests" });
    await expect(surfaceLeaveShortcut).toBeVisible();

    await employee.page.reload();
    await expect(surfaceLeaveShortcut).toBeVisible();
    await employee.page.goto("about:blank");
    await restartEmployeeApplication();
    await employee.page.goto(employee.origin);
    await expect(surfaceLeaveShortcut).toBeVisible();

    const desktopEvidencePath = testInfo.outputPath("mission-control-surface-shortcut-desktop.png");
    await employee.page.screenshot({ fullPage: false, path: desktopEvidencePath });
    await testInfo.attach("mission-control-surface-shortcut-desktop", {
      contentType: "image/png",
      path: desktopEvidencePath,
    });

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await expect(surfaceLeaveShortcut).toHaveCount(0);
    await launcher.click();
    panel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Mission Control surface shortcuts",
    });
    await expect(panel.getByRole("link", { exact: true, name: "Leave Requests" })).toBeVisible();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const phoneEvidencePath = testInfo.outputPath("mission-control-surface-shortcut-phone.png");
    await employee.page.screenshot({ fullPage: false, path: phoneEvidencePath });
    await testInfo.attach("mission-control-surface-shortcut-phone", {
      contentType: "image/png",
      path: phoneEvidencePath,
    });
    await employee.page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(launcher).toBeFocused();

    await employee.page.setViewportSize({ height: 900, width: 1_440 });
    eligibilityChanged = true;
    await setEmployeeLeavePresentationEligibility(false, ["hr.leave.list_own", "hr.leave.view"]);
    await surfaceLeaveShortcut.click();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr/leave`);
    await expect(employee.page.getByText("Current and historical whole-day requests.")).toHaveCount(
      0,
    );
    await expect.poll(() => employee.diagnostics.page.length).toBe(1);
    expect(employee.diagnostics.page).toEqual([
      expect.stringContaining(
        "The specific message is omitted in production builds to avoid leaking sensitive details.",
      ),
    ]);
    employee.diagnostics.page.length = 0;

    await setEmployeeLeavePresentationEligibility(true, ["hr.leave.list_own", "hr.leave.view"]);
    eligibilityChanged = false;
    await employee.page.goto(employee.origin);
    await launcher.click();
    panel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Mission Control surface shortcuts",
    });
    const removalResponse = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/shortcuts",
    );
    await panel
      .getByRole("button", {
        name: "Remove Leave Requests from Mission Control surface shortcuts",
      })
      .click();
    expect((await removalResponse).status()).toBe(200);
    shortcutAdded = false;
  } finally {
    if (eligibilityChanged) {
      await setEmployeeLeavePresentationEligibility(true, [
        "hr.leave.list_own",
        "hr.leave.view",
      ]).catch(() => undefined);
    }
    if (shortcutAdded) {
      await employee.page.goto(employee.origin).catch(() => undefined);
      const launcher = employee.page.getByRole("button", {
        exact: true,
        name: "Mission Control surface shortcuts",
      });
      if (await launcher.isVisible().catch(() => false)) {
        await launcher.click().catch(() => undefined);
        await employee.page
          .getByRole("dialog", { exact: true, name: "Mission Control surface shortcuts" })
          .getByRole("button", {
            name: "Remove Leave Requests from Mission Control surface shortcuts",
          })
          .click()
          .catch(() => undefined);
      }
    }
    await closeActors(employee);
  }
});

test("registered universal and HR shortcuts persist, arbitrate, and fail closed", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  let touchEmployee;
  let eligibilityChanged = false;
  try {
    await employee.page.setViewportSize({ height: 844, width: 1_200 });
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    const universalLauncher = employee.page.getByRole("button", {
      exact: true,
      name: "Universal shortcuts",
    });
    const contextualLauncher = employee.page.getByRole("button", {
      exact: true,
      name: "HR shortcuts",
    });
    await expect(universalLauncher).toBeVisible();
    await expect(contextualLauncher).toBeVisible();

    await universalLauncher.click();
    let universalPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Universal shortcuts",
    });
    await expect(
      universalPanel.getByRole("heading", { name: "Universal shortcuts" }),
    ).toBeFocused();
    await universalPanel.getByRole("button", { exact: true, name: "Add shortcut" }).click();
    const universalMutation = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/shortcuts",
    );
    await universalPanel
      .getByRole("button", {
        exact: true,
        name: "Add Leave Requests to Universal shortcuts",
      })
      .click();
    expect((await universalMutation).status()).toBe(200);
    await expect(
      universalPanel.getByRole("link", { exact: true, name: "Leave Requests" }),
    ).toBeVisible();
    await universalPanel.getByRole("button", { name: "Close universal shortcuts" }).click();
    const universalLeaveShortcut = employee.page
      .locator(".zen-shortcut-universal")
      .getByRole("link", { exact: true, name: "Leave Requests" });
    await expect(universalLeaveShortcut).toBeVisible();

    await contextualLauncher.click();
    let contextualPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "HR shortcuts",
    });
    await contextualPanel.getByRole("button", { exact: true, name: "Add shortcut" }).click();
    const contextualMutation = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/shortcuts",
    );
    await contextualPanel
      .getByRole("button", {
        exact: true,
        name: "Add Leave Requests to HR shortcuts",
      })
      .click();
    expect((await contextualMutation).status()).toBe(200);
    await contextualPanel.getByRole("button", { name: "Close hr shortcuts" }).click();
    const contextualLeaveShortcut = employee.page
      .locator(".zen-shortcut-contextual")
      .getByRole("link", { exact: true, name: "Leave Requests" });
    await expect(contextualLeaveShortcut).toBeVisible();

    await employee.page.reload();
    await expect(universalLeaveShortcut).toBeVisible();
    await expect(contextualLeaveShortcut).toBeVisible();
    await employee.page.goto("about:blank");
    await restartEmployeeApplication();
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await expect(universalLeaveShortcut).toBeVisible();
    await expect(contextualLeaveShortcut).toBeVisible();

    await universalLauncher.focus();
    await employee.page.keyboard.press("Enter");
    universalPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Universal shortcuts",
    });
    await expect(universalPanel).toBeVisible();
    await employee.page.keyboard.press("Escape");
    await expect(universalPanel).toBeHidden();
    await expect(universalLauncher).toBeFocused();
    await contextualLauncher.focus();
    await employee.page.keyboard.press("Space");
    contextualPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "HR shortcuts",
    });
    await expect(contextualPanel).toBeVisible();
    await employee.page.keyboard.press("Escape");
    await expect(contextualPanel).toBeHidden();
    await expect(contextualLauncher).toBeFocused();

    touchEmployee = await openActor(
      browser,
      fixture.employeeOrigin,
      `${fixture.employeeLabel} touch`,
      {
        hasTouch: true,
        viewport: { height: 1_024, width: 900 },
      },
    );
    await touchEmployee.page.goto(`${touchEmployee.origin}/workspace/hr`);
    const touchUniversalLauncher = touchEmployee.page.getByRole("button", {
      exact: true,
      name: "Universal shortcuts",
    });
    const touchContextualLauncher = touchEmployee.page.getByRole("button", {
      exact: true,
      name: "HR shortcuts",
    });
    await expect(
      touchEmployee.page
        .locator(".zen-shortcut-universal")
        .getByRole("link", { exact: true, name: "Leave Requests" }),
    ).toHaveCount(0);
    await touchUniversalLauncher.tap();
    const touchUniversalPanel = touchEmployee.page.getByRole("dialog", {
      exact: true,
      name: "Universal shortcuts",
    });
    await expect(touchUniversalPanel).toBeVisible();
    await expect
      .poll(async () =>
        touchUniversalPanel.locator(".zen-shortcut-picker-grid").evaluate((element) => {
          const tracks = getComputedStyle(element).gridTemplateColumns.trim();
          return tracks ? tracks.split(/\s+/).length : 0;
        }),
      )
      .toBe(6);
    await touchContextualLauncher.tap();
    await expect(touchUniversalPanel).toBeHidden();
    await expect(
      touchEmployee.page.getByRole("dialog", {
        exact: true,
        name: "HR shortcuts",
      }),
    ).toBeVisible();

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await expect(universalLeaveShortcut).toHaveCount(0);
    await expect(contextualLeaveShortcut).toHaveCount(0);
    await universalLauncher.click();
    universalPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Universal shortcuts",
    });
    await expect(universalPanel).toBeVisible();
    await contextualLauncher.click();
    contextualPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "HR shortcuts",
    });
    await expect(universalPanel).toBeHidden();
    await expect(contextualPanel).toBeVisible();
    await expect
      .poll(async () =>
        contextualPanel.locator(".zen-shortcut-picker-grid").evaluate((element) => {
          const tracks = getComputedStyle(element).gridTemplateColumns.trim();
          return tracks ? tracks.split(/\s+/).length : 0;
        }),
      )
      .toBe(4);
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const shortcutEvidencePath = testInfo.outputPath("hr-shortcuts-phone.png");
    await employee.page.screenshot({ fullPage: false, path: shortcutEvidencePath });
    await testInfo.attach("hr-shortcuts-phone", {
      contentType: "image/png",
      path: shortcutEvidencePath,
    });

    eligibilityChanged = true;
    await setEmployeeLeavePresentationEligibility(false, ["hr.leave.list_own", "hr.leave.view"]);
    await employee.page.reload();
    await universalLauncher.click();
    universalPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Universal shortcuts",
    });
    await expect(universalPanel).toContainText("1 unavailable shortcut is hidden.");
    await contextualLauncher.click();
    contextualPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "HR shortcuts",
    });
    await expect(contextualPanel).toContainText("1 unavailable shortcut is hidden.");

    await setEmployeeLeavePresentationEligibility(true, ["hr.leave.list_own", "hr.leave.view"]);
    eligibilityChanged = false;
    await employee.page.reload();
    await universalLauncher.click();
    universalPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "Universal shortcuts",
    });
    const universalRemoval = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/shortcuts",
    );
    await universalPanel
      .getByRole("button", {
        name: "Remove Leave Requests from Universal shortcuts",
      })
      .click();
    expect((await universalRemoval).status()).toBe(200);
    await universalPanel.getByRole("button", { name: "Close universal shortcuts" }).click();
    await contextualLauncher.click();
    contextualPanel = employee.page.getByRole("dialog", {
      exact: true,
      name: "HR shortcuts",
    });
    const contextualRemoval = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/shortcuts",
    );
    await contextualPanel
      .getByRole("button", {
        name: "Remove Leave Requests from HR shortcuts",
      })
      .click();
    expect((await contextualRemoval).status()).toBe(200);
  } finally {
    if (eligibilityChanged) {
      await setEmployeeLeavePresentationEligibility(true, [
        "hr.leave.list_own",
        "hr.leave.view",
      ]).catch(() => undefined);
    }
    await closeActors(employee, ...(touchEmployee ? [touchEmployee] : []));
  }
});

test("Tenant Base Surface Editor separates draft, validation, publish and rollback", async ({
  browser,
}, testInfo) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  let publishCapabilityRemoved = false;
  try {
    await admin.page.setViewportSize({ height: 900, width: 1_280 });
    await admin.page.goto(`${admin.origin}/settings`);
    const tenantBaseLink = admin.page.getByRole("link", {
      exact: true,
      name: "Edit Mission Control tenant base",
    });
    await expect(tenantBaseLink).toBeVisible();
    await tenantBaseLink.press("Enter");
    await expect(admin.page).toHaveURL(
      `${admin.origin}/studio/surfaces/surface.mission-control/tenant`,
    );
    await expect(
      admin.page.getByRole("heading", { name: "Publish the Mission Control base" }),
    ).toBeFocused();

    const profileWidget = admin.page.getByRole("button", {
      name: /My Profile, 4 columns by 3 rows/,
    });
    await expect(profileWidget).toBeVisible();
    await profileWidget.press("ArrowDown");
    await expect(profileWidget.locator("..")).toHaveCSS("grid-row-start", "8");
    await expect(admin.page.getByText("Unsaved draft changes", { exact: true })).toBeVisible();

    const draftResponse = admin.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/presentation/surfaces/surface.mission-control/tenant-base/draft",
    );
    await admin.page.getByRole("button", { name: "Save tenant-base draft" }).click();
    expect((await draftResponse).status()).toBe(200);
    await expect(tenantSurfaceFact(admin.page, "Draft")).toHaveText("v1 · candidate v2");
    await expect(tenantSurfaceFact(admin.page, "Published base")).toHaveText("v1");
    await expect(tenantSurfaceFact(admin.page, "Evidence")).not.toHaveText(
      "No mutation in this session",
    );
    await expect(tenantSurfaceFact(admin.page, "Evidence")).toHaveText(fixtureId);

    const validateResponse = admin.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/presentation/surfaces/surface.mission-control/tenant-base/validate",
    );
    await admin.page.getByRole("button", { name: "Validate draft" }).click();
    expect((await validateResponse).status()).toBe(200);
    await expect(
      admin.page.getByText("Draft v1 is valid. Validation did not publish it."),
    ).toBeVisible();

    await setStudioSurfaceBaseCapability("platform.studio.surface_base.publish", false);
    publishCapabilityRemoved = true;
    admin.page.once("dialog", (dialog) => dialog.accept());
    const deniedPublish = admin.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/presentation/surfaces/surface.mission-control/tenant-base/publish",
    );
    await admin.page.getByRole("button", { name: "Publish draft" }).click();
    expect((await deniedPublish).status()).toBe(403);
    await expect(
      admin.page.getByText(
        "Your access or this service’s availability is no longer current. Nothing was changed.",
      ),
    ).toBeVisible();
    await expect(tenantSurfaceFact(admin.page, "Draft")).toHaveText("v1 · candidate v2");
    await expect(tenantSurfaceFact(admin.page, "Published base")).toHaveText("v1");
    expect(admin.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
    admin.diagnostics.console.length = 0;

    await setStudioSurfaceBaseCapability("platform.studio.surface_base.publish", true);
    publishCapabilityRemoved = false;
    await admin.page.reload();
    await expect(tenantSurfaceFact(admin.page, "Draft")).toHaveText("v1 · candidate v2");
    admin.page.once("dialog", (dialog) => dialog.accept());
    const publishResponse = admin.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/presentation/surfaces/surface.mission-control/tenant-base/publish",
    );
    await admin.page.getByRole("button", { name: "Publish draft" }).click();
    expect((await publishResponse).status()).toBe(200);
    await expect(admin.page.getByText("Published tenant base v2.")).toBeVisible();
    await expect(tenantSurfaceFact(admin.page, "Draft")).toHaveText("None");
    await expect(admin.page.getByText("Base v2", { exact: true })).toBeVisible();
    await expect(admin.page.getByText("Base v1", { exact: true })).toBeVisible();

    admin.page.once("dialog", (dialog) => dialog.accept());
    const rollbackResponse = admin.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/presentation/surfaces/surface.mission-control/tenant-base/rollback",
    );
    await admin.page.getByRole("button", { name: "Publish new version from base v1" }).click();
    expect((await rollbackResponse).status()).toBe(200);
    await expect(
      admin.page.getByText("Published tenant base v3 from historical v1."),
    ).toBeVisible();
    await expect(admin.page.getByText("Base v3", { exact: true })).toBeVisible();
    await expect(admin.page.getByText("Base v2", { exact: true })).toBeVisible();
    await expect(admin.page.getByText("Base v1", { exact: true })).toBeVisible();
    await admin.page.reload();
    await expect(tenantSurfaceFact(admin.page, "Published base")).toHaveText("v3");
    await expect(
      admin.page.getByRole("button", { name: /My Profile, 4 columns by 3 rows/ }).locator(".."),
    ).toHaveCSS("grid-row-start", "7");

    const desktopPath = testInfo.outputPath("surface-editor-tenant-base-desktop.png");
    await admin.page.screenshot({ fullPage: false, path: desktopPath });
    await testInfo.attach("surface-editor-tenant-base-desktop", {
      contentType: "image/png",
      path: desktopPath,
    });

    await admin.page.setViewportSize({ height: 844, width: 390 });
    await expect(admin.page.getByText(/Tenant Base authoring is desktop-only in V1/)).toBeVisible();
    await expect(admin.page.getByRole("button", { name: "Save tenant-base draft" })).toBeHidden();
    expect(
      await admin.page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const phonePath = testInfo.outputPath("surface-editor-tenant-base-phone.png");
    await admin.page.screenshot({ fullPage: false, path: phonePath });
    await testInfo.attach("surface-editor-tenant-base-phone", {
      contentType: "image/png",
      path: phonePath,
    });

    await employee.page.goto(`${employee.origin}/settings`);
    await expect(
      employee.page.getByRole("link", {
        exact: true,
        name: "Edit Mission Control tenant base",
      }),
    ).toHaveCount(0);
    await employee.page.goto(`${employee.origin}/studio/surfaces/surface.mission-control/tenant`);
    await expect(
      employee.page.getByRole("heading", { name: "Tenant Base editor unavailable" }),
    ).toBeVisible();
    await expect(employee.page.getByText(/private policy detail/i)).toHaveCount(1);
  } finally {
    if (publishCapabilityRemoved) {
      await setStudioSurfaceBaseCapability("platform.studio.surface_base.publish", true).catch(
        () => undefined,
      );
    }
    await closeActors(admin, employee);
  }
});

test("Universal Settings preserves Theme, exposes authority, and coordinates tabs without overwriting drafts", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  let secondPage;
  try {
    await employee.page.setViewportSize({ height: 900, width: 1_280 });
    const speculativeSettingsRequest = employee.page
      .waitForRequest((request) => new URL(request.url()).pathname === "/settings", {
        timeout: 3_000,
      })
      .then(
        () => true,
        () => false,
      );
    await employee.page.goto(employee.origin);
    await expect(
      employee.page.getByRole("button", { exact: true, name: "Appearance settings" }),
    ).toBeVisible();
    const settingsLauncher = employee.page.getByRole("link", {
      exact: true,
      name: "Universal Settings",
    });
    await expect(settingsLauncher).toBeVisible();
    await expect(settingsLauncher).toHaveAttribute("href", "/settings");
    expect(
      await speculativeSettingsRequest,
      "actor-bound Universal Settings data is not speculatively prefetched",
    ).toBe(false);
    await settingsLauncher.press("Enter");
    await expect(employee.page).toHaveURL(`${employee.origin}/settings`);
    await expect(
      employee.page.getByRole("heading", { name: "Your Esbla, with its source visible" }),
    ).toBeFocused();

    for (const heading of [
      "Appearance & accessibility",
      "Navigation shortcuts",
      "Personal layouts",
    ]) {
      await expect(
        employee.page.getByRole("heading", { exact: true, name: heading }),
      ).toBeVisible();
    }
    for (const heading of [
      "Universal shortcuts",
      "Mission Control surface shortcuts",
      "HR service shortcuts",
    ]) {
      await expect(
        employee.page.getByRole("heading", { exact: true, name: heading }),
      ).toBeVisible();
    }
    await expect(
      employee.page.getByRole("heading", { name: "Tenant presentation defaults" }),
    ).toHaveCount(0);
    await expect(employee.page.getByText("Team", { exact: true })).toHaveCount(0);
    await expect(
      employee.page.getByText(/Product default|Tenant default|Your preference/).first(),
    ).toBeVisible();

    const missionLayout = employee.page.locator("article").filter({
      has: employee.page.getByRole("heading", { exact: true, name: "Mission Control" }),
    });
    const resetLayout = missionLayout.getByRole("button", { name: "Reset personal layout" });
    if (await resetLayout.isEnabled()) {
      const resetResponse = employee.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/presentation/surfaces/surface.mission-control/reset",
      );
      await resetLayout.click();
      expect((await resetResponse).status()).toBe(200);
    }

    await employee.page.goto(employee.origin);
    const overlay = await employee.page.evaluate(async () => {
      const placements = [...document.querySelectorAll("main .zen-widget")].map((element) => {
        if (!(element instanceof HTMLElement)) throw new Error("Invalid widget element");
        const value = (name) => Number(element.style.getPropertyValue(name));
        return {
          column: value("--widget-desktop-column"),
          columnSpan: value("--widget-desktop-column-span"),
          instanceId: element.dataset.surfaceInstance,
          row: value("--widget-desktop-row"),
          rowSpan: value("--widget-desktop-row-span"),
          widgetDefinitionId: element.dataset.widgetDefinition,
          widgetDefinitionVersion: Number(element.dataset.widgetDefinitionVersion),
        };
      });
      const response = await fetch("/presentation/surfaces/surface.mission-control", {
        body: JSON.stringify({
          expectedVersion: 0,
          idempotencyKey: crypto.randomUUID(),
          placements: placements.map((placement) =>
            placement.instanceId === "mission-control.my-leave"
              ? { ...placement, row: placement.row + 1 }
              : placement,
          ),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.text(), status: response.status };
    });
    expect(overlay.status, overlay.body).toBe(200);

    await employee.page.goto(`${employee.origin}/settings`);
    await expect(missionLayout).toContainText("Personal layout");
    await expect(resetLayout).toBeEnabled();
    const resetResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control/reset",
    );
    await resetLayout.click();
    expect((await resetResponse).status()).toBe(200);
    await expect(missionLayout).toContainText(/Product layout|Published tenant layout/);
    await expect(resetLayout).toBeDisabled();

    const universalShortcuts = employee.page.locator("article").filter({
      has: employee.page.getByRole("heading", { exact: true, name: "Universal shortcuts" }),
    });
    const addLeave = universalShortcuts.getByRole("button", {
      exact: true,
      name: "Add Leave Requests",
    });
    if ((await addLeave.count()) === 0) {
      const removeExisting = universalShortcuts
        .getByRole("button", { exact: true, name: "Remove" })
        .first();
      if (await removeExisting.isVisible()) await removeExisting.click();
      await expect(addLeave).toBeVisible();
    }
    const shortcutResponse = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/shortcuts",
    );
    await addLeave.click();
    expect((await shortcutResponse).status()).toBe(200);
    await expect(universalShortcuts).toContainText("Leave Requests");

    secondPage = await employee.context.newPage();
    secondPage.on("console", (message) => {
      if (message.type() === "error") employee.diagnostics.console.push(message.text());
    });
    secondPage.on("pageerror", (error) =>
      employee.diagnostics.page.push(`${error.name}: ${error.message}`),
    );
    secondPage.on("response", (response) => {
      if (response.status() >= 500) {
        employee.diagnostics.server.push(
          `${response.status()} ${new URL(response.url()).pathname}`,
        );
      }
    });
    await secondPage.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== employee.origin) {
        employee.diagnostics.external.push(new URL(route.request().url()).origin);
        await route.abort("blockedbyclient");
      } else await route.continue();
    });
    await secondPage.goto(`${employee.origin}/settings`);

    const palette = employee.page.getByLabel("Palette");
    const originalPalette = await palette.inputValue();
    const unsavedPalette = originalPalette === "dark" ? "light" : "dark";
    await palette.selectOption(unsavedPalette);
    const secondDensity = secondPage.getByLabel("Density");
    const savedDensity =
      (await secondDensity.inputValue()) === "compact" ? "comfortable" : "compact";
    await secondDensity.selectOption(savedDensity);
    const saveResponse = secondPage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/preferences",
    );
    await secondPage.getByRole("button", { name: "Save my appearance" }).click();
    expect((await saveResponse).status()).toBe(200);
    await expect(
      employee.page.getByText("Presentation settings changed in another tab."),
    ).toBeVisible();
    await expect(palette).toHaveValue(unsavedPalette);
    await employee.page.getByRole("button", { name: "Load latest" }).click();
    await expect(employee.page.getByLabel("Palette")).toHaveValue(originalPalette);
    await expect(employee.page.getByLabel("Density")).toHaveValue(savedDensity);

    await secondPage.close();
    secondPage = undefined;
    await employee.page.goto("about:blank");
    await restartEmployeeApplication();
    await employee.page.goto(`${employee.origin}/settings`);
    await expect(employee.page.getByLabel("Density")).toHaveValue(savedDensity);

    const highContrast = employee.page.getByLabel("High contrast");
    if (!(await highContrast.isChecked())) await highContrast.check();
    const highContrastResponse = employee.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/presentation/preferences",
    );
    await employee.page.getByRole("button", { name: "Save my appearance" }).click();
    expect((await highContrastResponse).status()).toBe(200);
    await expect(employee.page.locator("html")).toHaveAttribute("data-high-contrast", "true");

    await employee.page.setViewportSize({ height: 568, width: 320 });
    await expect(
      employee.page.getByRole("heading", { name: "Your Esbla, with its source visible" }),
    ).toBeVisible();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const reflowEvidencePath = testInfo.outputPath(
      "universal-settings-320-high-contrast-reflow.png",
    );
    await employee.page.screenshot({ fullPage: false, path: reflowEvidencePath });
    await testInfo.attach("universal-settings-320-high-contrast-reflow", {
      contentType: "image/png",
      path: reflowEvidencePath,
    });

    await employee.page.goto(employee.origin);
    await expect(
      employee.page.getByRole("link", { exact: true, name: "Universal Settings" }),
    ).toBeHidden();
    const systemLauncher = employee.page.getByRole("button", {
      exact: true,
      name: "User and system",
    });
    await systemLauncher.click();
    const systemPanel = employee.page.getByRole("region", { exact: true, name: "User and system" });
    await expect(
      systemPanel.getByRole("link", { exact: true, name: "Universal Settings" }),
    ).toBeVisible();
    await expect(
      systemPanel.getByRole("heading", { exact: true, name: "User and system" }),
    ).toBeFocused();
    await systemPanel.getByRole("link", { exact: true, name: "Universal Settings" }).press("Enter");
    await expect(employee.page).toHaveURL(`${employee.origin}/settings`);
    const settingsHeading = employee.page.getByRole("heading", {
      name: "Your Esbla, with its source visible",
    });
    await expect(settingsHeading).toBeVisible();
    await expect(settingsHeading).toBeFocused();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const settingsEvidencePath = testInfo.outputPath("universal-settings-phone.png");
    await employee.page.screenshot({ fullPage: false, path: settingsEvidencePath });
    await testInfo.attach("universal-settings-phone", {
      contentType: "image/png",
      path: settingsEvidencePath,
    });

    await systemLauncher.click();
    const sameRouteSystemPanel = employee.page.getByRole("region", {
      exact: true,
      name: "User and system",
    });
    await expect(
      sameRouteSystemPanel.getByRole("heading", { exact: true, name: "User and system" }),
    ).toBeFocused();
    await sameRouteSystemPanel
      .getByRole("link", { exact: true, name: "Universal Settings" })
      .press("Enter");
    await expect(employee.page).toHaveURL(`${employee.origin}/settings`);
    await expect(sameRouteSystemPanel).toBeHidden();
    await expect(settingsHeading).toBeFocused();

    await admin.page.goto(`${admin.origin}/settings`);
    await expect(
      admin.page.getByRole("heading", { name: "Tenant presentation defaults" }),
    ).toBeVisible();
    await expect(admin.page.getByLabel("Default to high contrast")).toBeVisible();
    await expect(admin.page.getByLabel("Default to reduced motion")).toBeVisible();
    await expect(admin.page.getByLabel("Require high contrast")).toBeVisible();
    await expect(admin.page.getByLabel("Require reduced motion")).toBeVisible();
  } finally {
    await secondPage?.close().catch(() => undefined);
    await employee.page.setViewportSize({ height: 900, width: 1_280 }).catch(() => undefined);
    await employee.page.goto(`${employee.origin}/settings`).catch(() => undefined);
    const removeShortcut = employee.page
      .locator("article")
      .filter({
        has: employee.page.getByRole("heading", { exact: true, name: "Universal shortcuts" }),
      })
      .getByRole("button", { exact: true, name: "Remove" })
      .first();
    if (await removeShortcut.isVisible().catch(() => false)) {
      await removeShortcut.click().catch(() => undefined);
    }
    const resetAppearance = employee.page.getByRole("button", { name: "Reset my overrides" });
    if (await resetAppearance.isEnabled().catch(() => false)) {
      await resetAppearance.click().catch(() => undefined);
    }
    await closeActors(employee, admin);
  }
});

test("employee submits, manager approves, and employee reloads durable rendered history", async ({
  browser,
}, testInfo) => {
  test.setTimeout(60_000);
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    const leaveRequestId = await submitLeave(employee, {
      endDate: "2027-03-10",
      reason: "Rendered approval journey",
      startDate: "2027-03-10",
    });
    await expect(employee.page.getByRole("dialog", { name: "Leave request detail" })).toBeVisible();
    await expect(employee.page.locator('[data-leave-detail-face="overlay"]')).toBeVisible();

    await employee.page.goto(employee.origin);
    const originLink = employee.page
      .locator('[data-surface-instance="mission-control.my-leave"][data-widget-state="populated"]')
      .locator(`a[href*="/workspace/hr/leave/${leaveRequestId}?"]`);
    await expect(originLink).toHaveAttribute(
      "href",
      `/workspace/hr/leave/${leaveRequestId}?returnContext=mission-control&originFocusId=mission-control.my-leave.${leaveRequestId}`,
    );
    await expect(originLink).toBeVisible();
    await originLink.press("Enter");
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/leave/${leaveRequestId}?returnContext=mission-control&originFocusId=mission-control.my-leave.${leaveRequestId}`,
    );
    const overlay = employee.page.getByRole("dialog", { name: "Leave request detail" });
    await expect(overlay).toBeVisible();
    await expect(overlay).toBeFocused();
    const focusWorkspace = overlay.locator('[data-focus-workspace="hr-leave"]');
    await expect(focusWorkspace).toBeVisible();
    await expect(focusWorkspace.locator('[data-focus-pane="master"]')).toBeVisible();
    await expect(focusWorkspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    const focusGeometry = await focusWorkspace.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const master = element.querySelector('[data-focus-pane="master"]');
      const detail = element.querySelector('[data-focus-pane="detail"]');
      const masterBounds = master?.getBoundingClientRect();
      const detailBounds = detail?.getBoundingClientRect();
      return {
        borderTopWidth: style.borderTopWidth,
        detailStartsAfterMaster: Boolean(
          masterBounds && detailBounds && detailBounds.left >= masterBounds.right,
        ),
        height: Math.round(bounds.height),
        masterWidth: Math.round(masterBounds?.width ?? 0),
        width: Math.round(bounds.width),
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
      };
    });
    expect(focusGeometry).toEqual({
      borderTopWidth: "0px",
      detailStartsAfterMaster: true,
      height: 800,
      masterWidth: 512,
      width: 1_280,
      x: 0,
      y: 0,
    });
    await expect(overlay.locator('[data-leave-detail-face="overlay"]')).toBeVisible();
    await expect(employee.page.locator(".esbla-shell")).toHaveAttribute("aria-hidden", "true");
    await expect(employee.page.locator(".esbla-shell")).toHaveAttribute("inert", "");
    expect(
      await employee.page.evaluate(
        () =>
          document.documentElement.style.overflow === "hidden" &&
          document.body.style.overflow === "hidden",
      ),
    ).toBe(true);
    const overlayEvidencePath = testInfo.outputPath("leave-detail-intercepted-overlay.png");
    await employee.page.screenshot({ fullPage: false, path: overlayEvidencePath });
    await testInfo.attach("leave-detail-intercepted-overlay", {
      contentType: "image/png",
      path: overlayEvidencePath,
    });
    await employee.page.keyboard.press("Tab");
    const closeDetail = overlay.getByRole("button", { name: "Close leave request detail" });
    await expect(closeDetail).toBeFocused();
    await employee.page.keyboard.press("Shift+Tab");
    await expect(
      overlay.getByRole("link", { exact: true, name: "Back to requests" }),
    ).toBeFocused();
    await employee.page.keyboard.press("Tab");
    await expect(closeDetail).toBeFocused();
    const revalidatedOrigin = employee.page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() && response.url() === `${employee.origin}/`,
    );
    await employee.page.keyboard.press("Escape");
    expect((await revalidatedOrigin).status()).toBe(200);
    await employee.page.waitForLoadState("load");
    await expect(employee.page).toHaveURL(`${employee.origin}/`);
    await expect
      .poll(
        async () =>
          await employee.page.evaluate((launcherId) => {
            const active = document.activeElement;
            const launcher = document.getElementById(launcherId);
            const navigation = performance.getEntriesByType("navigation")[0];
            return {
              activeId: active instanceof HTMLElement ? active.id : "",
              activeTagName: active instanceof HTMLElement ? active.tagName : "",
              documentReadyState: document.readyState,
              launcherTabIndex: launcher?.getAttribute("tabindex") ?? null,
              navigationType:
                navigation instanceof PerformanceNavigationTiming ? navigation.type : "unknown",
              receiptPresent:
                window.sessionStorage.getItem("esbla.route-backed-widget.return-focus.v1") !== null,
            };
          }, `mission-control.my-leave.${leaveRequestId}`),
      )
      .toEqual({
        activeId: `mission-control.my-leave.${leaveRequestId}`,
        activeTagName: "A",
        documentReadyState: "complete",
        launcherTabIndex: "0",
        navigationType: "navigate",
        receiptPresent: false,
      });

    await employee.page.goto(`${employee.origin}/workspace/hr/leave/${leaveRequestId}`);
    await expect(employee.page.locator('[data-leave-detail-face="standalone"]')).toBeVisible();
    await expect(employee.page.getByRole("dialog")).toHaveCount(0);
    const canonicalHost = employee.page.getByRole("link", {
      name: "Back to My Leave Requests",
    });
    await expect(canonicalHost).toHaveAttribute("href", "/workspace/hr/leave");
    await employee.page.reload();
    await expect(employee.page.locator('[data-leave-detail-face="standalone"]')).toBeVisible();
    await expect(canonicalHost).toBeVisible();
    await canonicalHost.click();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr/leave`);

    await manager.page.goto(manager.origin);
    const submittedNotifications = await openNotifications(manager);
    const submittedNotification = submittedNotifications.locator("li").filter({
      has: manager.page.locator(`a[href="/workspace/hr/leave/${leaveRequestId}"]`),
    });
    await expect(submittedNotification).toHaveCount(1);
    await expect(
      submittedNotification.getByRole("link", {
        exact: true,
        name: "A leave request needs your review",
      }),
    ).toHaveAttribute("href", `/workspace/hr/leave/${leaveRequestId}`);
    const desktopPanelGeometry = await submittedNotifications.evaluate((panel) => {
      const list = panel.querySelector("ol");
      const source = list?.querySelector("li");
      if (!(list instanceof HTMLOListElement) || !(source instanceof HTMLLIElement)) {
        throw new Error("notification list is missing");
      }
      const clones = [];
      for (let index = 0; index < 20; index += 1) {
        const clone = source.cloneNode(true);
        if (!(clone instanceof HTMLLIElement)) throw new Error("notification row clone failed");
        clone.dataset.layoutProbe = String(index);
        list.append(clone);
        clones.push(clone);
      }
      const panelBox = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      const geometry = {
        bottom: panelBox.bottom,
        clientHeight: panel.clientHeight,
        overflowY: style.overflowY,
        scrollHeight: panel.scrollHeight,
        viewportHeight: innerHeight,
      };
      for (const clone of clones) clone.remove();
      return geometry;
    });
    expect(desktopPanelGeometry.bottom).toBeLessThanOrEqual(
      desktopPanelGeometry.viewportHeight + 1,
    );
    expect(desktopPanelGeometry.scrollHeight).toBeGreaterThan(desktopPanelGeometry.clientHeight);
    expect(["auto", "scroll"]).toContain(desktopPanelGeometry.overflowY);
    const managerNotificationEvidence = testInfo.outputPath(
      "leave-submitted-manager-notification.png",
    );
    await manager.page.screenshot({ fullPage: false, path: managerNotificationEvidence });
    await testInfo.attach("leave-submitted-manager-notification", {
      contentType: "image/png",
      path: managerNotificationEvidence,
    });
    const markReadResponse = manager.page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /^\/platform\/notifications\/[0-9a-f-]{36}\/read$/.test(new URL(response.url()).pathname),
    );
    await submittedNotification
      .getByRole("button", { name: "Mark “A leave request needs your review” as read" })
      .press("Enter");
    const markRead = await markReadResponse;
    expect(markRead.status(), JSON.stringify(markRead.request().headers())).toBe(200);
    await expect(submittedNotification.getByText("Read", { exact: true })).toBeVisible();
    const managerNotificationLauncher = manager.page.getByRole("button", {
      name: /^Notifications(?:, \d+ unread)?$/,
    });
    await manager.page.keyboard.press("Escape");
    await expect(submittedNotifications).toHaveCount(0);
    await expect(managerNotificationLauncher).toBeFocused();
    const reopenedSubmittedNotifications = await openNotifications(manager);
    const reopenedSubmittedNotification = reopenedSubmittedNotifications.locator("li").filter({
      has: manager.page.locator(`a[href="/workspace/hr/leave/${leaveRequestId}"]`),
    });
    await expect(reopenedSubmittedNotification.getByText("Read", { exact: true })).toBeVisible();
    await expect(
      reopenedSubmittedNotification.getByRole("button", {
        name: "Mark “A leave request needs your review” as read",
      }),
    ).toHaveCount(0);
    await manager.page.keyboard.press("Escape");
    await expect(reopenedSubmittedNotifications).toHaveCount(0);
    await expect(managerNotificationLauncher).toBeFocused();

    const myWorkWidget = manager.page.locator(
      '[data-widget-definition="platform.my-work.queue"]:not([data-widget-state="loading"])',
    );
    await expect(myWorkWidget).toHaveAttribute("data-widget-state", "populated");
    const assignedWidgetRow = myWorkWidget.locator(".zen-widget-work-row").filter({
      has: manager.page.locator(
        `a[href*="/workspace/hr/leave/${leaveRequestId}?returnContext=mission-control"]`,
      ),
    });
    await expect(assignedWidgetRow).toContainText(fixture.employeeDisplayName);
    const approve = assignedWidgetRow.getByRole("button", {
      name: "Approve leave request",
    });
    await approve.focus();
    await expect(approve).toBeFocused();
    await approve.press("Enter");
    const confirm = assignedWidgetRow.getByRole("button", { name: "Confirm approval" });
    await expect(confirm).toBeFocused();
    await confirm.press("Enter");
    await expect(manager.page).toHaveURL(
      `${fixture.managerOrigin}/workspace/hr/leave/${leaveRequestId}?returnContext=my-work`,
    );
    await expectHistory(manager, "Approved", ["Submitted", "Approved"]);

    await employee.page.reload();
    await employee.page.setViewportSize({ height: 844, width: 390 });
    await employee.page.reload();
    const approvedNotifications = await openNotifications(employee);
    const approvedNotification = approvedNotifications.locator("li").filter({
      has: employee.page.locator(`a[href="/workspace/hr/leave/${leaveRequestId}"]`),
    });
    await expect(approvedNotification).toHaveCount(1);
    await expect(
      approvedNotification.getByRole("link", {
        exact: true,
        name: "Your leave request was approved",
      }),
    ).toHaveAttribute("href", `/workspace/hr/leave/${leaveRequestId}`);
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const employeeNotificationEvidence = testInfo.outputPath(
      "leave-approved-employee-notification-mobile.png",
    );
    await employee.page.screenshot({ fullPage: false, path: employeeNotificationEvidence });
    await testInfo.attach("leave-approved-employee-notification-mobile", {
      contentType: "image/png",
      path: employeeNotificationEvidence,
    });
    await employee.page.keyboard.press("Escape");
    await employee.page.keyboard.press("Escape");

    const employeeListRow = employee.page.locator("tbody tr").filter({
      has: employee.page.locator(
        `a[href="/workspace/hr/leave/${leaveRequestId}?returnContext=leave-list"]`,
      ),
    });
    await expect(employeeListRow.locator(".leave-status")).toHaveText("approved");
    await employeeListRow.getByRole("link", { name: "View details" }).click();
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/leave/${leaveRequestId}?returnContext=leave-list`,
    );
    await expectHistory(employee, "Approved", ["Submitted", "Approved"]);
  } finally {
    await closeActors(employee, manager);
  }
});

test("configured rejection note fails accessibly, then rejection persists after reload", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    const leaveRequestId = await submitLeave(employee, {
      endDate: "2027-03-11",
      reason: "Rendered rejection journey",
      startDate: "2027-03-11",
    });
    const card = await openAssignedWork(manager, leaveRequestId);
    const reject = card.getByRole("button", { name: "Reject leave request" });
    await reject.focus();
    await manager.page.keyboard.press("Enter");
    const note = card.getByLabel("Decision note");
    await expect(note).toBeFocused();

    const failedResponse = manager.page.waitForResponse((response) =>
      response.url().endsWith(`/leave/${leaveRequestId}/reject`),
    );
    const confirm = card.getByRole("button", { name: "Confirm rejection" });
    await confirm.focus();
    await manager.page.keyboard.press("Enter");
    expect((await failedResponse).status()).toBe(400);
    await expect(note).toBeFocused();
    await expect(note).toHaveAttribute("aria-invalid", "true");
    await expect(
      card.getByText("A decision note is required by your tenant policy."),
    ).toBeVisible();
    expect(manager.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 400 (Bad Request)",
    ]);
    manager.diagnostics.console.length = 0;

    const decisionNote = "Coverage remains available after this date.";
    await note.fill(decisionNote);
    const successResponse = manager.page.waitForResponse((response) =>
      response.url().endsWith(`/leave/${leaveRequestId}/reject`),
    );
    await confirm.focus();
    await manager.page.keyboard.press("Enter");
    expect((await successResponse).status()).toBe(200);
    await expect(manager.page).toHaveURL(
      `${fixture.managerOrigin}/workspace/hr/leave/${leaveRequestId}?returnContext=my-work`,
    );
    await expectHistory(manager, "Rejected", ["Submitted", "Rejected"]);
    await expect(manager.page.getByText(decisionNote, { exact: true })).toBeVisible();

    await employee.page.reload();
    await expectHistory(employee, "Rejected", ["Submitted", "Rejected"]);
    await expect(employee.page.getByText(decisionNote, { exact: true })).toBeVisible();
  } finally {
    await closeActors(employee, manager);
  }
});

test("HR operator onboards a worker and the employee reloads a minimized profile", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  try {
    await employee.page.goto(`${employee.origin}/workspace/hr/profile`);
    await expect(employee.page.getByRole("heading", { name: "Workforce profile" })).toBeVisible();
    await expect(employee.page.getByRole("heading", { name: "No active profile" })).toBeVisible();

    await operator.page.goto(`${operator.origin}/workspace/hr/profile/admin`);
    await expect(operator.page.getByRole("heading", { name: "Onboard a worker" })).toBeVisible();
    const employeeNumber = operator.page.getByLabel("Employee number");
    await employeeNumber.focus();
    await employeeNumber.fill("BROWSER-WORKER-001");
    await employeeNumber.press("Tab");
    await expect(operator.page.getByRole("button", { name: "Create draft profile" })).toBeFocused();
    await operator.page.keyboard.press("Enter");

    await expect(operator.page.getByLabel("Principal ID")).toBeFocused();
    await operator.page.reload();
    const principalId = operator.page.getByLabel("Principal ID");
    await expect(principalId).toBeFocused();
    await principalId.fill("not-a-principal-id");
    await principalId.press("Tab");
    await operator.page.keyboard.press("Enter");
    await expect(operator.page.locator(".form-error-summary")).toBeFocused();
    await expect(principalId).toHaveAttribute("aria-invalid", "true");
    expect(operator.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 400 (Bad Request)",
    ]);
    operator.diagnostics.console.length = 0;
    await principalId.fill(fixture.employeePrincipalId);
    await principalId.press("Tab");
    await expect(operator.page.getByRole("button", { name: "Link principal" })).toBeFocused();
    await operator.page.keyboard.press("Enter");

    const activate = operator.page.getByRole("button", { name: "Activate profile" });
    await expect(activate).toBeFocused();
    await operator.page.keyboard.press("Enter");
    await expect(operator.page.getByText("Onboarding complete", { exact: true })).toBeVisible();
    await expect(operator.page.getByRole("link", { name: "Return to HR" })).toBeFocused();
    await operator.page.getByRole("button", { name: "Onboard another worker" }).click();
    await expect(operator.page.getByLabel("Employee number")).toBeFocused();

    await employee.page.reload();
    await expect(employee.page.getByText("BROWSER-WORKER-001", { exact: true })).toBeVisible();
    await expect(employee.page.locator(".leave-status")).toHaveText("Active");
    await expect(employee.page.getByText("Connected", { exact: true })).toBeVisible();

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await enableHighContrast(employee);
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    await employee.page.goto(`${employee.origin}/workspace/hr/profile/admin`);
    await employee.page.getByLabel("Employee number").fill("DENIED-WORKER");
    await employee.page.getByRole("button", { name: "Create draft profile" }).click();
    await expect(employee.page.locator(".form-error-summary")).toBeFocused();
    await expect(employee.page.locator(".form-error-summary")).toContainText(
      "You do not have permission",
    );
    expect(employee.diagnostics.console).toEqual([
      "Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
    employee.diagnostics.console.length = 0;
  } finally {
    await closeActors(employee, operator);
  }
});

test("current manager browses direct reports and returns from persistent detail", async ({
  browser,
}) => {
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    await manager.page.goto(`${manager.origin}/workspace/hr/profile/direct-reports`);
    await expect(
      manager.page.getByRole("heading", { name: "Direct reports", exact: true }),
    ).toBeVisible();
    await expect(manager.page.getByText("BROWSER-DIRECT-001", { exact: true })).toBeVisible();
    await expect(manager.page.getByText("BROWSER-DRAFT-001", { exact: true })).toHaveCount(0);

    const row = manager.page.locator("tbody tr").filter({ hasText: "BROWSER-DIRECT-001" });
    const viewDetails = row.getByRole("link", { name: "View details" });
    await viewDetails.focus();
    await manager.page.keyboard.press("Enter");
    await expect(manager.page).toHaveURL(/returnContext=direct-reports$/);
    await expect(
      manager.page.getByRole("heading", { name: "Employee BROWSER-DIRECT-001" }),
    ).toBeVisible();
    await expect(manager.page.getByRole("heading", { name: "Reporting history" })).toBeVisible();
    await expect(manager.page.getByText("Manager assigned", { exact: true })).toBeVisible();
    await expect(manager.page.getByRole("heading", { name: "Profile maintenance" })).toHaveCount(0);
    const managerDetailPath = new URL(manager.page.url()).pathname;
    await manager.page.goto(`${manager.origin}${managerDetailPath}?returnContext=admin`);
    await expect(
      manager.page.getByRole("heading", { name: "Employee BROWSER-DIRECT-001" }),
    ).toBeVisible();
    await expect(manager.page.getByRole("heading", { name: "Profile maintenance" })).toHaveCount(0);

    await manager.page.goto(`${manager.origin}${managerDetailPath}?returnContext=direct-reports`);
    const back = manager.page.getByRole("link", { name: "Back to direct reports" });
    await back.focus();
    await manager.page.keyboard.press("Enter");
    await expect(
      manager.page.getByRole("heading", { name: "Direct reports", exact: true }),
    ).toBeVisible();

    await manager.page.setViewportSize({ height: 844, width: 390 });
    await enableHighContrast(manager);
    expect(
      await manager.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  } finally {
    await closeActors(manager);
  }
});

test("HR operator filters workforce while employee list access fails closed", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  try {
    await operator.page.goto(`${operator.origin}/workspace/hr/profile/admin`);
    await expect(operator.page.getByRole("heading", { name: "Workforce directory" })).toBeVisible();
    await expect(operator.page.getByText("BROWSER-MANAGER-001", { exact: true })).toBeVisible();
    const activeRow = operator.page.locator("tbody tr").filter({ hasText: "BROWSER-DIRECT-001" });
    await activeRow.getByRole("link", { name: "View details" }).click();
    await expect(
      operator.page.getByRole("heading", { name: "Employee BROWSER-DIRECT-001" }),
    ).toBeVisible();
    await expect(operator.page.getByRole("heading", { name: "Profile maintenance" })).toBeVisible();

    const detailPath = new URL(operator.page.url()).pathname;
    const initialVersion = Number(await workforceRecordVersion(operator.page).textContent());
    const reportingResponse = operator.page.waitForResponse(
      (response) => new URL(response.url()).pathname === `${detailPath}/action`,
    );
    const removeManager = operator.page.getByRole("button", { name: "Remove manager" });
    await expect(removeManager).toBeEnabled();
    await removeManager.press("Enter");
    expect((await reportingResponse).status()).toBe(200);
    await expect(workforceRecordVersion(operator.page)).toHaveText(String(initialVersion + 1));
    await expect(
      operator.page.locator(
        'ol[aria-labelledby="relationship-history-heading"] .leave-history-item strong',
      ),
    ).toHaveText(["Manager unassigned", "Manager assigned"]);
    await operator.page.reload();
    await expect(workforceRecordVersion(operator.page)).toHaveText(String(initialVersion + 1));

    const statusResponse = operator.page.waitForResponse(
      (response) => new URL(response.url()).pathname === `${detailPath}/action`,
    );
    await operator.page.getByLabel("Workforce status").selectOption("suspended");
    const updateStatus = operator.page.getByRole("button", { name: "Update status" });
    await expect(updateStatus).toBeEnabled();
    await updateStatus.press("Enter");
    expect((await statusResponse).status()).toBe(200);
    await expect(workforceRecordVersion(operator.page)).toHaveText(String(initialVersion + 2));
    await expect(operator.page.locator(".leave-detail-heading .leave-status")).toHaveText(
      "Suspended",
    );
    await expect(
      operator.page.locator(
        'ol[aria-labelledby="status-history-heading"] .leave-history-item strong',
      ),
    ).toHaveText(["Suspended", "Active", "Draft"]);
    await operator.page.reload();
    await expect(workforceRecordVersion(operator.page)).toHaveText(String(initialVersion + 2));
    await expect(operator.page.locator(".leave-detail-heading .leave-status")).toHaveText(
      "Suspended",
    );
    await operator.page.getByRole("link", { name: "Back to workforce administration" }).click();

    const draft = operator.page.getByRole("link", { name: "Draft" });
    await draft.focus();
    await operator.page.keyboard.press("Enter");
    await expect(operator.page).toHaveURL(/\/workspace\/hr\/profile\/admin\?status=draft$/);
    await expect(operator.page.getByText("BROWSER-DRAFT-001", { exact: true })).toBeVisible();
    await expect(draft).toHaveAttribute("aria-current", "page");

    await employee.page.goto(`${employee.origin}/workspace/hr/profile/direct-reports`);
    await expect(
      employee.page.getByRole("heading", { name: "Workforce list unavailable" }),
    ).toBeVisible();
    await expect(employee.page.locator("table")).toHaveCount(0);
    await expect(employee.page.getByText("BROWSER-DIRECT-001", { exact: true })).toHaveCount(0);
  } finally {
    await closeActors(employee, operator);
  }
});

test("tenant admin configures and controls Workforce Profile without record access", async ({
  browser,
}) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    await admin.page.goto(`${admin.origin}/workspace/hr/profile/settings`);
    await expect(admin.page.locator(".esbla-shell")).toHaveAttribute("data-current-surface", "HR");
    await expect(
      admin.page.getByRole("heading", { name: "Workforce Profile settings" }),
    ).toBeVisible();
    await expect(admin.page.getByText("BROWSER-DIRECT-001", { exact: true })).toHaveCount(0);
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");

    const settingsVersion = Number(
      await serviceControlFact(admin.page, "Settings version").textContent(),
    );
    await admin.page.getByLabel("Require an employee number").check();
    await admin.page.getByLabel("Manager visibility").selectOption("none");
    await admin.page.getByLabel("Allow an HR operator").uncheck();
    const saveResponse = admin.page.waitForResponse((response) =>
      response.url().endsWith("/workspace/hr/profile/settings/action"),
    );
    await admin.page.getByRole("button", { name: "Save Workforce settings" }).press("Enter");
    expect((await saveResponse).status()).toBe(200);
    await expect(admin.page.locator(".success-banner")).toBeFocused();
    await expect(serviceControlFact(admin.page, "Settings version")).toHaveText(
      String(settingsVersion + 1),
    );
    await admin.page.reload();
    await expect(admin.page.getByLabel("Require an employee number")).toBeChecked();
    await expect(admin.page.getByLabel("Manager visibility")).toHaveValue("none");
    await expect(admin.page.getByLabel("Allow an HR operator")).not.toBeChecked();

    await manager.page.goto(`${manager.origin}/workspace/hr/profile/direct-reports`);
    await expect(
      manager.page.getByRole("heading", { name: "Workforce list unavailable" }),
    ).toBeVisible();

    const deactivateResponse = admin.page.waitForResponse((response) =>
      response.url().endsWith("/workspace/hr/profile/settings/action"),
    );
    await admin.page.getByRole("button", { name: "Deactivate service" }).press("Enter");
    expect((await deactivateResponse).status()).toBe(200);
    await expect(admin.page.locator(".success-banner")).toBeFocused();
    await expect(admin.page.locator(".leave-status")).toHaveText("Inactive");
    await admin.page.reload();
    await expect(admin.page.getByRole("heading", { name: "Preserved settings" })).toBeVisible();
    await expect(admin.page.getByText("Blocked", { exact: true })).toBeVisible();

    await employee.page.goto(`${employee.origin}/workspace/hr/profile`);
    await expect(
      employee.page.getByRole("heading", { name: "Workforce Profile inactive" }),
    ).toBeVisible();
    await employee.page.goto(`${employee.origin}/workspace/hr/profile/settings`);
    await expect(
      employee.page.getByRole("heading", { name: "Service controls unavailable" }),
    ).toBeVisible();

    const activateResponse = admin.page.waitForResponse((response) =>
      response.url().endsWith("/workspace/hr/profile/settings/action"),
    );
    await admin.page.getByRole("button", { name: "Activate service" }).press("Enter");
    expect((await activateResponse).status()).toBe(200);
    await expect(admin.page.locator(".success-banner")).toBeFocused();
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");
    await employee.page.goto(`${employee.origin}/workspace/hr/profile`);
    await expect(employee.page.getByRole("heading", { name: "Current profile" })).toBeVisible();

    await admin.page.setViewportSize({ height: 844, width: 390 });
    await enableHighContrast(admin);
    expect(
      await admin.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  } finally {
    await closeActors(admin, employee, manager);
  }
});

test("Employment facts progress through immutable versions and persist for the employee", async ({
  browser,
}) => {
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const listOperator = await openActor(
    browser,
    fixture.employmentListOperatorOrigin,
    fixture.employmentListOperatorLabel,
  );
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  try {
    await operator.page.goto(`${operator.origin}/workspace/hr/employment/admin`);
    await expect(
      operator.page.getByRole("heading", { name: "Employment record administration" }),
    ).toBeVisible();

    await operator.page.setViewportSize({ height: 844, width: 390 });
    const workforceDirectory = operator.page.getByRole("link", {
      name: "Open Workforce directory",
    });
    const createRecord = operator.page.getByRole("button", { name: "Create employment record" });
    await workforceDirectory.focus();
    await expect(workforceDirectory).toHaveCSS("outline-color", "rgb(20, 151, 232)");
    await operator.page.keyboard.press("Tab");
    await expect(createRecord).toBeFocused();
    const [directoryBox, createBox] = await Promise.all([
      workforceDirectory.boundingBox(),
      createRecord.boundingBox(),
    ]);
    expect(directoryBox?.y).toBeLessThan(createBox?.y ?? 0);
    await workforceDirectory.click();
    const eligibleWorker = operator.page
      .locator(".leave-table tbody tr")
      .filter({ hasText: "BROWSER-EMPLOYMENT-001" });
    await expect(eligibleWorker).toHaveCount(1);
    await eligibleWorker.getByRole("link", { name: "Start employment record" }).click();
    const workerProfileInput = operator.page.getByLabel("Worker Profile ID");
    const workerProfileId = await workerProfileInput.inputValue();
    expect(workerProfileId).toMatch(/^[0-9a-f-]{36}$/);
    await submitEmploymentForm(
      operator,
      operator.page.getByRole("button", { name: "Create employment record" }),
    );
    await expect(operator.page.locator(".success-banner > p")).toHaveCSS(
      "color",
      "rgb(38, 52, 67)",
    );

    let recordCard = employmentRecordCard(operator.page, workerProfileId);
    await expect(recordCard).toHaveCount(1);
    const draftDetailHref = await recordCard
      .getByRole("link", { name: "View immutable history" })
      .getAttribute("href");
    expect(draftDetailHref).toMatch(/^\/workspace\/hr\/employment\/by-id\/[0-9a-f-]+$/);
    await employee.page.goto(`${employee.origin}${draftDetailHref}`);
    await expect(employee.page.locator(".leave-detail-heading .leave-status")).toHaveText("Draft");
    await expect(employmentFact(employee.page, "Effective from")).toHaveText("Not established");
    await expect(employmentFact(employee.page, "Effective to")).toHaveText("Not established");

    const firstEffectiveFrom = recordCard.getByLabel("Effective from");
    const employmentTypeCode = recordCard.getByLabel("Employment type code");
    await employmentTypeCode.focus();
    await employmentTypeCode.press("Tab");
    await expect(recordCard.getByLabel("Organization reference")).toBeFocused();
    await firstEffectiveFrom.fill("2027-01-01");
    await recordCard.getByLabel("Effective to").fill("2027-06-30");
    await employmentTypeCode.fill("unspecified");
    await recordCard.getByLabel("Organization reference").fill("org-browser-one");
    await recordCard.getByLabel("Position reference").fill("position-browser-one");
    await submitEmploymentForm(
      operator,
      recordCard.getByRole("button", { name: "Establish first effective version" }),
    );

    recordCard = employmentRecordCard(operator.page, workerProfileId);
    await recordCard.getByLabel("Effective from").fill("2027-07-01");
    await recordCard.getByLabel("Employment type code").fill("unspecified");
    await recordCard.getByLabel("Organization reference").fill("org-browser-two");
    await recordCard.getByLabel("Position reference").fill("position-browser-two");
    await submitEmploymentForm(
      operator,
      recordCard.getByRole("button", { name: "Append effective successor" }),
    );

    recordCard = employmentRecordCard(operator.page, workerProfileId);
    const detailHref = await recordCard
      .getByRole("link", { name: "View immutable history" })
      .getAttribute("href");
    expect(detailHref).toMatch(/^\/workspace\/hr\/employment\/by-id\/[0-9a-f-]+$/);

    await employee.page.goto(`${employee.origin}/workspace/hr/employment`);
    await expect(employee.page.getByRole("heading", { name: "Employment facts" })).toBeVisible();
    const employeeDetail = employee.page.getByRole("link", { name: "View facts and history" });
    await employeeDetail.focus();
    await employee.page.keyboard.press("Enter");
    await expect(
      employee.page.getByRole("heading", { name: "Effective employment facts" }),
    ).toBeVisible();
    await expect(employee.page.locator(".leave-detail-heading .leave-status")).toHaveText("Active");
    await expect(employmentFact(employee.page, "Employment type code")).toHaveText("unspecified");
    await expect(employmentFact(employee.page, "Effective from")).toHaveText("2027-07-01");
    await expect(employmentFact(employee.page, "Effective to")).toHaveText("Open ended");
    await expect(
      employee.page.locator(
        'ol[aria-labelledby="employment-history-heading"] .leave-history-item strong',
      ),
    ).toHaveText(["Effective version 2", "Effective version 1"]);
    await expect(
      employee.page.getByRole("link", { name: "Manage employment records" }),
    ).toHaveCount(0);
    await expect(
      employee.page.locator('form[action="/workspace/hr/employment/action"]'),
    ).toHaveCount(0);
    await employee.page.reload();
    await expect(employmentFact(employee.page, "Employment type code")).toHaveText("unspecified");

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await enableHighContrast(employee);
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    recordCard = employmentRecordCard(operator.page, workerProfileId);
    await recordCard.getByLabel("Exact end date").fill("2027-12-31");
    await submitEmploymentForm(
      operator,
      recordCard.getByRole("button", { name: "End employment record" }),
    );

    await employee.page.reload();
    await expect(employee.page.locator(".leave-detail-heading .leave-status")).toHaveText("Ended");
    await expect(
      employee.page.locator(
        'ol[aria-labelledby="employment-history-heading"] .leave-history-item strong',
      ),
    ).toHaveText(["Employment ended", "Effective version 2", "Effective version 1"]);
    await expect(employmentFact(employee.page, "Effective to")).toHaveText("2027-12-31");

    await listOperator.page.goto(`${listOperator.origin}/workspace/hr/employment`);
    await expect(
      listOperator.page
        .locator('ol[aria-label="Authorized employment records"] > li')
        .filter({ hasText: workerProfileId }),
    ).toHaveCount(1);
    await expect(
      listOperator.page.getByRole("link", { name: "View facts and history" }),
    ).toHaveCount(0);
    await expect(
      listOperator.page.getByRole("link", { name: "Employment administration" }),
    ).toHaveCount(0);

    await manager.page.goto(`${manager.origin}${detailHref}`);
    await expect(
      manager.page.getByRole("heading", { name: "Employment records unavailable" }),
    ).toBeVisible();
    await expect(manager.page.getByRole("heading", { name: "Current facts" })).toHaveCount(0);
  } finally {
    await closeActors(employee, listOperator, manager, operator);
  }
});

test("tenant admin configures and controls Employment without record access", async ({
  browser,
}) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  const longOrganizationReference = `org-${"opaque".repeat(80)}`;
  try {
    await admin.page.emulateMedia({ colorScheme: "dark" });
    await admin.page.goto(`${admin.origin}/workspace/hr/employment/settings`);
    await expect(
      admin.page.getByRole("heading", { name: "Employment Record settings" }),
    ).toBeVisible();
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");
    await expect(admin.page.getByText("BROWSER-EMPLOYMENT-001", { exact: true })).toHaveCount(0);
    await enableDarkHighContrast(admin);

    const settingsVersion = Number(
      await serviceControlFact(admin.page, "Settings version").textContent(),
    );
    await admin.page.getByLabel("Employment type codes").fill("unspecified,standard,temporary");
    await submitEmploymentForm(
      admin,
      admin.page.getByRole("button", { name: "Save Employment settings" }),
    );
    await expect(admin.page.locator("body")).toHaveCSS("background-color", "rgb(23, 26, 29)");
    await expect(admin.page.locator(".success-banner")).toHaveCSS("color", "rgb(86, 208, 173)");
    await expect(admin.page.locator(".success-banner > p")).toHaveCSS(
      "color",
      "rgb(238, 245, 247)",
    );
    await expect(admin.page.locator(".success-banner")).toHaveCSS(
      "outline-color",
      "rgb(141, 220, 255)",
    );
    await expect(serviceControlFact(admin.page, "Settings version")).toHaveText(
      String(settingsVersion + 1),
    );
    await admin.page.reload();
    await expect(admin.page.getByLabel("Employment type codes")).toHaveValue(
      "unspecified,standard,temporary",
    );
    await expect(admin.page.getByText("Blocked by policy floor", { exact: true })).toBeVisible();

    await admin.page.goto(`${admin.origin}/workspace/hr/employment`);
    await expect(
      admin.page.getByRole("heading", { name: "Employment records unavailable" }),
    ).toBeVisible();
    await expect(admin.page.getByRole("link", { name: "Employment administration" })).toHaveCount(
      0,
    );
    await expect(admin.page.getByRole("link", { name: "View facts and history" })).toHaveCount(0);

    await operator.page.goto(`${operator.origin}/workspace/hr/employment/admin`);
    await operator.page.getByRole("link", { name: "Open Workforce directory" }).click();
    await operator.page.getByRole("link", { name: "Draft" }).click();
    const eligibleWorker = operator.page
      .locator(".leave-table tbody tr")
      .filter({ hasText: "BROWSER-EMPLOYMENT-CONTROL-001" });
    await expect(eligibleWorker).toHaveCount(1);
    await eligibleWorker.getByRole("link", { name: "Start employment record" }).click();
    const workerProfileId = await operator.page.getByLabel("Worker Profile ID").inputValue();
    expect(workerProfileId).toMatch(/^[0-9a-f-]{36}$/);
    await submitEmploymentForm(
      operator,
      operator.page.getByRole("button", { name: "Create employment record" }),
    );

    let recordCard = employmentRecordCard(operator.page, workerProfileId);
    await expect(recordCard).toHaveCount(1);
    await recordCard.getByLabel("Effective from").fill("2028-01-01");
    await recordCard.getByLabel("Employment type code").fill("standard");
    await recordCard.getByLabel("Organization reference").fill(longOrganizationReference);
    await recordCard.getByLabel("Position reference").fill("position-service-control");
    await submitEmploymentForm(
      operator,
      recordCard.getByRole("button", { name: "Establish first effective version" }),
    );
    recordCard = employmentRecordCard(operator.page, workerProfileId);
    const detailHref = await recordCard
      .getByRole("link", { name: "View immutable history" })
      .getAttribute("href");
    expect(detailHref).toMatch(/^\/workspace\/hr\/employment\/by-id\/[0-9a-f-]+$/);

    await admin.page.goto(`${admin.origin}/workspace/hr/employment/settings`);
    await submitEmploymentForm(
      admin,
      admin.page.getByRole("button", { name: "Deactivate service" }),
    );
    await expect(admin.page.locator(".leave-status")).toHaveText("Inactive");
    await expect(
      admin.page.getByRole("button", { name: "Save Employment settings" }),
    ).toBeDisabled();

    await operator.page.goto(`${operator.origin}/workspace/hr/employment`);
    await expect(
      operator.page.getByRole("heading", { name: "Employment Record inactive" }),
    ).toBeVisible();
    await expect(operator.page.getByText(/facts and history are preserved/i)).toBeVisible();

    await submitEmploymentForm(admin, admin.page.getByRole("button", { name: "Activate service" }));
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");
    await operator.page.goto(`${operator.origin}${detailHref}`);
    await expect(operator.page.locator(".leave-detail-heading .leave-status")).toHaveText("Active");
    await expect(employmentFact(operator.page, "Employment type code")).toHaveText("standard");
    const organizationFact = employmentFact(operator.page, "Organization reference");
    await expect(organizationFact).toHaveText(longOrganizationReference);
    await expect(
      operator.page.locator(
        'ol[aria-labelledby="employment-history-heading"] .leave-history-item strong',
      ),
    ).toHaveText(["Effective version 1"]);
    await operator.page.setViewportSize({ height: 844, width: 390 });
    const historyReference = operator.page
      .locator('ol[aria-labelledby="employment-history-heading"] .leave-history-item p')
      .filter({ hasText: longOrganizationReference });
    for (const value of [organizationFact, historyReference]) {
      const dimensions = await value.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    }
    expect(
      await operator.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  } finally {
    await closeActors(admin, operator);
  }
});

test("Employment and Shift widgets follow exact action capabilities", async ({ browser }) => {
  const shiftAdmin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const actionAdmin = await openActor(
    browser,
    fixture.employmentActionAdminOrigin,
    fixture.employmentActionAdminLabel,
  );
  const actionOperator = await openActor(
    browser,
    fixture.employmentActionOperatorOrigin,
    fixture.employmentActionOperatorLabel,
  );
  const readEmployee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const listOperator = await openActor(
    browser,
    fixture.employmentListOperatorOrigin,
    fixture.employmentListOperatorLabel,
  );
  const viewAdmin = await openActor(
    browser,
    fixture.employmentViewAdminOrigin,
    fixture.employmentViewAdminLabel,
  );
  const employmentForm = (page, operation) =>
    page
      .locator('form[action="/workspace/hr/employment/action"]')
      .filter({ has: page.locator(`input[name="operation"][value="${operation}"]`) });
  const actionAdminForm = (operation) => employmentForm(actionAdmin.page, operation);
  const shiftForm = (page, operation) =>
    page
      .locator('form[action="/workspace/hr/shifts/action"]')
      .filter({ has: page.locator(`input[name="operation"][value="${operation}"]`) });
  const shiftServiceForm = (operation) => shiftForm(shiftAdmin.page, operation);
  const expectActionAdminReceipt = async ({ activation, control, settings, state }) => {
    await expect(
      actionAdmin.page.getByRole("heading", { name: "Last mutation receipt" }),
    ).toBeVisible();
    await expect(serviceControlFact(actionAdmin.page, "Receipt activation version")).toHaveText(
      activation,
    );
    await expect(serviceControlFact(actionAdmin.page, "Receipt settings version")).toHaveText(
      settings,
    );
    await expect(serviceControlFact(actionAdmin.page, "Receipt control version")).toHaveText(
      control,
    );
    await expect(serviceControlFact(actionAdmin.page, "Receipt activation state")).toHaveText(
      state,
    );
  };
  const submitShiftServiceForm = async (operation, name) => {
    const response = shiftAdmin.page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/workspace/hr/shifts/action",
    );
    await shiftServiceForm(operation).getByRole("button", { name }).click();
    expect((await response).status()).toBe(303);
    await expect(shiftAdmin.page).toHaveURL(/\/workspace\/hr\/shifts\/settings\?result=success/);
    await expect(shiftAdmin.page.locator(".success-banner")).toBeFocused();
  };
  const expectShiftServiceReceipt = async ({ activation, control, settings, state }) => {
    await expect(
      shiftAdmin.page.getByRole("heading", { name: "Last service-control receipt" }),
    ).toBeVisible();
    await expect(serviceControlFact(shiftAdmin.page, "Receipt activation version")).toHaveText(
      activation,
    );
    await expect(serviceControlFact(shiftAdmin.page, "Receipt settings version")).toHaveText(
      settings,
    );
    await expect(serviceControlFact(shiftAdmin.page, "Receipt control version")).toHaveText(
      control,
    );
    await expect(serviceControlFact(shiftAdmin.page, "Receipt activation state")).toHaveText(state);
  };
  try {
    await actionOperator.page.goto(`${actionOperator.origin}/workspace/hr/employment/admin`);
    for (const operation of ["create_record", "create_version", "end_record"]) {
      await expect(employmentForm(actionOperator.page, operation)).toHaveCount(1);
    }
    await actionOperator.page.goto(
      `${actionOperator.origin}/workspace/hr/shifts/reports?rosterVersionId=00000000-0000-4000-8000-000000000000`,
    );
    await expect(actionOperator.page.locator(".form-error-summary")).toBeVisible();
    await expect(
      actionOperator.page.locator('form[action="/workspace/hr/shifts/action"]'),
    ).toHaveCount(4);
    await actionAdmin.page.goto(`${actionAdmin.origin}/workspace/hr/shifts/settings`);
    await expect(
      actionAdmin.page.getByRole("heading", { name: "Shift Assignment settings" }),
    ).toBeVisible();
    await expect(actionAdmin.page.getByLabel("Expected settings version")).toHaveValue("");
    await expect(actionAdmin.page.getByLabel("Maximum inclusive roster days")).toHaveValue("");
    await expect(shiftForm(actionAdmin.page, "configure_service")).toHaveCount(1);
    await actionOperator.page.goto(
      `${actionOperator.origin}/workspace/hr/shifts/reports?rosterVersionId=00000000-0000-4000-8000-000000000000`,
    );
    await actionOperator.page.getByText("Create an exact roster period", { exact: true }).click();
    await actionOperator.page.getByLabel("Period start").fill("2030-01-01");
    await actionOperator.page.getByLabel("Period end").fill("2030-01-07");
    await actionOperator.page.getByRole("button", { name: "Create draft roster" }).click();
    await expect(
      actionOperator.page.getByRole("heading", { name: "Last Shift action receipt" }),
    ).toBeVisible();
    await expect(actionOperator.page.getByText(/create_roster confirmed draft/)).toBeVisible();
    await actionOperator.page.reload();
    await expect(
      actionOperator.page.getByRole("heading", { name: "Last Shift action receipt" }),
    ).toBeVisible();
    await actionOperator.page.goto(`${actionOperator.origin}/workspace/hr/employment/admin`);
    await waitForShellHydration(actionOperator);
    await employmentForm(actionOperator.page, "create_record")
      .getByLabel("Worker Profile ID")
      .fill(employmentActionWorkerProfileId);
    await submitEmploymentForm(
      actionOperator,
      employmentForm(actionOperator.page, "create_record").getByRole("button", {
        name: "Create employment record",
      }),
    );
    const actionVersion = employmentForm(actionOperator.page, "create_version");
    await expect(actionVersion.getByLabel("Employment Record ID")).toHaveValue(/^[0-9a-f-]{36}$/);
    await expect(actionVersion.getByLabel("Expected root version")).toHaveValue("1");
    await expect(actionVersion.getByLabel("Expected current effective version")).toHaveValue("");
    await actionVersion.getByLabel("Effective from").fill("2029-01-01");
    await actionVersion.getByLabel("Employment type code").fill("unspecified");
    await submitEmploymentForm(
      actionOperator,
      actionVersion.getByRole("button", { name: "Append exact effective version" }),
    );
    const actionEnd = employmentForm(actionOperator.page, "end_record");
    const createdRecordId = await actionEnd.getByLabel("Employment Record ID").inputValue();
    expect(createdRecordId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(actionEnd.getByLabel("Expected root version")).toHaveValue("2");
    await expect(actionEnd.getByLabel("Expected current effective version")).toHaveValue("1");
    await actionEnd.getByLabel("Exact end date").fill("2029-12-31");
    await submitEmploymentForm(
      actionOperator,
      actionEnd.getByRole("button", { name: "End exact employment record" }),
    );
    await expect(
      actionOperator.page.getByRole("heading", { name: "Last mutation receipt" }),
    ).toBeVisible();
    expect([...new URL(actionOperator.page.url()).searchParams.entries()]).toEqual([
      ["result", "success"],
    ]);
    expect(await actionOperator.page.evaluate(() => document.cookie)).not.toContain(
      "esbla_employment_mutation_receipt",
    );
    await expect(
      actionOperator.page.getByRole("heading", { name: "Effective employment facts" }),
    ).toHaveCount(0);
    await actionOperator.page.reload();
    await expect(
      actionOperator.page.getByRole("heading", { name: "Last mutation receipt" }),
    ).toBeVisible();
    await actionOperator.page.goto(`${actionOperator.origin}/workspace/hr/employment/admin`);
    await expect(
      actionOperator.page.getByRole("heading", { name: "Last mutation receipt" }),
    ).toHaveCount(0);

    await listOperator.page.goto(`${listOperator.origin}/workspace/hr/employment/admin`);
    await expect(
      listOperator.page.getByRole("heading", { name: "Employment records unavailable" }),
    ).toBeVisible();
    for (const operation of ["create_record", "create_version", "end_record"]) {
      await expect(employmentForm(listOperator.page, operation)).toHaveCount(0);
    }

    await readEmployee.page.goto(`${readEmployee.origin}/workspace/hr/employment/admin`);
    for (const operation of ["create_record", "create_version", "end_record"]) {
      await expect(employmentForm(readEmployee.page, operation)).toHaveCount(0);
    }
    await expect(
      readEmployee.page.getByRole("heading", { name: "Employment records unavailable" }),
    ).toBeVisible();
    await readEmployee.page.goto(
      `${readEmployee.origin}/workspace/hr/employment/by-id/70000000-0000-4000-8000-000000000099`,
    );
    await expect(
      readEmployee.page.getByRole("heading", { name: "Employment record not found" }),
    ).toBeVisible();
    await expect(readEmployee.page.getByRole("link", { name: "Back to HR" })).toHaveAttribute(
      "href",
      "/workspace/hr",
    );
    await expect(
      readEmployee.page.getByRole("link", { name: "Back to employment records" }),
    ).toHaveCount(0);
    const backToHr = readEmployee.page.getByRole("link", { name: "Back to HR" });
    await backToHr.focus();
    await readEmployee.page.keyboard.press("Enter");
    await expect(readEmployee.page).toHaveURL(`${readEmployee.origin}/workspace/hr`);
    await expect(readEmployee.page.getByRole("heading", { name: "People and work" })).toBeVisible();

    await actionAdmin.page.goto(`${actionAdmin.origin}/workspace/hr/employment/settings`);
    for (const label of ["Activation version", "Settings version", "Control version"]) {
      await expect(serviceControlFact(actionAdmin.page, label)).toHaveCount(0);
    }
    await expect(actionAdmin.page.getByLabel("Employment type codes")).toHaveValue("");
    await expect(
      actionAdminForm("activate_service").getByLabel("Expected activation version"),
    ).toHaveValue("");

    await submitEmploymentForm(
      actionAdmin,
      actionAdminForm("activate_service").getByRole("button", { name: "Activate service" }),
    );
    await expectActionAdminReceipt({
      activation: "1",
      control: "1",
      settings: "1",
      state: "active",
    });
    expect([...new URL(actionAdmin.page.url()).searchParams.entries()]).toEqual([
      ["result", "success"],
    ]);
    expect(await actionAdmin.page.evaluate(() => document.cookie)).not.toContain(
      "esbla_employment_mutation_receipt",
    );
    await expect(actionAdminForm("activate_service")).toHaveCount(0);
    await expect(
      actionAdminForm("deactivate_service").getByLabel("Expected activation version"),
    ).toHaveValue("1");
    await expect(
      actionAdminForm("configure_service").getByLabel("Expected settings version"),
    ).toHaveValue("1");

    await actionAdmin.page.getByLabel("Employment type codes").fill("standard,temporary");
    await submitEmploymentForm(
      actionAdmin,
      actionAdminForm("configure_service").getByRole("button", {
        name: "Save Employment settings",
      }),
    );
    await expectActionAdminReceipt({
      activation: "1",
      control: "2",
      settings: "2",
      state: "active",
    });
    await expect(
      actionAdminForm("configure_service").getByLabel("Expected settings version"),
    ).toHaveValue("2");
    await expect(actionAdmin.page.getByLabel("Employment type codes")).toHaveValue("");

    await submitEmploymentForm(
      actionAdmin,
      actionAdminForm("deactivate_service").getByRole("button", {
        name: "Deactivate service",
      }),
    );
    await expectActionAdminReceipt({
      activation: "2",
      control: "3",
      settings: "2",
      state: "inactive",
    });
    await expect(actionAdminForm("deactivate_service")).toHaveCount(0);
    await expect(
      actionAdminForm("activate_service").getByLabel("Expected activation version"),
    ).toHaveValue("2");
    await expect(
      actionAdminForm("configure_service").getByRole("button", {
        name: "Save Employment settings",
      }),
    ).toBeDisabled();

    await submitEmploymentForm(
      actionAdmin,
      actionAdminForm("activate_service").getByRole("button", { name: "Activate service" }),
    );
    await expectActionAdminReceipt({
      activation: "3",
      control: "4",
      settings: "2",
      state: "active",
    });
    await expect(
      actionAdminForm("deactivate_service").getByLabel("Expected activation version"),
    ).toHaveValue("3");
    await expect(
      actionAdminForm("configure_service").getByLabel("Expected settings version"),
    ).toHaveValue("2");
    await expect(actionAdmin.page.getByLabel("Employment type codes")).toHaveValue("");
    for (const label of [
      "Activation version",
      "Settings version",
      "Control version",
      "Last updated",
    ]) {
      await expect(serviceControlFact(actionAdmin.page, label)).toHaveCount(0);
    }

    await actionAdmin.page.reload();
    await expectActionAdminReceipt({
      activation: "3",
      control: "4",
      settings: "2",
      state: "active",
    });
    await actionAdmin.page.goto(`${actionAdmin.origin}/workspace/hr/employment/settings`);
    await expect(
      actionAdmin.page.getByRole("heading", { name: "Last mutation receipt" }),
    ).toHaveCount(0);
    await viewAdmin.page.goto(`${viewAdmin.origin}/workspace/hr/employment/settings`);
    await expect(
      viewAdmin.page
        .getByText("Control version", { exact: true })
        .or(
          viewAdmin.page.getByText(
            "No service-control row exists. Activation will create it atomically.",
            { exact: true },
          ),
        ),
    ).toBeVisible();
    for (const operation of ["activate_service", "configure_service", "deactivate_service"]) {
      await expect(employmentForm(viewAdmin.page, operation)).toHaveCount(0);
    }

    await readEmployee.page.goto(
      `${readEmployee.origin}/workspace/hr/shifts/settings?result=success`,
    );
    await expect(
      readEmployee.page.getByRole("heading", { name: "Shifts unavailable" }),
    ).toBeVisible();
    await expect(
      readEmployee.page.locator('form[action="/workspace/hr/shifts/action"]'),
    ).toHaveCount(0);

    await shiftAdmin.page.goto(`${shiftAdmin.origin}/workspace/hr/shifts/settings`);
    await expect(
      shiftAdmin.page.getByRole("heading", { name: "Shift Assignment settings" }),
    ).toBeVisible();
    await expect(shiftAdmin.page.getByLabel("Maximum inclusive roster days")).toHaveValue("14");
    await shiftAdmin.page.getByLabel("Maximum inclusive roster days").fill("21");
    await submitShiftServiceForm("configure_service", "Save Shift settings");
    await expectShiftServiceReceipt({
      activation: "1",
      control: "2",
      settings: "2",
      state: "active",
    });
    await expect(shiftAdmin.page.getByLabel("Maximum inclusive roster days")).toHaveValue("21");
    expect(await shiftAdmin.page.evaluate(() => document.cookie)).not.toContain(
      "esbla_shift_roster_mutation_receipt",
    );
    await shiftAdmin.page.reload();
    await expectShiftServiceReceipt({
      activation: "1",
      control: "2",
      settings: "2",
      state: "active",
    });
    await shiftAdmin.context.clearCookies();
    await shiftAdmin.page.goto(`${shiftAdmin.origin}/workspace/hr/shifts/settings?result=success`);
    await expect(
      shiftAdmin.page.getByText(/service-control action is not confirmed/i),
    ).toBeVisible();
    await shiftAdmin.page.goto(`${shiftAdmin.origin}/workspace/hr/shifts/settings`);
    await expect(shiftAdmin.page.getByLabel("Maximum inclusive roster days")).toHaveValue("21");

    await submitShiftServiceForm("deactivate_service", "Deactivate service");
    await expectShiftServiceReceipt({
      activation: "2",
      control: "3",
      settings: "2",
      state: "inactive",
    });
    await expect(
      shiftServiceForm("configure_service").getByRole("button", { name: "Save Shift settings" }),
    ).toBeDisabled();
    await readEmployee.page.goto(`${readEmployee.origin}/workspace/hr/shifts`);
    await expect(
      readEmployee.page.getByRole("heading", { name: "Shift Assignment inactive" }),
    ).toBeVisible();

    await submitShiftServiceForm("activate_service", "Activate service");
    await expectShiftServiceReceipt({
      activation: "3",
      control: "4",
      settings: "2",
      state: "active",
    });
    await shiftAdmin.page.setViewportSize({ height: 844, width: 390 });
    expect(
      await shiftAdmin.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await readEmployee.page.reload();
    await expect(
      readEmployee.page.getByRole("heading", { name: "Shift Assignment inactive" }),
    ).toHaveCount(0);
  } finally {
    await closeActors(
      actionAdmin,
      actionOperator,
      listOperator,
      readEmployee,
      shiftAdmin,
      viewAdmin,
    );
  }
});

test("Shift roster renders across operator, employee and manager authority", async ({
  browser,
}) => {
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  const submit = async (actor, name) => {
    const button = actor.page.getByRole("button", { name });
    await button.focus();
    await actor.page.keyboard.press("Enter");
    await expect(actor.page).toHaveURL(/result=success/);
  };
  try {
    await operator.page.goto(`${operator.origin}/workspace/hr/shifts/reports?result=success`);
    await expect(
      operator.page.getByRole("heading", { name: "Last Shift action receipt" }),
    ).toHaveCount(0);
    await expect(operator.page.locator("#shift-result")).toContainText("not confirmed");
    await operator.page.goto(`${operator.origin}/workspace/hr/shifts/reports?result=conflict`);
    await expect(operator.page.locator("#shift-result")).toContainText("not confirmed");
    await operator.page.getByText("Create an exact roster period", { exact: true }).click();
    await operator.page.getByLabel("Period start").fill("2028-08-01");
    await operator.page.getByLabel("Period end").fill("2028-08-07");
    await submit(operator, "Create draft roster");
    const created = new URL(operator.page.url());
    const rosterVersionId = created.searchParams.get("rosterVersionId");
    expect(rosterVersionId).toMatch(/^[0-9a-f-]{36}$/);

    const assign = async (workerProfileId) => {
      await operator.page.goto(
        `${operator.origin}/workspace/hr/shifts/reports?rosterVersionId=${rosterVersionId}&rosterVersion=1`,
      );
      await operator.page.getByText("Assign a worker", { exact: true }).click();
      await operator.page.getByLabel("Worker Profile ID").fill(workerProfileId);
      await operator.page.getByLabel("Start instant").fill("2028-08-03T04:00:00Z");
      await operator.page.getByLabel("End instant").fill("2028-08-03T12:00:00Z");
      await submit(operator, "Assign shift");
    };
    await assign(shiftEmployeeWorkerProfileId);

    await operator.page.goto(
      `${operator.origin}/workspace/hr/shifts/reports?rosterVersionId=${rosterVersionId}&rosterVersion=1`,
    );
    await submit(operator, "Publish exact roster");

    await employee.page.setViewportSize({ height: 900, width: 1_280 });
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await employee.page.getByRole("link", { name: "Open My Published Shifts" }).press("Enter");
    const shiftListOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "My shifts",
    });
    await expect(shiftListOverlay).toBeVisible();
    await shiftListOverlay.getByLabel("From date").fill("2028-08-01");
    await shiftListOverlay.getByLabel("Through date").fill("2028-08-07");
    await shiftListOverlay.getByRole("button", { name: "Apply period" }).press("Enter");
    await expect(shiftListOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      /\/workspace\/hr\/shifts\?(?=.*originFocusId=hr-mission-control\.my-published-shifts\.full-screen)(?=.*returnSurface=hr-mission-control)(?=.*from=2028-08-01)(?=.*to=2028-08-07)/,
    );
    await expect(shiftListOverlay.getByText("Asia/Karachi", { exact: true })).toBeVisible();
    await shiftListOverlay.getByRole("link", { name: "View persistent history" }).click();
    const shiftDetailOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "Shift assignment",
    });
    const shiftWorkspace = shiftDetailOverlay.locator('[data-focus-workspace^="hr-shifts-"]');
    await expect(shiftDetailOverlay).toBeVisible();
    await expect(shiftWorkspace).toHaveAttribute("data-focus-layout", "master-detail");
    await expect(shiftWorkspace.locator('[data-focus-pane="master"]')).toBeVisible();
    await expect(shiftWorkspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    await shiftDetailOverlay.getByRole("link", { name: "Back to shifts" }).press("Enter");
    await expect(shiftListOverlay).toBeVisible();

    await employee.page.setViewportSize({ width: 390, height: 844 });
    await shiftListOverlay.getByRole("link", { name: "View persistent history" }).click();
    await expect(shiftDetailOverlay).toBeVisible();
    await expect(shiftWorkspace.locator('[data-focus-pane="master"]')).toBeHidden();
    await expect(shiftWorkspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expect(
      shiftDetailOverlay.getByRole("heading", { name: "Evidence history" }),
    ).toBeVisible();
    await expect(shiftDetailOverlay.locator(".history-list strong")).toHaveText(["active"]);
    await employee.page.reload();
    await expect(employee.page.locator(".history-list strong")).toHaveText(["active"]);

    await manager.page.goto(
      `${manager.origin}/workspace/hr/shifts/reports?rosterVersionId=${rosterVersionId}&status=active`,
    );
    await expect(
      manager.page.getByText(shiftEmployeeWorkerProfileId, { exact: false }),
    ).toBeVisible();

    await operator.page.goto(
      `${operator.origin}/workspace/hr/shifts/reports?rosterVersionId=${rosterVersionId}&status=active`,
    );
    await submit(operator, "Cancel assignment");
    await expect(
      operator.page.getByRole("heading", { name: "Last Shift action receipt" }),
    ).toBeVisible();
    await expect(operator.page.getByText(/cancel confirmed cancelled/)).toBeVisible();
    await operator.page.getByRole("link", { name: "View persistent history" }).click();
    await expect(operator.page.locator(".history-list strong").last()).toHaveText("cancelled");
  } finally {
    await closeActors(employee, manager, operator);
  }
});
test("tenant admin controls Attendance settings while record access remains separate", async ({
  browser,
}) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const actionAdmin = await openActor(
    browser,
    fixture.employmentActionAdminOrigin,
    fixture.employmentActionAdminLabel,
  );
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  const submit = async (actor, name) => {
    const response = actor.page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/attendance/action",
    );
    await actor.page.getByRole("button", { exact: true, name }).click();
    expect((await response).status()).toBe(303);
    await expect(actor.page.locator(".success-banner")).toBeFocused();
  };
  try {
    await actionAdmin.page.goto(`${actionAdmin.origin}/workspace/hr/attendance/settings`);
    await expect(actionAdmin.page.getByLabel("Expected activation version").first()).toBeVisible();
    await submit(actionAdmin, "Activate service");
    await expect(actionAdmin.page.getByLabel("Expected settings version")).toHaveValue("1");
    await actionAdmin.page.getByLabel("Allowed manual observations").selectOption("presence_end");
    await submit(actionAdmin, "Save Attendance settings");
    await submit(actionAdmin, "Deactivate service");
    await expect(actionAdmin.page.getByLabel("Expected activation version")).toHaveValue("2");
    await admin.page.goto(`${admin.origin}/workspace/hr/attendance/settings`);
    await expect(admin.page.getByRole("heading", { name: "Attendance settings" })).toBeVisible();
    await submit(admin, "Activate service");
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");
    await admin.page.getByLabel("Allowed manual observations").selectOption("presence_start");
    await submit(admin, "Save Attendance settings");
    await expect(admin.page.getByLabel("Allowed manual observations")).toHaveValue(
      "presence_start",
    );
    await operator.page.goto(`${operator.origin}/workspace/hr/attendance/reports`);
    await operator.page.getByLabel("Worker profile ID").fill(shiftEmployeeWorkerProfileId);
    await operator.page.getByLabel("Observation").selectOption("presence_end");
    await operator.page.getByLabel("Observed instant").fill("2028-08-03T12:30:00.000Z");
    await operator.page.getByRole("button", { name: "Record attendance" }).press("Enter");
    await expect(operator.page.locator(".form-error-summary")).toContainText(
      "Attendance action was not confirmed",
    );
    await employee.page.goto(`${employee.origin}/workspace/hr/attendance/settings`);
    await expect(
      employee.page.getByRole("heading", { name: "Attendance unavailable" }),
    ).toBeVisible();
    await expect(employee.page.getByRole("heading", { name: "Service lifecycle" })).toHaveCount(0);
    await submit(admin, "Deactivate service");
    await expect(admin.page.locator(".leave-status")).toHaveText("Inactive");
    await employee.page.goto(`${employee.origin}/workspace/hr/attendance`);
    await expect(employee.page.getByRole("heading", { name: "Attendance inactive" })).toBeVisible();
    await submit(admin, "Activate service");
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");
    await admin.page.setViewportSize({ height: 844, width: 390 });
    const fitsViewport = await admin.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    expect(fitsViewport).toBe(true);
  } finally {
    await closeActors(actionAdmin, admin, employee, operator);
  }
});
test("Attendance renders manual facts and persistent correction history by current role", async ({
  browser,
}) => {
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  const period = "from=2028-08-01&to=2028-08-07";
  try {
    await operator.page.goto(`${operator.origin}/workspace/hr/attendance/reports?${period}`);
    await operator.page.getByLabel("Worker profile ID").fill(shiftEmployeeWorkerProfileId);
    await operator.page.getByLabel("Observed instant").fill("2028-08-04T04:30:00.000Z");
    const record = operator.page.getByRole("button", { name: "Record attendance" });
    await record.focus();
    await operator.page.keyboard.press("Enter");
    await expect(operator.page).toHaveURL(
      /\/workspace\/hr\/attendance\/by-id\/[0-9a-f-]+\?returnTo=reports$/,
    );
    const observationId = new URL(operator.page.url()).pathname.split("/").at(-1);
    expect(observationId).toMatch(fixtureId);
    await expect(operator.page.getByRole("heading", { name: "Append a correction" })).toBeVisible();

    await employee.page.setViewportSize({ height: 900, width: 1_280 });
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await employee.page
      .getByRole("link", { name: "Open My Attendance Observations" })
      .press("Enter");
    const attendanceListOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "My attendance",
    });
    await expect(attendanceListOverlay).toBeVisible();
    await attendanceListOverlay.getByLabel("From date").fill("2028-08-01");
    await attendanceListOverlay.getByLabel("Through date").fill("2028-08-07");
    await attendanceListOverlay.getByRole("button", { name: "Apply period" }).press("Enter");
    await expect(attendanceListOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      /\/workspace\/hr\/attendance\?(?=.*originFocusId=hr-mission-control\.my-attendance\.full-screen)(?=.*returnSurface=hr-mission-control)(?=.*from=2028-08-01)(?=.*to=2028-08-07)/,
    );
    const employeeHistory = attendanceListOverlay.getByRole("link", {
      name: "View correction history",
    });
    await employeeHistory.focus();
    await employee.page.keyboard.press("Enter");
    const attendanceDetailOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "Attendance detail",
    });
    const attendanceWorkspace = attendanceDetailOverlay.locator(
      '[data-focus-workspace^="hr-attendance-"]',
    );
    await expect(attendanceDetailOverlay).toBeVisible();
    await expect(attendanceWorkspace).toHaveAttribute("data-focus-layout", "master-detail");
    await expect(attendanceWorkspace.locator('[data-focus-pane="master"]')).toBeVisible();
    await expect(attendanceWorkspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    await expect(
      attendanceDetailOverlay.getByRole("heading", { name: "Append a correction" }),
    ).toHaveCount(0);
    await attendanceDetailOverlay.getByRole("link", { name: "Back to attendance" }).press("Enter");
    await expect(attendanceListOverlay).toBeVisible();

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await attendanceListOverlay.getByRole("link", { name: "View correction history" }).click();
    await expect(attendanceDetailOverlay).toBeVisible();
    await expect(attendanceWorkspace.locator('[data-focus-pane="master"]')).toBeHidden();
    await expect(attendanceWorkspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expect(employee.page).toHaveURL(
      new RegExp(
        `/workspace/hr/attendance/by-id/${observationId}\\?(?=.*returnTo=own)(?=.*originFocusId=hr-mission-control\\.my-attendance\\.full-screen)(?=.*returnSurface=hr-mission-control)`,
      ),
    );
    await expect(
      attendanceDetailOverlay.getByRole("heading", { name: "Append a correction" }),
    ).toHaveCount(0);

    await manager.page.goto(`${manager.origin}/workspace/hr/attendance/reports?${period}`);
    await expect(
      manager.page.getByText(shiftEmployeeWorkerProfileId, { exact: true }),
    ).toBeVisible();
    await manager.page.getByRole("link", { name: "View correction history" }).click();
    await expect(manager.page.getByRole("heading", { name: "Append a correction" })).toHaveCount(0);

    await operator.page.getByLabel("Corrected observation").selectOption("presence_end");
    await operator.page.getByLabel("Corrected instant").fill("2028-08-04T12:30:00.000Z");
    await operator.page.getByLabel("Reason").fill("Rendered correction history");
    const correct = operator.page.getByRole("button", { name: "Append correction" });
    await correct.focus();
    await operator.page.keyboard.press("Enter");
    await expect(operator.page).toHaveURL(
      new RegExp(
        `/workspace/hr/attendance/by-id/${observationId}\\?(?=.*returnTo=reports)(?=.*originFocusId=route-backed-widget-fallback-focus)(?=.*returnSurface=hr-mission-control)`,
      ),
    );
    await expect(
      operator.page.getByText("Rendered correction history", { exact: true }),
    ).toBeVisible();

    await employee.page.reload();
    await expect(
      employee.page.getByText("Rendered correction history", { exact: true }),
    ).toBeVisible();
  } finally {
    await closeActors(employee, manager, operator);
  }
});

test("Shift and Attendance catalogue faces preserve exact routes and current authority", async ({
  browser,
}, testInfo) => {
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  try {
    await operator.page.setViewportSize({ height: 900, width: 1_280 });
    await operator.page.goto(`${operator.origin}/studio/surfaces/surface.mission-control/personal`);
    for (const displayName of [
      "Roster Overview",
      "Roster Publish Queue",
      "Attendance Reports",
      "Attendance Correction Queue",
    ]) {
      const add = operator.page.getByRole("button", { name: `Add ${displayName}` });
      await expect(add).toBeVisible();
      await add.click();
    }
    const saveResponse = operator.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await operator.page.getByRole("button", { name: "Save personal layout" }).click();
    expect((await saveResponse).status()).toBe(200);
    await operator.page.goto(operator.origin);

    const rosterOverview = operator.page.locator(
      '[data-widget-definition="hr.shift.roster-overview"]',
    );
    const publishQueue = operator.page.locator('[data-widget-definition="hr.shift.publish-queue"]');
    const attendanceReports = operator.page.locator(
      '[data-widget-definition="hr.attendance.reports"]',
    );
    const correctionQueue = operator.page.locator(
      '[data-widget-definition="hr.attendance.correction-queue"]',
    );
    for (const widget of [rosterOverview, publishQueue, attendanceReports, correctionQueue]) {
      await expect(widget).toHaveCount(1);
      await expect(widget).toHaveAttribute("data-widget-state", /^(empty|populated)$/);
    }
    await expect(rosterOverview.getByText("Select an exact roster", { exact: true })).toBeVisible();
    await expect(publishQueue.getByText("Create draft roster", { exact: true })).toBeVisible();
    await expect(publishQueue.getByRole("link", { name: /Create draft roster/ })).toHaveAttribute(
      "href",
      "/workspace/hr/shifts/reports",
    );
    await expect(attendanceReports).toHaveAttribute("data-widget-state", "empty");
    await expect(
      attendanceReports.getByText("No report Attendance", { exact: true }),
    ).toBeVisible();
    await expect(correctionQueue).toHaveAttribute("data-widget-state", "empty");
    await expect(correctionQueue.getByText("No correction queue", { exact: true })).toBeVisible();
    await expect(
      attendanceReports.locator('a[href^="/workspace/hr/attendance/by-id/"]'),
    ).toHaveCount(0);
    await expect(correctionQueue.locator('a[href^="/workspace/hr/attendance/by-id/"]')).toHaveCount(
      0,
    );

    const evidencePath = testInfo.outputPath("catalogue-shift-attendance-widgets.png");
    await operator.page.screenshot({ fullPage: false, path: evidencePath });
    await testInfo.attach("catalogue-shift-attendance-widgets", {
      contentType: "image/png",
      path: evidencePath,
    });

    await correctionQueue
      .getByRole("link", { name: "Open Attendance Correction Queue" })
      .press("Enter");
    const attendanceReportsOverlay = operator.page.getByRole("dialog", {
      exact: true,
      name: "Attendance reports",
    });
    await expect(attendanceReportsOverlay).toBeVisible();
    await attendanceReportsOverlay
      .getByLabel("Worker profile ID")
      .fill(shiftEmployeeWorkerProfileId);
    await attendanceReportsOverlay.getByLabel("Observed instant").fill("2026-08-02T09:00:00.000Z");
    await attendanceReportsOverlay.getByRole("button", { name: "Record attendance" }).click();
    const attendanceDetailOverlay = operator.page.getByRole("dialog", {
      exact: true,
      name: "Attendance detail",
    });
    const attendanceFocusWorkspace = attendanceDetailOverlay.locator(
      '[data-focus-workspace="hr-attendance-reports"]',
    );
    await expect(attendanceDetailOverlay).toBeVisible();
    await expect(attendanceFocusWorkspace).toHaveAttribute("data-focus-layout", "master-detail");
    await expect(attendanceFocusWorkspace.locator('[data-focus-pane="master"]')).toBeVisible();
    await expect(attendanceFocusWorkspace.locator('[data-focus-pane="detail"]')).toBeVisible();
    await expect(operator.page).toHaveURL(
      /\/workspace\/hr\/attendance\/by-id\/[0-9a-f-]+\?(?=.*returnTo=reports)(?=.*originFocusId=mission-control\..+\.full-screen)(?=.*returnSurface=mission-control)/,
    );
    await attendanceDetailOverlay
      .getByRole("button", { name: "Close Attendance detail" })
      .press("Enter");
    await expect(operator.page).toHaveURL(operator.origin);
    await waitForShellHydration(operator);

    await operator.page
      .locator('[data-widget-definition="hr.shift.publish-queue"]')
      .getByRole("link", { name: "Open Roster Publish Queue" })
      .press("Enter");
    const shiftReportsOverlay = operator.page.getByRole("dialog", {
      exact: true,
      name: "Report shifts",
    });
    await expect(shiftReportsOverlay).toBeVisible();
    await shiftReportsOverlay.getByText("Create an exact roster period", { exact: true }).click();
    await shiftReportsOverlay.getByLabel("Period start").fill("2029-01-01");
    await shiftReportsOverlay.getByLabel("Period end").fill("2029-01-07");
    await shiftReportsOverlay.getByRole("button", { name: "Create draft roster" }).click();
    await expect(shiftReportsOverlay).toBeVisible();
    await expect(
      shiftReportsOverlay.getByRole("heading", { name: "Last Shift action receipt" }),
    ).toBeVisible();
    await expect(operator.page).toHaveURL(
      /\/workspace\/hr\/shifts\/reports\?(?=.*result=success)(?=.*originFocusId=mission-control\..+\.full-screen)(?=.*returnSurface=mission-control)/,
    );

    const focusEvidencePath = testInfo.outputPath(
      "catalogue-shift-attendance-focus-post-workspaces.png",
    );
    await operator.page.screenshot({ fullPage: false, path: focusEvidencePath });
    await testInfo.attach("catalogue-shift-attendance-focus-post-workspaces", {
      contentType: "image/png",
      path: focusEvidencePath,
    });
    expect(operator.diagnostics.external).toEqual([]);
    expect(operator.diagnostics.page).toEqual([]);
    expect(operator.diagnostics.server).toEqual([]);
    expect(operator.diagnostics.console).toEqual([]);
  } finally {
    await operator.page
      .goto(`${operator.origin}/studio/surfaces/surface.mission-control/personal`)
      .catch(() => undefined);
    const reset = operator.page.getByRole("button", { name: "Restore tenant layout" });
    if (await reset.isEnabled().catch(() => false)) {
      operator.page.once("dialog", (dialog) => dialog.accept());
      await reset.click().catch(() => undefined);
    }
    await closeActors(operator);
  }
});

test("Leave catalogue faces preserve employee and assigned-manager journeys", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const actors = [employee, manager];
  let employeeEligibilityChanged = false;
  try {
    await manager.page.setViewportSize({ height: 900, width: 1_280 });
    await manager.page.goto(`${manager.origin}/studio/surfaces/surface.mission-control/personal`);
    const addAssigned = manager.page.getByRole("button", {
      name: "Add Assigned Leave Approvals",
    });
    await expect(addAssigned).toBeVisible();
    await addAssigned.click();
    const managerSaveResponse = manager.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await manager.page.getByRole("button", { name: "Save personal layout" }).click();
    expect((await managerSaveResponse).status()).toBe(200);
    await manager.page.goto(manager.origin);

    const assigned = manager.page.locator('[data-widget-definition="hr.leave.assigned"]');
    await expect(assigned).toHaveCount(1);
    await expect(assigned).toHaveAttribute("data-widget-state", /^(empty|populated)$/);
    await expect(
      assigned.getByRole("link", { name: "Open Assigned Leave Approvals" }),
    ).toHaveAttribute(
      "href",
      "/workspace/my-work?originFocusId=mission-control.leave-assigned.full-screen&returnSurface=mission-control",
    );
    if ((await assigned.getAttribute("data-widget-state")) === "populated") {
      await expect(assigned.locator('a[href^="/workspace/hr/leave/"]').first()).toBeVisible();
      await expect(assigned.getByRole("button", { name: "Approve leave request" })).toBeVisible();
    } else {
      await expect(
        assigned.getByText("No assigned Leave approvals", { exact: true }),
      ).toBeVisible();
    }

    await employee.page.setViewportSize({ height: 900, width: 1_280 });
    await setEmployeeLeavePresentationEligibility(true, [
      "hr.leave.list_own",
      "hr.leave.submit",
      "hr.leave.view",
    ]);
    employeeEligibilityChanged = true;
    await employee.page.goto(`${employee.origin}/studio/surfaces/surface.mission-control/personal`);
    for (const displayName of ["Leave Request History", "Submit Leave Request"]) {
      const add = employee.page.getByRole("button", { name: `Add ${displayName}` });
      await expect(add).toBeVisible();
      await add.click();
    }
    const employeeSaveResponse = employee.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/presentation/surfaces/surface.mission-control",
    );
    await employee.page.getByRole("button", { name: "Save personal layout" }).click();
    expect((await employeeSaveResponse).status()).toBe(200);
    await employee.page.goto(employee.origin);

    const history = employee.page.locator('[data-widget-definition="hr.leave.history"]');
    const requestForm = employee.page.locator('[data-widget-definition="hr.leave.request-form"]');
    await expect(history).toHaveCount(1);
    await expect(history).toHaveAttribute("data-widget-state", /^(empty|populated)$/);
    await expect(history.getByRole("link", { name: "Open Leave Request History" })).toHaveAttribute(
      "href",
      "/workspace/hr/leave?originFocusId=mission-control.leave-history.full-screen&returnSurface=mission-control",
    );
    if ((await history.getAttribute("data-widget-state")) === "populated") {
      await expect(history.locator('a[href^="/workspace/hr/leave/"]').first()).toBeVisible();
    } else {
      await expect(history.getByText("No Leave history", { exact: true })).toBeVisible();
    }
    await expect(requestForm).toHaveCount(1);
    await expect(requestForm).toHaveAttribute("data-widget-state", "populated");
    await expect(requestForm.getByText("Whole-day V1", { exact: true })).toBeVisible();
    await expect(requestForm.getByRole("link", { name: "Start Leave request" })).toHaveAttribute(
      "href",
      "/workspace/hr/leave/new",
    );

    for (const [name, actor] of [
      ["catalogue-leave-manager", manager],
      ["catalogue-leave-employee", employee],
    ]) {
      const evidencePath = testInfo.outputPath(`${name}.png`);
      await actor.page.screenshot({ fullPage: false, path: evidencePath });
      await testInfo.attach(name, { contentType: "image/png", path: evidencePath });
      expect(actor.diagnostics.external).toEqual([]);
      expect(actor.diagnostics.page).toEqual([]);
      expect(actor.diagnostics.server).toEqual([]);
      expect(actor.diagnostics.console).toEqual([]);
    }
  } finally {
    if (employeeEligibilityChanged) {
      await setEmployeeLeavePresentationEligibility(true, [
        "hr.leave.list_own",
        "hr.leave.view",
      ]).catch(() => undefined);
    }
    for (const actor of actors) {
      await actor.page
        .goto(`${actor.origin}/studio/surfaces/surface.mission-control/personal`)
        .catch(() => undefined);
      const reset = actor.page.getByRole("button", { name: "Restore tenant layout" });
      if (await reset.isEnabled().catch(() => false)) {
        actor.page.once("dialog", (dialog) => dialog.accept());
        await reset.click().catch(() => undefined);
      }
    }
    await closeActors(...actors);
  }
});

test("complete default HR widgets render real attendance, expense, and direct-report products", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  try {
    await operator.page.goto(`${operator.origin}/workspace/hr/attendance/reports`);
    await operator.page.getByLabel("Worker profile ID").fill(shiftEmployeeWorkerProfileId);
    await operator.page.getByLabel("Observed instant").fill(new Date().toISOString());
    await operator.page.getByRole("button", { name: "Record attendance" }).press("Enter");
    await expect(operator.page).toHaveURL(
      /\/workspace\/hr\/attendance\/by-id\/[0-9a-f-]+\?returnTo=reports$/,
    );

    await admin.page.goto(`${admin.origin}/workspace/hr/expenses/settings`);
    const activationResponse = admin.page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/expenses/action",
    );
    await admin.page.getByRole("button", { name: "Activate Expense Claim" }).press("Enter");
    expect((await activationResponse).status()).toBe(303);
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");

    await employee.page.setViewportSize({ height: 900, width: 1_280 });
    await employee.page.goto(employee.origin);
    const attendance = employee.page.locator(
      '[data-surface-instance="mission-control.my-attendance"]:not([data-widget-state="loading"])',
    );
    await expect(attendance).toHaveAttribute(
      "data-widget-definition",
      "hr.attendance.my-observations",
    );
    await expect(attendance.getByText("Start", { exact: true }).first()).toBeVisible();
    await expect(
      attendance.getByRole("link", { name: "Open My Attendance Observations" }),
    ).toHaveAttribute(
      "href",
      "/workspace/hr/attendance?originFocusId=mission-control.my-attendance.full-screen&returnSurface=mission-control",
    );

    const expenses = employee.page.locator(
      '[data-surface-instance="mission-control.my-expenses"]:not([data-widget-state="loading"])',
    );
    await expect(expenses).toHaveAttribute("data-widget-definition", "hr.expense.mine");
    await expect(expenses).toHaveAttribute("data-widget-state", "populated");
    await expect(expenses.getByText(/Minor units · version/).first()).toBeVisible();
    await expect(expenses.getByRole("link", { name: "Open My Expense Claims" })).toHaveAttribute(
      "href",
      "/workspace/hr/expenses?originFocusId=mission-control.my-expenses.full-screen&returnSurface=mission-control",
    );

    await manager.page.setViewportSize({ height: 900, width: 1_280 });
    await manager.page.goto(manager.origin);
    await expect(
      manager.page.locator('[data-surface-instance="mission-control.direct-reports"]'),
    ).toHaveCount(0);

    await admin.page.goto(`${admin.origin}/workspace/hr/profile/settings`);
    await admin.page.getByLabel("Manager visibility").selectOption("minimized");
    const workforceSettingsResponse = admin.page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/profile/settings/action",
    );
    await admin.page.getByRole("button", { name: "Save Workforce settings" }).press("Enter");
    expect((await workforceSettingsResponse).status()).toBe(200);
    await expect(admin.page.getByLabel("Manager visibility")).toHaveValue("minimized");

    await manager.page.reload();
    const directReports = manager.page.locator(
      '[data-surface-instance="mission-control.direct-reports"]:not([data-widget-state="loading"])',
    );
    await expect(directReports).toHaveAttribute(
      "data-widget-definition",
      "hr.workforce.direct-reports",
    );
    await expect(directReports.getByText("BROWSER-EMPLOYMENT-001", { exact: true })).toBeVisible();
    await expect(directReports.getByRole("link", { name: "Open Direct Reports" })).toHaveAttribute(
      "href",
      "/workspace/hr/profile/direct-reports?originFocusId=mission-control.direct-reports.full-screen&returnSurface=mission-control",
    );

    await employee.page.setViewportSize({ height: 844, width: 390 });
    await employee.page.reload();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expect(attendance).toBeVisible();
    await expect(expenses).toBeVisible();
    const evidencePath = testInfo.outputPath("complete-default-hr-widgets-mobile.png");
    await employee.page.screenshot({ fullPage: true, path: evidencePath });
    await testInfo.attach("complete-default-hr-widgets-mobile", {
      contentType: "image/png",
      path: evidencePath,
    });
  } finally {
    await closeActors(admin, employee, manager, operator);
  }
});
