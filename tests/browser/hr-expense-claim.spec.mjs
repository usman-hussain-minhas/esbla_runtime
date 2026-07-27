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

async function closeActor(actor) {
  const closed = await Promise.allSettled([actor.context.close()]);
  expect.soft(actor.diagnostics).toEqual({ console: [], external: [], page: [], server: [] });
  expect.soft(closed[0]?.status).toBe("fulfilled");
}

async function closeActors(...actors) {
  await Promise.all(actors.map((actor) => closeActor(actor)));
}

async function post(actor, buttonName) {
  const button = actor.page.getByRole("button", { exact: true, name: buttonName });
  await expect(button).toBeVisible();
  const [request] = await Promise.all([
    actor.page.waitForRequest(
      (candidate) =>
        candidate.method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/expenses/action",
      { timeout: 20_000 },
    ),
    button.click(),
  ]);
  expect((await request.response())?.status()).toBe(303);
}

async function createAndSubmit(actor, amount, category, description) {
  await actor.page.goto(`${actor.origin}/workspace/hr/expenses`);
  await expect(
    actor.page.getByRole("button", { exact: true, name: "Appearance settings" }),
  ).toBeEnabled();
  const currencyCode = actor.page.getByLabel("ISO currency code");
  await currencyCode.fill("USD");
  await expect(currencyCode).toHaveValue("USD");
  await post(actor, "Create Expense Claim draft");
  await actor.page.getByLabel("Expense date").fill("2029-03-01");
  await actor.page.getByLabel("Category code").fill(category);
  await actor.page.getByLabel("Amount in minor units").fill(String(amount));
  await actor.page.getByLabel("Description").fill(description);
  await post(actor, "Save Expense Claim draft");
  await post(actor, "Submit Expense Claim");
  await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
  return new URL(actor.page.url()).pathname.split("/").at(-1);
}

test("employee creates, edits, submits, and reloads a rendered bounded Expense Claim", async ({
  browser,
}) => {
  const actor = await openActor(
    browser,
    fixture.employmentEmployeeOrigin,
    fixture.employmentEmployeeLabel,
  );
  try {
    await actor.page.getByRole("link", { name: "My Expense Claims" }).click();
    await expect(actor.page.getByRole("heading", { name: "No Expense Claims yet" })).toBeVisible();

    await actor.page.getByLabel("ISO currency code").fill("USD");
    const create = actor.page.getByRole("button", { name: "Create Expense Claim draft" });
    await create.focus();
    await actor.page.keyboard.press("Enter");
    await expect(actor.page).toHaveURL(/\/workspace\/hr\/expenses\?.*edit=[0-9a-f-]+/);
    await expect(actor.page.locator("#expense-result")).toBeFocused();

    await actor.page.getByLabel("Expense date").fill("2029-03-01");
    await actor.page.getByLabel("Category code").fill("other");
    await actor.page.getByLabel("Amount in minor units").fill("12345");
    await actor.page.getByLabel("Description").fill("Bounded ground transport fact");
    await post(actor, "Save Expense Claim draft");
    await expect(actor.page.locator("#expense-result")).toBeFocused();
    await expect(actor.page.getByText("12,345 USD minor units").first()).toBeVisible();
    await expect(actor.page.getByLabel("Description")).toHaveValue("Bounded ground transport fact");

    await post(actor, "Submit Expense Claim");
    await expect(actor.page).toHaveURL(/\/workspace\/hr\/expenses\/by-id\/[0-9a-f-]+/);
    await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
    await expect(actor.page.getByRole("heading", { name: "Version history" })).toBeVisible();
    await expect(actor.page.getByText("Version 1: Submitted")).toBeVisible();
    await expect(actor.page.getByText("Bounded ground transport fact")).toBeVisible();

    await actor.page.reload();
    await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
    await expect(actor.page.getByText("12,345 USD minor units").first()).toBeVisible();
    await actor.page.setViewportSize({ height: 844, width: 390 });
    expect(
      await actor.page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await closeActor(actor);
  }
});

test("manager decisions, employee correction, settings, and deactivation remain rendered and persistent", async ({
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
    const approvedId = await createAndSubmit(employee, 22001, "other", "Expense approval journey");
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    const approval = manager.page
      .getByRole("listitem")
      .filter({ hasText: "22,001 USD minor units" });
    await expect(approval).toContainText("Needs review");
    await approval.getByRole("link", { name: "Review Expense Claim" }).click();
    await expect(manager.page.getByRole("button", { name: "Approve Expense Claim" })).toBeVisible();
    await expect(manager.page.getByRole("button", { name: "Reject Expense Claim" })).toBeVisible();
    await manager.page.getByLabel("Approval note").fill("Current assigned facts reviewed");
    await post(manager, "Approve Expense Claim");
    await expect(manager.page.locator(".leave-status")).toHaveText("Approved");

    await employee.page.goto(
      `${employee.origin}/workspace/hr/expenses/by-id/${approvedId}?returnTo=own`,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Approved");
    await expect(employee.page.getByText("Current assigned facts reviewed")).toBeVisible();
    await post(employee, "Create correction draft");
    await expect(employee.page.locator(".leave-status")).toHaveText("Draft");
    await expect(employee.page.getByText("Version 2: Draft")).toBeVisible();
    await expect(employee.page.getByText("Version 1: Approved")).toBeVisible();
    await employee.page.reload();
    await expect(employee.page.locator(".leave-status")).toHaveText("Draft");

    await admin.page.goto(`${admin.origin}/workspace/hr`);
    await admin.page.getByRole("link", { name: "Expense Claim settings" }).click();
    await expect(admin.page.getByRole("heading", { name: "Expense Claim settings" })).toBeVisible();
    await admin.page.getByLabel("Category codes").fill("travel,other");
    await admin.page.getByLabel("Rejection note").selectOption("false");
    await post(admin, "Save Expense Claim settings");
    await expect(admin.page.locator("#expense-result")).toBeFocused();
    await expect(admin.page.getByLabel("Rejection note")).toHaveValue("false");

    const optionalNoteId = await createAndSubmit(
      employee,
      23002,
      "travel",
      "Optional rejection-note journey",
    );
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    await manager.page
      .getByRole("listitem")
      .filter({ hasText: "23,002 USD minor units" })
      .getByRole("link", { name: "Review Expense Claim" })
      .click();
    await post(manager, "Reject Expense Claim");
    await expect(manager.page.locator(".leave-status")).toHaveText("Rejected");
    await employee.page.goto(
      `${employee.origin}/workspace/hr/expenses/by-id/${optionalNoteId}?returnTo=own`,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Rejected");

    await admin.page.getByLabel("Rejection note").selectOption("true");
    await post(admin, "Save Expense Claim settings");
    await expect(admin.page.getByLabel("Rejection note")).toHaveValue("true");
    await createAndSubmit(employee, 24003, "travel", "Required rejection-note journey");
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    await manager.page
      .getByRole("listitem")
      .filter({ hasText: "24,003 USD minor units" })
      .getByRole("link", { name: "Review Expense Claim" })
      .click();
    await post(manager, "Reject Expense Claim");
    await expect(manager.page.locator(".leave-status")).toHaveText("Submitted");
    await expect(manager.page.locator(".form-error-summary")).toContainText(
      "Currency, lines, dates, categories, or submitted values are invalid",
    );
    await manager.page.getByLabel("Rejection note").fill("Required correction detail");
    await post(manager, "Reject Expense Claim");
    await expect(manager.page.locator(".leave-status")).toHaveText("Rejected");
    await expect(manager.page.getByText("Required correction detail")).toBeVisible();

    await admin.page.goto(`${admin.origin}/workspace/hr/expenses/settings`);
    await post(admin, "Deactivate Expense Claim");
    await expect(admin.page.locator(".leave-status")).toHaveText("Inactive");
    await employee.page.goto(
      `${employee.origin}/workspace/hr/expenses/by-id/${approvedId}?returnTo=own`,
    );
    await expect(
      employee.page.getByRole("heading", { name: "Expense Claim inactive" }),
    ).toBeVisible();
    await manager.page.goto(`${manager.origin}/workspace/my-work`);
    await expect(
      manager.page.getByRole("heading", { name: "Expense Claim approvals unavailable" }),
    ).toBeVisible();
  } finally {
    await closeActors(admin, employee, manager);
  }
});
