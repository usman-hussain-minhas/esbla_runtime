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

function serviceControlFact(page, label) {
  return page
    .locator(".leave-detail-facts > div")
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

async function submitEmploymentForm(actor, button) {
  const response = actor.page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/workspace/hr/employment/action",
  );
  await button.focus();
  await actor.page.keyboard.press("Enter");
  expect((await response).status()).toBe(303);
  await expect(actor.page).toHaveURL(
    /\/workspace\/hr\/employment\/(admin|settings)\?result=success/,
  );
  await expect(actor.page.locator(".success-banner")).toBeFocused();
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

test("tenant admin configures and controls Workforce Profile without record access", async ({
  browser,
}) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    await admin.page.goto(`${admin.origin}/workspace/hr`);
    await expect(admin.page.getByLabel("Development identity status")).toHaveText(
      fixture.adminLabel,
    );
    await expect(admin.page.getByRole("link", { name: "Workforce administration" })).toHaveCount(0);
    await expect(admin.page.getByRole("link", { name: "Direct reports" })).toHaveCount(0);
    const settingsLink = admin.page.getByRole("link", { name: "Workforce settings" });
    await settingsLink.focus();
    await admin.page.keyboard.press("Enter");
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

    await manager.page.goto(`${manager.origin}/workspace/hr`);
    await expect(manager.page.getByRole("link", { name: "Direct reports" })).toHaveCount(0);
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
    await admin.page.getByRole("button", { name: "High contrast theme" }).click();
    await expect(admin.page.locator("html")).toHaveAttribute("data-theme", "high-contrast");
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
    await manager.page.goto(`${manager.origin}/workspace/hr`);
    await expect(manager.page.getByRole("link", { name: "Employment administration" })).toHaveCount(
      0,
    );
    await expect(manager.page.getByRole("link", { name: "Employment settings" })).toHaveCount(0);

    await operator.page.goto(`${operator.origin}/workspace/hr`);
    const administration = operator.page.getByRole("link", {
      name: "Employment administration",
    });
    await administration.focus();
    await operator.page.keyboard.press("Enter");
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
    await employee.page.getByRole("button", { name: "High contrast theme" }).click();
    await expect(employee.page.locator("html")).toHaveAttribute("data-theme", "high-contrast");
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
    await admin.page.goto(`${admin.origin}/workspace/hr`);
    await expect(admin.page.getByRole("link", { name: "Employment administration" })).toHaveCount(
      0,
    );
    const settings = admin.page.getByRole("link", { name: "Employment settings" });
    await settings.focus();
    await admin.page.keyboard.press("Enter");
    await expect(
      admin.page.getByRole("heading", { name: "Employment Record settings" }),
    ).toBeVisible();
    await expect(admin.page.locator(".leave-status")).toHaveText("Active");
    await expect(admin.page.getByText("BROWSER-EMPLOYMENT-001", { exact: true })).toHaveCount(0);
    await expect(admin.page.getByRole("button", { name: "Dark theme" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await admin.page.getByRole("button", { name: "High contrast theme" }).click();
    await expect(admin.page.locator("html")).toHaveAttribute("data-theme", "high-contrast");

    const settingsVersion = Number(
      await serviceControlFact(admin.page, "Settings version").textContent(),
    );
    await admin.page.getByLabel("Employment type codes").fill("unspecified,standard,temporary");
    await submitEmploymentForm(
      admin,
      admin.page.getByRole("button", { name: "Save Employment settings" }),
    );
    await expect(admin.page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(admin.page.locator(".success-banner")).toHaveCSS("color", "rgb(0, 95, 75)");
    await expect(admin.page.locator(".success-banner > p")).toHaveCSS("color", "rgb(17, 28, 37)");
    await expect(admin.page.locator(".success-banner")).toHaveCSS(
      "outline-color",
      "rgb(0, 76, 132)",
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
    await actionOperator.page.goto(`${actionOperator.origin}/workspace/hr`);
    await expect(
      actionOperator.page.getByRole("link", { name: "Employment administration" }),
    ).toBeVisible();
    await expect(actionOperator.page.getByRole("link", { name: "Report shifts" })).toBeVisible();
    await expect(
      actionOperator.page.getByRole("link", { name: "Open employment facts" }),
    ).toHaveCount(0);
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

    await actionAdmin.page.goto(`${actionAdmin.origin}/workspace/hr`);
    await expect(actionAdmin.page.getByRole("link", { name: "Employment settings" })).toBeVisible();
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

    await readEmployee.page.goto(`${readEmployee.origin}/workspace/hr`);
    await expect(readEmployee.page.getByRole("link", { name: "Shift settings" })).toHaveCount(0);
    await readEmployee.page.goto(
      `${readEmployee.origin}/workspace/hr/shifts/settings?result=success`,
    );
    await expect(
      readEmployee.page.getByRole("heading", { name: "Shifts unavailable" }),
    ).toBeVisible();
    await expect(
      readEmployee.page.locator('form[action="/workspace/hr/shifts/action"]'),
    ).toHaveCount(0);

    await shiftAdmin.page.goto(`${shiftAdmin.origin}/workspace/hr`);
    await expect(shiftAdmin.page.getByRole("link", { name: "Shift settings" })).toBeVisible();
    await shiftAdmin.page.getByRole("link", { name: "Shift settings" }).click();
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
    await employee.page.goto(`${employee.origin}/workspace/hr`);
    await expect(employee.page.getByRole("link", { name: "Report shifts" })).toHaveCount(0);
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

    await employee.page.setViewportSize({ width: 390, height: 844 });
    await employee.page.goto(
      `${employee.origin}/workspace/hr/shifts?from=2028-08-01&to=2028-08-07`,
    );
    await expect(employee.page.getByText("Asia/Karachi", { exact: true })).toBeVisible();
    expect(
      await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await employee.page.getByRole("link", { name: "View persistent history" }).click();
    await expect(employee.page.getByRole("heading", { name: "Evidence history" })).toBeVisible();
    await expect(employee.page.locator(".history-list strong")).toHaveText(["active"]);
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
