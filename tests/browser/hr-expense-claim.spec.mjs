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

async function closeActor(actor) {
  const closed = await Promise.allSettled([actor.context.close()]);
  expect.soft(actor.diagnostics).toEqual({ console: [], external: [], page: [], server: [] });
  expect.soft(closed[0]?.status).toBe("fulfilled");
}

async function closeActors(...actors) {
  await Promise.all(actors.map((actor) => closeActor(actor)));
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
        new URL(candidate.url()).pathname === "/workspace/hr/expenses/action",
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
  await expect(actor.page.locator("#expense-result")).toBeFocused();
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
  const actor = await openActor(browser, fixture.employmentEmployeeOrigin);
  try {
    await actor.page.goto(`${actor.origin}/workspace/hr/expenses`);
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

test("own Expense Claim cursor survives draft edit and submission", async ({ browser }) => {
  const actor = await openActor(browser, fixture.employmentEmployeeOrigin);
  const cursorCreatedAt = "2099-12-31T23:59:59.999Z";
  const cursorExpenseClaimId = "ffffffff-ffff-8fff-bfff-ffffffffffff";
  try {
    await actor.page.goto(`${actor.origin}/workspace/hr/expenses`);
    await actor.page.getByLabel("ISO currency code").fill("USD");
    await post(actor, "Create Expense Claim draft");
    const expenseClaimId = new URL(actor.page.url()).searchParams.get("edit");
    expect(expenseClaimId).toMatch(/^[0-9a-f-]+$/);

    const cursorQuery = new URLSearchParams({
      cursorCreatedAt,
      cursorExpenseClaimId,
      edit: expenseClaimId,
    });
    await actor.page.goto(`${actor.origin}/workspace/hr/expenses?${cursorQuery}`);
    const editHref = await actor.page
      .locator(`a[href*="edit=${expenseClaimId}"]`)
      .first()
      .getAttribute("href");
    expect(new URL(editHref, actor.origin).searchParams.get("cursorCreatedAt")).toBe(
      cursorCreatedAt,
    );
    expect(new URL(editHref, actor.origin).searchParams.get("cursorExpenseClaimId")).toBe(
      cursorExpenseClaimId,
    );

    await actor.page.getByLabel("Expense date").fill("2029-03-02");
    await actor.page.getByLabel("Category code").fill("other");
    await actor.page.getByLabel("Amount in minor units").fill("12346");
    await post(actor, "Save Expense Claim draft");
    expect(new URL(actor.page.url()).searchParams.get("cursorCreatedAt")).toBe(cursorCreatedAt);
    expect(new URL(actor.page.url()).searchParams.get("cursorExpenseClaimId")).toBe(
      cursorExpenseClaimId,
    );

    await post(actor, "Submit Expense Claim");
    expect(new URL(actor.page.url()).searchParams.get("cursorCreatedAt")).toBe(cursorCreatedAt);
    expect(new URL(actor.page.url()).searchParams.get("cursorExpenseClaimId")).toBe(
      cursorExpenseClaimId,
    );
    const backHref = await actor.page
      .getByRole("link", { exact: true, name: "Back to Expense Claims" })
      .getAttribute("href");
    expect(new URL(backHref, actor.origin).searchParams.get("cursorCreatedAt")).toBe(
      cursorCreatedAt,
    );
    expect(new URL(backHref, actor.origin).searchParams.get("cursorExpenseClaimId")).toBe(
      cursorExpenseClaimId,
    );
  } finally {
    await closeActor(actor);
  }
});

test("Expense and My Work focus workspaces preserve one nested Product journey", async ({
  browser,
}, testInfo) => {
  const employee = await openActor(browser, fixture.employmentEmployeeOrigin);
  const manager = await openActor(browser, fixture.managerOrigin);
  try {
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    const expenseLauncher = employee.page.getByRole("link", {
      exact: true,
      name: "Open My Expense Claims workspace",
    });
    await expenseLauncher.click();
    const expenseList = employee.page.getByRole("dialog", {
      exact: true,
      name: "My Expense Claims",
    });
    await expect(expenseList).toBeVisible();
    await expect(expenseList.locator('[data-focus-workspace="hr-expense-list"]')).toHaveAttribute(
      "data-focus-layout",
      "single",
    );

    await expenseList.getByLabel("ISO currency code").fill("USD");
    await post(employee, "Create Expense Claim draft");
    const expenseClaimId = new URL(employee.page.url()).searchParams.get("edit");
    expect(expenseClaimId).toMatch(/^[0-9a-f-]+$/);
    await expenseList.getByLabel("Expense date").fill("2029-03-01");
    await expenseList.getByLabel("Category code").fill("other");
    await expenseList.getByLabel("Amount in minor units").fill("21009");
    await expenseList.getByLabel("Description").fill("Route-backed focus journey");
    await post(employee, "Save Expense Claim draft");
    await post(employee, "Submit Expense Claim");
    await expect(employee.page).toHaveURL(
      new RegExp(
        `/workspace/hr/expenses/by-id/${expenseClaimId}\\?returnTo=own&result=current&originFocusId=hr-mission-control\\.my-expenses\\.full-screen&returnSurface=surface\\.hr\\.mission-control&originWidgetDefinitionId=hr\\.expense\\.mine#expense-result$`,
      ),
    );
    const expenseDetail = employee.page.getByRole("dialog", {
      exact: true,
      name: "Expense Claim detail",
    });
    await expect(expenseDetail).toBeVisible();
    await expect(expenseDetail.locator('[data-focus-workspace="hr-expense-own"]')).toHaveAttribute(
      "data-focus-layout",
      "master-detail",
    );
    await expect(
      expenseDetail.getByRole("link", { exact: true, name: "Back to Expense Claims" }),
    ).toBeVisible();
    await expect(expenseDetail.getByText("Route-backed focus journey")).toBeVisible();
    const employeeEvidence = testInfo.outputPath("expense-focus-master-detail.png");
    await employee.page.screenshot({ fullPage: false, path: employeeEvidence });
    await testInfo.attach("expense-focus-master-detail", {
      contentType: "image/png",
      path: employeeEvidence,
    });
    await expenseDetail
      .getByRole("button", { exact: true, name: "Close Expense Claim detail" })
      .click();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr`);

    await employee.page.goto(employee.origin);
    const compactExpenseRow = employee.page
      .locator('[data-widget-definition="hr.expense.mine"]')
      .locator(`a[href^="/workspace/hr/expenses/by-id/${expenseClaimId}?"]`);
    const compactExpenseFocusId = `mission-control.my-expenses.${expenseClaimId}`;
    await expect(compactExpenseRow).toHaveAttribute("id", compactExpenseFocusId);
    await expect(compactExpenseRow).toHaveAttribute(
      "href",
      `/workspace/hr/expenses/by-id/${expenseClaimId}?returnTo=own&originFocusId=${compactExpenseFocusId}&returnSurface=surface.mission-control&originWidgetDefinitionId=hr.expense.mine`,
    );
    await compactExpenseRow.click();
    const compactExpenseDetail = employee.page.getByRole("dialog", {
      exact: true,
      name: "Expense Claim detail",
    });
    await expect(compactExpenseDetail).toBeVisible();
    await compactExpenseDetail
      .getByRole("button", { exact: true, name: "Close Expense Claim detail" })
      .click();
    await expect(employee.page).toHaveURL(employee.origin);
    await expect(employee.page.locator(`[id="${compactExpenseFocusId}"]`)).toBeFocused();

    await manager.page.goto(`${manager.origin}/workspace/hr`);
    await manager.page.getByRole("link", { exact: true, name: "Open My Work workspace" }).click();
    const myWork = manager.page.getByRole("dialog", { exact: true, name: "My Work" });
    await expect(myWork).toBeVisible();
    const assignedExpense = myWork
      .getByRole("listitem")
      .filter({ hasText: "21,009 USD minor units" });
    await assignedExpense.getByRole("link", { exact: true, name: "Review Expense Claim" }).click();
    const assignedDetail = manager.page.getByRole("dialog", {
      exact: true,
      name: "Expense Claim detail",
    });
    await expect(assignedDetail).toBeVisible();
    await expect(
      assignedDetail.locator('[data-focus-workspace="hr-expense-my-work"]'),
    ).toHaveAttribute("data-focus-layout", "master-detail");
    await expect(
      assignedDetail.getByRole("link", { exact: true, name: "Back to My Work" }),
    ).toBeVisible();
    await assignedDetail.getByLabel("Approval note").fill("Focused approval continuity");
    await post(manager, "Approve Expense Claim");
    await expect
      .poll(() => new URL(manager.page.url()).searchParams.get("returnContext"))
      .toBe("my-work");
    expect(new URL(manager.page.url()).searchParams.get("returnTo")).toBeNull();
    await expect
      .poll(() => new URL(manager.page.url()).searchParams.get("returnSurface"))
      .toBe("surface.hr.mission-control");
    expect(new URL(manager.page.url()).searchParams.get("originWidgetDefinitionId")).toBe(
      "platform.my-work.queue",
    );
    const decidedDetail = manager.page.getByRole("dialog", {
      exact: true,
      name: "Expense Claim detail",
    });
    await expect(
      decidedDetail.locator('[data-focus-workspace="hr-expense-my-work"]'),
    ).toHaveAttribute("data-focus-layout", "master-detail");
    await expect(decidedDetail.locator(".history-list li").first()).toContainText(
      "Approved — 21,009 USD minor units",
    );
    await manager.page.goBack();
    await expect(manager.page.getByRole("dialog", { exact: true, name: "My Work" })).toBeVisible();
    await expect(manager.page).toHaveURL(/\/workspace\/my-work\?/);
    await manager.page.goForward();
    await expect(
      manager.page
        .getByRole("dialog", { exact: true, name: "Expense Claim detail" })
        .locator('[data-focus-workspace="hr-expense-my-work"]'),
    ).toHaveAttribute("data-focus-layout", "master-detail");
    await manager.page.setViewportSize({ height: 844, width: 390 });
    await expect(decidedDetail.locator('[data-focus-pane="master"]')).toHaveCSS("display", "none");
    await expect(decidedDetail.locator('[data-focus-pane="detail"]')).toBeVisible();
    expect(
      await manager.page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await closeActors(employee, manager);
  }
});

test("manager decisions, employee correction, settings, and deactivation remain rendered and persistent", async ({
  browser,
}) => {
  const admin = await openActor(browser, fixture.adminOrigin);
  const employee = await openActor(browser, fixture.employmentEmployeeOrigin);
  const manager = await openActor(browser, fixture.managerOrigin);
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

    const correctionCursorCreatedAt = "2099-12-31T23:59:59.999Z";
    const correctionCursorExpenseClaimId = "ffffffff-ffff-8fff-bfff-ffffffffffff";
    await employee.page.goto(
      `${employee.origin}/workspace/hr/expenses/by-id/${approvedId}?${new URLSearchParams({
        cursorCreatedAt: correctionCursorCreatedAt,
        cursorExpenseClaimId: correctionCursorExpenseClaimId,
        returnTo: "own",
      })}`,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Approved");
    await expect(employee.page.getByText("Current assigned facts reviewed")).toBeVisible();
    await post(employee, "Create correction draft");
    expect(new URL(employee.page.url()).searchParams.get("cursorCreatedAt")).toBe(
      correctionCursorCreatedAt,
    );
    expect(new URL(employee.page.url()).searchParams.get("cursorExpenseClaimId")).toBe(
      correctionCursorExpenseClaimId,
    );
    await expect(employee.page.locator(".leave-status")).toHaveText("Draft");
    await expect(employee.page.getByText("Version 2: Draft")).toBeVisible();
    await expect(employee.page.getByText("Version 1: Approved")).toBeVisible();
    await employee.page.reload();
    await expect(employee.page.locator(".leave-status")).toHaveText("Draft");

    await admin.page.goto(`${admin.origin}/workspace/hr/expenses/settings`);
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
