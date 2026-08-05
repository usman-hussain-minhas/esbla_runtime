import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

test.describe.configure({ mode: "serial" });

const testControlOrigin = process.env.ESBLA_TEST_CONTROL_ORIGIN;
const testControlToken = process.env.ESBLA_TEST_CONTROL_TOKEN;
if (
  testControlOrigin !== "http://127.0.0.1:41900" ||
  !/^[0-9a-f]{64}$/.test(testControlToken ?? "")
) {
  throw new Error("Browser test control is missing");
}

const managerSurfaces = [
  {
    heading: "Workforce",
    instanceIds: ["hr-workforce.direct-reports"],
    pathname: "/workspace/hr/workforce",
    surfaceId: "surface.hr.workforce",
  },
  {
    heading: "Time & Scheduling",
    instanceIds: [
      "hr-time-and-scheduling.roster-overview",
      "hr-time-and-scheduling.attendance-reports",
      "hr-time-and-scheduling.timesheet-assigned",
    ],
    pathname: "/workspace/hr/time-and-scheduling",
    surfaceId: "surface.hr.time-and-scheduling",
  },
  {
    heading: "Requests & Claims",
    instanceIds: [
      "hr-requests-and-claims.leave-assigned",
      "hr-requests-and-claims.expense-assigned",
    ],
    pathname: "/workspace/hr/requests-and-claims",
    surfaceId: "surface.hr.requests-and-claims",
  },
];

const employeeLeaveCapabilities = ["hr.leave.list_own", "hr.leave.view"];
const employeeRequestInstanceIds = [
  "hr-requests-and-claims.my-leave",
  "hr-requests-and-claims.leave-history",
];

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

async function setEmployeeLeavePresentationEligibility(active) {
  expect(
    await testControl("/__esbla-test-control/leave-presentation-eligibility", {
      active,
      capabilities: employeeLeaveCapabilities,
    }),
  ).toEqual({ status: "updated" });
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

async function ensureAttendanceActive(actor) {
  await actor.page.goto(`${actor.origin}/workspace/hr/attendance/settings`, {
    waitUntil: "networkidle",
  });
  const activate = actor.page.getByRole("button", { exact: true, name: "Activate service" });
  if (await activate.isVisible()) {
    const response = actor.page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/workspace/hr/attendance/action",
    );
    await activate.click();
    expect((await response).status()).toBe(303);
  }
  await expect(actor.page.locator(".leave-status")).toHaveText("Active");
}

async function consumeExpectedDocumentNotFound(actor) {
  const message = "Failed to load resource: the server responded with a status of 404 (Not Found)";
  await expect
    .poll(() => actor.diagnostics.console.filter((entry) => entry === message).length)
    .toBe(1);
  actor.diagnostics.console.splice(actor.diagnostics.console.indexOf(message), 1);
}

function surfaceHost(page, surfaceId) {
  return page.locator(`[data-presentation-surface-id="${surfaceId}"]`);
}

async function waitForSettledWidgets(host) {
  await expect
    .poll(async () =>
      host.locator("[data-surface-instance]").evaluateAll((widgets) =>
        widgets.every((widget) => {
          const state = widget.getAttribute("data-widget-state");
          return state !== "loading" && state !== "stale_retrying";
        }),
      ),
    )
    .toBe(true);
}

async function readReadySurface(page, surface) {
  const host = surfaceHost(page, surface.surfaceId);
  await expect(host).toHaveCount(1);
  await expect(host).toHaveAttribute("data-presentation-surface-state", "ready");
  await expect(host).toHaveAttribute("data-layout-source", "code_default");
  await expect(host).toHaveAttribute("data-base-version", "1");
  await expect(host).toHaveAttribute("data-overlay-version", "0");
  await expect(
    host.getByRole("heading", { exact: true, level: 1, name: surface.heading }),
  ).toBeVisible();
  await expect(page.locator(".surface-scroll")).toHaveCount(1);
  await expect(page.locator(".zen-section-navigation")).toHaveCount(0);
  const instanceIds = await host
    .locator("[data-surface-instance]")
    .evaluateAll((widgets) =>
      widgets.map((widget) => widget.getAttribute("data-surface-instance")),
    );
  expect(instanceIds).toEqual(surface.instanceIds);
  await waitForSettledWidgets(host);

  return {
    baseVersion: await host.getAttribute("data-base-version"),
    instanceIds: await host
      .locator("[data-surface-instance]")
      .evaluateAll((widgets) =>
        widgets.map((widget) => widget.getAttribute("data-surface-instance")),
      ),
    layoutSource: await host.getAttribute("data-layout-source"),
    overlayVersion: await host.getAttribute("data-overlay-version"),
    state: await host.getAttribute("data-presentation-surface-state"),
  };
}

async function assertNotFoundSurface(page, surface, forbiddenLabels) {
  await expect(surfaceHost(page, surface.surfaceId)).toHaveCount(0);
  await expect(page.locator("[data-surface-instance]")).toHaveCount(0);
  await expect(page.locator("[data-widget-definition]")).toHaveCount(0);
  await expect(page.locator(".zen-section-navigation")).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  for (const label of forbiddenLabels) {
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  }
  const body = await page.locator("body").innerText();
  for (const instanceId of surface.instanceIds) {
    expect(body).not.toContain(instanceId);
  }
}

test("manager receives exact ordered widgets on every registered HR operating surface", async ({
  browser,
}) => {
  const admin = await openActor(browser, fixture.adminOrigin, fixture.adminLabel);
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    await ensureAttendanceActive(admin);
    for (const surface of managerSurfaces) {
      const response = await manager.page.goto(`${manager.origin}${surface.pathname}`, {
        waitUntil: "networkidle",
      });
      expect(response?.status()).toBe(200);
      await expect(manager.page).toHaveURL(`${manager.origin}${surface.pathname}`);
      const beforeReload = await readReadySurface(manager.page, surface);

      await manager.page.reload({ waitUntil: "networkidle" });
      await expect(manager.page).toHaveURL(`${manager.origin}${surface.pathname}`);
      expect(await readReadySurface(manager.page, surface)).toEqual(beforeReload);
    }
  } finally {
    await closeActors(admin, manager);
  }
});

test("employee access fails closed and Requests & Claims survives deactivation and restoration", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const timeSurface = managerSurfaces[1];
  const requestsSurface = {
    ...managerSurfaces[2],
    instanceIds: employeeRequestInstanceIds,
  };
  let leaveRestored = false;
  try {
    await setEmployeeLeavePresentationEligibility(true);

    const deniedResponse = await employee.page.goto(`${employee.origin}${timeSurface.pathname}`, {
      waitUntil: "networkidle",
    });
    expect(deniedResponse?.status()).toBe(404);
    await consumeExpectedDocumentNotFound(employee);
    await assertNotFoundSurface(employee.page, timeSurface, [
      "Roster Overview",
      "Assigned Timesheets",
    ]);

    const activeResponse = await employee.page.goto(
      `${employee.origin}${requestsSurface.pathname}`,
      { waitUntil: "networkidle" },
    );
    expect(activeResponse?.status()).toBe(200);
    const activeReceipt = await readReadySurface(employee.page, requestsSurface);

    await setEmployeeLeavePresentationEligibility(false);
    const inactiveResponse = await employee.page.reload({ waitUntil: "networkidle" });
    expect(inactiveResponse?.status()).toBe(404);
    await consumeExpectedDocumentNotFound(employee);
    await assertNotFoundSurface(employee.page, requestsSurface, [
      "My Leave Requests",
      "Leave Request History",
    ]);

    await setEmployeeLeavePresentationEligibility(true);
    leaveRestored = true;
    const restoredResponse = await employee.page.reload({ waitUntil: "networkidle" });
    expect(restoredResponse?.status()).toBe(200);
    expect(await readReadySurface(employee.page, requestsSurface)).toEqual(activeReceipt);
  } finally {
    if (!leaveRestored) await setEmployeeLeavePresentationEligibility(true);
    await closeActors(employee);
  }
});
