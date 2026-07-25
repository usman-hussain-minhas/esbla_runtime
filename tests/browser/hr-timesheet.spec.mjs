import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

async function openEmployee(browser) {
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
    if (new URL(route.request().url()).origin !== fixture.employmentEmployeeOrigin) {
      diagnostics.external.push(new URL(route.request().url()).origin);
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  return { context, diagnostics, page };
}

test("employee creates, edits, submits, and reloads a rendered weekly Timesheet", async ({
  browser,
}) => {
  const actor = await openEmployee(browser);
  try {
    await actor.page.goto(`${fixture.employmentEmployeeOrigin}/workspace/hr`);
    await expect(actor.page.getByLabel("Development identity status")).toHaveText(
      fixture.employmentEmployeeLabel,
    );
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
    const [closed] = await Promise.allSettled([actor.context.close()]);
    expect.soft(actor.diagnostics).toEqual({ console: [], external: [], page: [], server: [] });
    expect.soft(closed?.status).toBe("fulfilled");
  }
});
