import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

async function openActor(browser, origin) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const diagnostics = { console: [], external: [], page: [], server: [] };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.console.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.page.push(`${error.name}: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) diagnostics.server.push(response.status());
  });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      diagnostics.external.push(new URL(route.request().url()).origin);
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  await page.goto(`${origin}/workspace/hr`);
  await expect(page.locator(".esbla-shell")).toHaveAttribute(
    "data-current-surface",
    "surface.hr.mission-control",
  );
  return { context, diagnostics, origin, page };
}

async function closeActors(...actors) {
  const closed = await Promise.allSettled(actors.map((actor) => actor.context.close()));
  for (const [index, actor] of actors.entries()) {
    expect.soft(actor.diagnostics).toEqual({ console: [], external: [], page: [], server: [] });
    expect.soft(closed[index]?.status).toBe("fulfilled");
  }
}

async function postLocation(response, routeBacked) {
  if (!routeBacked) {
    expect(response.status()).toBe(303);
    const location = response.headers().location;
    expect(location).toBeTruthy();
    return location;
  }
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()).toBe(
    "application/json",
  );
  const payload = await response.json();
  expect(Object.keys(payload)).toEqual(["location"]);
  expect(payload.location).toMatch(/^\/(?!\/)/);
  return payload.location;
}

async function post(actor, buttonName) {
  const button = actor.page.getByRole("button", { exact: true, name: buttonName });
  await expect(button).toBeEnabled();
  const form = button.locator("xpath=ancestor::form");
  const routeBacked = (await form.getAttribute("data-route-backed-post")) === "true";
  const submittedIdempotencyKey = await form.locator('input[name="idempotencyKey"]').inputValue();
  await expect(async () => {
    await button.focus();
    await expect(button).toBeFocused({ timeout: 250 });
    await actor.page.waitForTimeout(75);
    await expect(button).toBeFocused({ timeout: 250 });
  }).toPass({ intervals: [50, 100, 250, 500], timeout: 10_000 });
  const [response] = await Promise.all([
    actor.page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/timesheets/action",
      { timeout: 20_000 },
    ),
    button.click(),
  ]);
  const location = await postLocation(response, routeBacked);
  await expect
    .poll(
      () =>
        actor.page
          .locator('input[name="idempotencyKey"]')
          .evaluateAll(
            (inputs, consumedKey) =>
              inputs.some(
                (input) => input instanceof HTMLInputElement && input.value === consumedKey,
              ),
            submittedIdempotencyKey,
          ),
      { timeout: 20_000 },
    )
    .toBe(false);
  await expect(actor.page).toHaveURL(new URL(location, actor.origin).toString());
  await expect(actor.page.locator("#timesheet-result")).toBeFocused();
}

async function createAndSubmit(actor, periodStart, periodEnd, workDate, description) {
  await actor.page.goto(`${actor.origin}/workspace/hr/timesheets`);
  await expect(
    actor.page.getByRole("button", { exact: true, name: "Appearance settings" }),
  ).toBeEnabled();
  const periodStarts = actor.page.getByLabel("Period starts");
  const periodEnds = actor.page.getByLabel("Period ends");
  await periodStarts.fill(periodStart);
  await periodEnds.fill(periodEnd);
  await expect(periodStarts).toHaveValue(periodStart);
  await expect(periodEnds).toHaveValue(periodEnd);
  await post(actor, "Create Timesheet draft");
  await actor.page.getByLabel("Work date").first().fill(workDate);
  await actor.page.getByLabel("Minutes").first().fill("480");
  await actor.page.getByLabel("Description").first().fill(description);
  await post(actor, "Save Timesheet draft");
  await post(actor, "Submit Timesheet");
  await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
  return new URL(actor.page.url()).pathname.split("/").at(-1);
}

test("HR Timesheet widget opens a route-backed full-screen form and protects dirty work", async ({
  browser,
}, testInfo) => {
  const actor = await openActor(browser, fixture.employmentEmployeeOrigin);
  const admin = await openActor(browser, fixture.adminOrigin);
  let deactivated = false;
  try {
    await actor.page.setViewportSize({ height: 500, width: 1280 });
    const launcher = actor.page.getByRole("link", {
      exact: true,
      name: "Open My Timesheets",
    });
    await expect(launcher).toHaveAttribute(
      "href",
      "/workspace/hr/timesheets?originFocusId=hr-mission-control.my-timesheets.full-screen&returnSurface=hr-mission-control",
    );
    await actor.page.locator(".surface-scroll").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await launcher.scrollIntoViewIfNeeded();
    await launcher.focus();
    const originScrollTop = await actor.page
      .locator(".surface-scroll")
      .evaluate((element) => Math.round(element.scrollTop));
    expect(originScrollTop).toBeGreaterThan(0);
    await launcher.press("Enter");
    await expect(actor.page).toHaveURL(
      `${actor.origin}/workspace/hr/timesheets?originFocusId=hr-mission-control.my-timesheets.full-screen&returnSurface=hr-mission-control`,
    );

    const overlay = actor.page.getByRole("dialog", {
      exact: true,
      name: "My Timesheets",
    });
    await expect(overlay).toBeVisible();
    await expect(overlay).toBeFocused();
    await expect(overlay.locator('[data-widget-definition="hr.timesheet.draft"]')).toBeVisible();
    await expect(
      overlay.getByRole("button", { exact: true, name: "Create Timesheet draft" }),
    ).toBeEnabled();
    await expect(actor.page.locator(".esbla-shell")).toHaveAttribute("aria-hidden", "true");
    await expect(actor.page.locator(".esbla-shell")).toHaveAttribute("inert", "");

    const close = overlay.getByRole("button", {
      exact: true,
      name: "Close My Timesheets",
    });
    const cleanOrigin = actor.page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        response.url() === `${actor.origin}/workspace/hr`,
    );
    await close.click();
    expect((await cleanOrigin).status()).toBe(200);
    await actor.page.waitForLoadState("load");
    await expect(actor.page).toHaveURL(`${actor.origin}/workspace/hr`);
    await expect(launcher).toBeFocused();
    await expect
      .poll(() =>
        actor.page.locator(".surface-scroll").evaluate((element) => Math.round(element.scrollTop)),
      )
      .toBe(originScrollTop);
    await launcher.press("Enter");
    await expect(overlay).toBeVisible();
    await expect(overlay).toBeFocused();

    const evidencePath = testInfo.outputPath("timesheet-route-backed-full-screen.png");
    await actor.page.screenshot({ fullPage: false, path: evidencePath });
    await testInfo.attach("timesheet-route-backed-full-screen", {
      contentType: "image/png",
      path: evidencePath,
    });

    await overlay.getByLabel("Period starts").fill("2029-01-01");
    actor.page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toBe("Discard unsaved changes and close this full-screen view?");
      await dialog.dismiss();
    });
    await close.click();
    await expect(overlay).toBeVisible();

    let dismissedBack = false;
    actor.page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toBe("Discard unsaved changes and close this full-screen view?");
      dismissedBack = true;
      await dialog.dismiss();
    });
    await actor.page.evaluate(() => window.history.back());
    await expect.poll(() => dismissedBack).toBe(true);
    await expect(overlay).toBeVisible();

    await admin.page.goto(`${admin.origin}/workspace/hr/timesheets/settings`);
    await post(admin, "Deactivate Timesheet");
    deactivated = true;
    await expect(admin.page.locator(".leave-status")).toHaveText("Inactive");

    let acceptedBack = false;
    actor.page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toBe("Discard unsaved changes and close this full-screen view?");
      acceptedBack = true;
      await dialog.accept();
    });
    const revalidatedOrigin = actor.page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        response.url() === `${actor.origin}/workspace/hr`,
    );
    await actor.page.evaluate(() => window.history.back());
    await expect.poll(() => acceptedBack).toBe(true);
    expect((await revalidatedOrigin).status()).toBe(200);
    await actor.page.waitForLoadState("load");
    await expect(actor.page).toHaveURL(`${actor.origin}/workspace/hr`);
    await expect(overlay).toHaveCount(0);
    await expect(
      actor.page.getByRole("link", { exact: true, name: "Open My Timesheets" }),
    ).toHaveCount(0);
    await expect(actor.page.locator("main h1")).toBeFocused();

    await admin.page.goto(`${admin.origin}/workspace/hr/timesheets/settings`);
    await post(admin, "Activate Timesheet");
    deactivated = false;
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");
  } finally {
    if (deactivated) {
      await admin.page.goto(`${admin.origin}/workspace/hr/timesheets/settings`);
      const activate = admin.page.getByRole("button", {
        exact: true,
        name: "Activate Timesheet",
      });
      if ((await activate.count()) > 0) await post(admin, "Activate Timesheet");
    }
    await closeActors(actor, admin);
  }
});

test("employee creates, edits, submits, and reloads a rendered weekly Timesheet", async ({
  browser,
}) => {
  const actor = await openActor(browser, fixture.employmentEmployeeOrigin);
  try {
    await actor.page.goto(`${actor.origin}/workspace/hr/timesheets`);
    await expect(actor.page.getByRole("heading", { name: "No Timesheets yet" })).toBeVisible();

    await actor.page.getByLabel("Period starts").fill("2029-01-01");
    await actor.page.getByLabel("Period ends").fill("2029-01-07");
    const create = actor.page.getByRole("button", { name: "Create Timesheet draft" });
    await create.focus();
    await actor.page.keyboard.press("Enter");
    await expect(actor.page).toHaveURL(/\/workspace\/hr\/timesheets\?.*edit=[0-9a-f-]+/);
    await expect(actor.page.locator("#timesheet-result")).toBeFocused();

    await actor.page.getByLabel("Work date").first().fill("2029-01-01");
    await actor.page.getByLabel("Minutes").first().fill("480");
    await actor.page.getByLabel("Description").first().fill("Bounded internal work");
    await actor.page.getByRole("button", { name: "Save Timesheet draft" }).click();
    await expect(actor.page.locator("#timesheet-result")).toBeFocused();
    await expect(actor.page.getByText("8h 0m").first()).toBeVisible();

    const submit = actor.page.getByRole("button", { name: "Submit Timesheet" });
    const response = actor.page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/timesheets/action",
    );
    await submit.click();
    expect((await response).status()).toBe(303);
    await expect(actor.page).toHaveURL(/\/workspace\/hr\/timesheets\/by-id\/[0-9a-f-]+/);
    await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
    await expect(actor.page.getByRole("heading", { name: "Version history" })).toBeVisible();
    await expect(actor.page.getByText("Version 1: Submitted")).toBeVisible();
    const timesheetId = new URL(actor.page.url()).pathname.split("/").at(-1);
    expect(timesheetId).toMatch(/^[0-9a-f-]+$/);

    await actor.page.reload();
    await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
    await expect(actor.page.getByText("Bounded internal work")).toBeVisible();

    await actor.page.goto(actor.origin);
    const compactTimesheetRow = actor.page
      .locator('[data-widget-definition="hr.timesheet.mine"]')
      .locator(`a[href^="/workspace/hr/timesheets/by-id/${timesheetId}?"]`);
    const compactTimesheetFocusId = `mission-control.my-timesheets.${timesheetId}`;
    await expect(compactTimesheetRow).toHaveAttribute("id", compactTimesheetFocusId);
    await expect(compactTimesheetRow).toHaveAttribute(
      "href",
      `/workspace/hr/timesheets/by-id/${timesheetId}?returnTo=own&originFocusId=${compactTimesheetFocusId}&returnSurface=mission-control`,
    );
    await compactTimesheetRow.click();
    const compactTimesheetDetail = actor.page.getByRole("dialog", {
      exact: true,
      name: "Timesheet detail",
    });
    await expect(compactTimesheetDetail).toBeVisible();
    await compactTimesheetDetail
      .getByRole("button", { exact: true, name: "Close Timesheet detail" })
      .click();
    await expect(actor.page).toHaveURL(actor.origin);
    await expect(actor.page.locator(`[id="${compactTimesheetFocusId}"]`)).toBeFocused();

    await actor.page.setViewportSize({ height: 844, width: 390 });
    expect(
      await actor.page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await closeActors(actor);
  }
});

test("own Timesheet cursor survives draft edit and submission", async ({ browser }) => {
  const actor = await openActor(browser, fixture.employmentEmployeeOrigin);
  const cursorPeriodStart = "2099-12-31";
  const cursorTimesheetId = "ffffffff-ffff-8fff-bfff-ffffffffffff";
  try {
    await actor.page.goto(`${actor.origin}/workspace/hr/timesheets`);
    await actor.page.getByLabel("Period starts").fill("2029-04-02");
    await actor.page.getByLabel("Period ends").fill("2029-04-08");
    await post(actor, "Create Timesheet draft");
    const timesheetId = new URL(actor.page.url()).searchParams.get("edit");
    expect(timesheetId).toMatch(/^[0-9a-f-]+$/);

    const cursorQuery = new URLSearchParams({
      cursorPeriodStart,
      cursorTimesheetId,
      edit: timesheetId,
    });
    await actor.page.goto(`${actor.origin}/workspace/hr/timesheets?${cursorQuery}`);
    const editHref = await actor.page
      .locator(`a[href*="edit=${timesheetId}"]`)
      .first()
      .getAttribute("href");
    expect(new URL(editHref, actor.origin).searchParams.get("cursorPeriodStart")).toBe(
      cursorPeriodStart,
    );
    expect(new URL(editHref, actor.origin).searchParams.get("cursorTimesheetId")).toBe(
      cursorTimesheetId,
    );

    await actor.page.getByLabel("Work date").first().fill("2029-04-02");
    await actor.page.getByLabel("Minutes").first().fill("480");
    await actor.page.getByLabel("Description").first().fill("Cursor continuity");
    await post(actor, "Save Timesheet draft");
    expect(new URL(actor.page.url()).searchParams.get("cursorPeriodStart")).toBe(cursorPeriodStart);
    expect(new URL(actor.page.url()).searchParams.get("cursorTimesheetId")).toBe(cursorTimesheetId);

    await post(actor, "Submit Timesheet");
    expect(new URL(actor.page.url()).searchParams.get("cursorPeriodStart")).toBe(cursorPeriodStart);
    expect(new URL(actor.page.url()).searchParams.get("cursorTimesheetId")).toBe(cursorTimesheetId);
    const backHref = await actor.page
      .getByRole("link", { exact: true, name: "Back to Timesheets" })
      .getAttribute("href");
    expect(new URL(backHref, actor.origin).searchParams.get("cursorPeriodStart")).toBe(
      cursorPeriodStart,
    );
    expect(new URL(backHref, actor.origin).searchParams.get("cursorTimesheetId")).toBe(
      cursorTimesheetId,
    );
  } finally {
    await closeActors(actor);
  }
});

test("HR operator creates one explicit correction successor with persistent history", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employmentEmployeeOrigin);
  const manager = await openActor(browser, fixture.managerOrigin);
  const operator = await openActor(browser, fixture.operatorOrigin);
  try {
    const timesheetId = await createAndSubmit(
      employee,
      "2029-01-08",
      "2029-01-14",
      "2029-01-08",
      "Correction journey",
    );
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    await manager.page
      .getByRole("listitem")
      .filter({ hasText: "2029-01-08 to 2029-01-14" })
      .getByRole("link", { name: "Review Timesheet" })
      .click();
    await manager.page.getByLabel("Approval note").fill("Terminal predecessor");
    await post(manager, "Approve Timesheet");
    await expect(manager.page.locator(".leave-status")).toHaveText("Approved");

    await operator.page.goto(`${operator.origin}/workspace/hr/timesheets/admin/corrections`);
    await expect(
      operator.page.getByRole("heading", { name: "Timesheet corrections" }),
    ).toBeVisible();
    await operator.page.getByLabel("Timesheet ID").fill(timesheetId);
    await operator.page.getByRole("button", { name: "Open Timesheet" }).click();
    await expect(operator.page).toHaveURL(
      new RegExp(`/workspace/hr/timesheets/by-id/${timesheetId}\\?returnTo=corrections`),
    );
    await expect(operator.page.locator(".leave-status")).toHaveText("Approved");
    await expect(operator.page.getByText("Version 1: Approved")).toBeVisible();
    await post(operator, "Create correction draft");
    await expect(operator.page.locator(".leave-status")).toHaveText("Draft");
    await expect(operator.page.getByText("Version 2: Draft")).toBeVisible();
    await expect(operator.page.getByText("Version 1: Approved")).toBeVisible();
    await expect(operator.page.getByText("Terminal predecessor")).toBeVisible();

    await employee.page.goto(
      `${employee.origin}/workspace/hr/timesheets/by-id/${timesheetId}?returnTo=own`,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Draft");
    await expect(employee.page.getByText("Version 2: Draft")).toBeVisible();
    await expect(employee.page.getByText("Version 1: Approved")).toBeVisible();
    await employee.page.reload();
    await expect(employee.page.locator(".leave-status")).toHaveText("Draft");

    await employee.page.goto(`${employee.origin}/workspace/hr/timesheets/admin/corrections`);
    await expect(
      employee.page.getByRole("heading", { name: "Timesheet unavailable" }),
    ).toBeVisible();
  } finally {
    await closeActors(employee, manager, operator);
  }
});

test("manager decides assigned Timesheets and tenant settings alter rejection behavior", async ({
  browser,
}) => {
  const admin = await openActor(browser, fixture.adminOrigin);
  const employee = await openActor(browser, fixture.employmentEmployeeOrigin);
  const manager = await openActor(browser, fixture.managerOrigin);
  try {
    const approvedId = await createAndSubmit(
      employee,
      "2029-02-05",
      "2029-02-11",
      "2029-02-05",
      "Approval journey",
    );
    await manager.page.goto(`${manager.origin}/workspace/hr`);
    await manager.page.getByRole("link", { exact: true, name: "Open My Work" }).click();
    const focusedMyWork = manager.page.getByRole("dialog", { exact: true, name: "My Work" });
    await expect(focusedMyWork).toBeVisible();
    const approval = focusedMyWork
      .getByRole("listitem")
      .filter({ hasText: "2029-02-05 to 2029-02-11" });
    await expect(approval).toContainText("Needs review");
    await approval.getByRole("link", { name: "Review Timesheet" }).click();
    await expect(manager.page.getByRole("button", { name: "Approve Timesheet" })).toBeVisible();
    await expect(manager.page.getByRole("button", { name: "Reject Timesheet" })).toBeVisible();
    await manager.page.getByLabel("Approval note").fill("Reviewed current work-time facts");
    await post(manager, "Approve Timesheet");
    const decisionDialog = manager.page.getByRole("dialog", {
      exact: true,
      name: "Timesheet detail",
    });
    await expect(decisionDialog.locator(".leave-status")).toHaveText("Approved");
    await expect(decisionDialog.getByText("Version 1: Approved")).toBeVisible();
    await expect
      .poll(() => new URL(manager.page.url()).searchParams.get("returnContext"))
      .toBe("my-work");
    expect(new URL(manager.page.url()).searchParams.get("returnTo")).toBeNull();
    await expect
      .poll(() => new URL(manager.page.url()).searchParams.get("returnSurface"))
      .toBe("hr-mission-control");
    const focusedDetail = manager.page.getByRole("dialog", {
      exact: true,
      name: "Timesheet detail",
    });
    await expect(
      focusedDetail.locator('[data-focus-workspace="hr-timesheet-my-work"]'),
    ).toHaveAttribute("data-focus-layout", "master-detail");
    await expect(focusedDetail.locator(".history-list li").first()).toContainText(
      "Approved — 8h 0m",
    );
    await manager.page.goBack();
    await expect(manager.page.getByRole("dialog", { exact: true, name: "My Work" })).toBeVisible();
    await expect(manager.page).toHaveURL(/\/workspace\/my-work\?/);
    await manager.page.goForward();
    await expect(
      manager.page
        .getByRole("dialog", { exact: true, name: "Timesheet detail" })
        .locator('[data-focus-workspace="hr-timesheet-my-work"]'),
    ).toHaveAttribute("data-focus-layout", "master-detail");

    await employee.page.goto(
      `${employee.origin}/workspace/hr/timesheets/by-id/${approvedId}?returnTo=own`,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Approved");
    await expect(employee.page.getByText("Reviewed current work-time facts")).toBeVisible();

    await admin.page.goto(`${admin.origin}/workspace/hr/timesheets/settings`);
    await expect(admin.page.getByRole("heading", { name: "Timesheet settings" })).toBeVisible();
    await admin.page.getByLabel("Rejection note").selectOption("false");
    await post(admin, "Save Timesheet settings");
    await expect(admin.page.locator("#timesheet-result")).toBeFocused();
    await expect(admin.page.getByLabel("Rejection note")).toHaveValue("false");

    const optionalNoteId = await createAndSubmit(
      employee,
      "2029-02-12",
      "2029-02-18",
      "2029-02-12",
      "Optional rejection note journey",
    );
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    await manager.page
      .getByRole("listitem")
      .filter({ hasText: "2029-02-12 to 2029-02-18" })
      .getByRole("link", { name: "Review Timesheet" })
      .click();
    await post(manager, "Reject Timesheet");
    await expect(manager.page.locator(".leave-status")).toHaveText("Rejected");
    await employee.page.goto(
      `${employee.origin}/workspace/hr/timesheets/by-id/${optionalNoteId}?returnTo=own`,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Rejected");

    await admin.page.getByLabel("Rejection note").selectOption("true");
    await post(admin, "Save Timesheet settings");
    await expect(admin.page.getByLabel("Rejection note")).toHaveValue("true");
    await createAndSubmit(
      employee,
      "2029-02-19",
      "2029-02-25",
      "2029-02-19",
      "Required rejection note journey",
    );
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    await manager.page
      .getByRole("listitem")
      .filter({ hasText: "2029-02-19 to 2029-02-25" })
      .getByRole("link", { name: "Review Timesheet" })
      .click();
    await post(manager, "Reject Timesheet");
    await expect(manager.page.locator(".leave-status")).toHaveText("Submitted");
    await expect(manager.page.locator(".form-error-summary")).toContainText(
      "Dates, entries, or submitted values are invalid",
    );
    await manager.page.getByLabel("Rejection note").fill("Required correction detail");
    await post(manager, "Reject Timesheet");
    await expect(manager.page.locator(".leave-status")).toHaveText("Rejected");
    await expect(manager.page.getByText("Required correction detail")).toBeVisible();

    await admin.page.goto(`${admin.origin}/workspace/hr/timesheets/settings`);
    await post(admin, "Deactivate Timesheet");
    await expect(admin.page.locator(".leave-status")).toHaveText("Inactive");
    await employee.page.goto(
      `${employee.origin}/workspace/hr/timesheets/by-id/${approvedId}?returnTo=own`,
    );
    await expect(employee.page.getByRole("heading", { name: "Timesheet inactive" })).toBeVisible();
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    await expect(
      manager.page.getByRole("heading", { name: "Timesheet approvals unavailable" }),
    ).toBeVisible();
  } finally {
    await closeActors(admin, employee, manager);
  }
});
