import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

test.describe.configure({ mode: "serial" });

async function openActor(browser, origin, label) {
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
    if (requestOrigin !== origin) {
      diagnostics.external.push(requestOrigin);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  return { context, diagnostics, label, origin, page };
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

async function submitLeave(actor, values) {
  await actor.page.goto(`${actor.origin}/workspace/hr/leave/new`);
  await expect(actor.page).toHaveTitle("Esbla");
  await expect(actor.page.getByRole("heading", { name: "New leave request" })).toBeVisible();
  await expect(actor.page.getByLabel("Development identity status")).toHaveText(actor.label);

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
  await expect(actor.page.locator(".leave-status")).toHaveText("Submitted");
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
  await expect(actor.page.getByLabel("Development identity status")).toHaveText(actor.label);
  await expect(
    actor.page.getByRole("heading", { name: "Workspace tasks unavailable" }),
  ).toBeVisible();
  const card = assignedCard(actor.page, leaveRequestId);
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("heading", { name: fixture.employeeDisplayName })).toBeVisible();
  return card;
}

async function expectHistory(actor, status, states) {
  await expect(actor.page.locator(".leave-status")).toHaveText(status);
  await expect(actor.page.locator(".leave-history-item strong")).toHaveText(states);
}

function workforceRecordVersion(page) {
  return page
    .locator(".leave-detail-facts > div")
    .filter({ hasText: "Record version" })
    .locator("dd");
}

test("employee submits, manager approves, and employee reloads durable rendered history", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    const leaveRequestId = await submitLeave(employee, {
      endDate: "2027-03-10",
      reason: "Rendered approval journey",
      startDate: "2027-03-10",
    });
    const card = await openAssignedWork(manager, leaveRequestId);
    const approve = card.getByRole("button", { name: "Approve leave request" });
    await approve.focus();
    await manager.page.keyboard.press("Enter");
    const confirm = card.getByRole("button", { name: "Confirm approval" });
    await expect(confirm).toBeFocused();
    await manager.page.keyboard.press("Enter");
    await expect(manager.page).toHaveURL(
      `${fixture.managerOrigin}/workspace/hr/leave/${leaveRequestId}?returnContext=my-work`,
    );
    await expectHistory(manager, "Approved", ["Submitted", "Approved"]);

    await employee.page.reload();
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

    await operator.page.goto(`${operator.origin}/workspace/hr`);
    await operator.page.getByRole("link", { name: "Workforce administration" }).click();
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
    await employee.page.getByRole("button", { name: "High contrast theme" }).click();
    await expect(employee.page.locator("html")).toHaveAttribute("data-theme", "high-contrast");
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
    await manager.page.goto(`${manager.origin}/workspace/hr`);
    await expect(manager.page.getByRole("link", { name: "Workforce administration" })).toHaveCount(
      0,
    );
    const directReports = manager.page.getByRole("link", { name: "Direct reports" });
    await directReports.focus();
    await manager.page.keyboard.press("Enter");
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
    await manager.page.getByRole("button", { name: "High contrast theme" }).click();
    await expect(manager.page.locator("html")).toHaveAttribute("data-theme", "high-contrast");
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
    await operator.page.goto(`${operator.origin}/workspace/hr`);
    await expect(operator.page.getByRole("link", { name: "Direct reports" })).toHaveCount(0);
    await operator.page.getByRole("link", { name: "Workforce administration" }).click();
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

    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await expect(employee.page.getByRole("link", { name: "Workforce administration" })).toHaveCount(
      0,
    );
    await expect(employee.page.getByRole("link", { name: "Direct reports" })).toHaveCount(0);
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
