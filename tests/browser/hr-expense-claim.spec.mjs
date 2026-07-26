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

async function post(actor, buttonName) {
  const response = actor.page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/workspace/hr/expenses/action",
  );
  await actor.page.getByRole("button", { exact: true, name: buttonName }).click();
  expect((await response).status()).toBe(303);
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
