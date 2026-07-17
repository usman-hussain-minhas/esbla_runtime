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
