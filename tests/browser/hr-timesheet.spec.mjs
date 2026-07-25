import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

async function openActor(browser, origin, label) {
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
  await expect(page.getByLabel("Development identity status")).toHaveText(label);
  return { context, diagnostics, origin, page };
}

async function closeActors(...actors) {
  const closed = await Promise.allSettled(actors.map((actor) => actor.context.close()));
  for (const [index, actor] of actors.entries()) {
    expect.soft(actor.diagnostics).toEqual({ console: [], external: [], page: [], server: [] });
    expect.soft(closed[index]?.status).toBe("fulfilled");
  }
}

async function post(actor, buttonName) {
  const response = actor.page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/workspace/hr/timesheets/action",
  );
  await actor.page.getByRole("button", { exact: true, name: buttonName }).click();
  expect((await response).status()).toBe(303);
}

async function createAndSubmit(actor, periodStart, periodEnd, workDate, description) {
  await actor.page.goto(`${actor.origin}/workspace/hr/timesheets`);
  await actor.page.getByLabel("Period starts").fill(periodStart);
  await actor.page.getByLabel("Period ends").fill(periodEnd);
  await post(actor, "Create Timesheet draft");
  await actor.page.getByLabel("Work date").first().fill(workDate);
  await actor.page.getByLabel("Minutes").first().fill("480");
  await actor.page.getByLabel("Description").first().fill(description);
  await post(actor, "Save Timesheet draft");
  await post(actor, "Submit Timesheet");
  await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
  return new URL(actor.page.url()).pathname.split("/").at(-1);
}

test("employee creates, edits, submits, and reloads a rendered weekly Timesheet", async ({
  browser,
}) => {
  const actor = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  try {
    await actor.page.getByRole("link", { name: "My Timesheets" }).click();
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

    await actor.page.reload();
    await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
    await expect(actor.page.getByText("Bounded internal work")).toBeVisible();
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

test("HR operator creates one explicit correction successor with persistent history", async ({
  browser,
}) => {
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
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

    await operator.page.goto(`${operator.origin}/workspace/hr`);
    await operator.page.getByRole("link", { name: "Timesheet corrections" }).click();
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
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const employee = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    const approvedId = await createAndSubmit(
      employee,
      "2029-02-05",
      "2029-02-11",
      "2029-02-05",
      "Approval journey",
    );
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    const approval = manager.page
      .getByRole("listitem")
      .filter({ hasText: "2029-02-05 to 2029-02-11" });
    await expect(approval).toContainText("Needs review");
    await approval.getByRole("link", { name: "Review Timesheet" }).click();
    await expect(manager.page.getByRole("button", { name: "Approve Timesheet" })).toBeVisible();
    await expect(manager.page.getByRole("button", { name: "Reject Timesheet" })).toBeVisible();
    await manager.page.getByLabel("Approval note").fill("Reviewed current work-time facts");
    await post(manager, "Approve Timesheet");
    await expect(manager.page.locator(".leave-status")).toHaveText("Approved");
    await expect(manager.page.getByText("Version 1: Approved")).toBeVisible();

    await employee.page.goto(
      `${employee.origin}/workspace/hr/timesheets/by-id/${approvedId}?returnTo=own`,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Approved");
    await expect(employee.page.getByText("Reviewed current work-time facts")).toBeVisible();

    await admin.page.goto(`${admin.origin}/workspace/hr`);
    await admin.page.getByRole("link", { name: "Timesheet settings" }).click();
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
