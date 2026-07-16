import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isExactActorRequest } from "../../scripts/test/hr-browser-harness.mjs";

const playwrightRequire = createRequire(
  new URL("../../scripts/test/browser-tooling/package.json", import.meta.url),
);
const { expect, test } = playwrightRequire("@playwright/test");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredAbsolutePath(name) {
  const value = required(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requiredLoopbackOrigin(name) {
  const value = required(name);
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an uncredentialed loopback origin`);
  }
  return url.origin;
}

function requiredUuid(name) {
  const value = required(name);
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

const fixture = {
  artifactDirectory: requiredAbsolutePath("ESBLA_E2E_ARTIFACT_DIR"),
  employeeDisplayName: required("ESBLA_E2E_EMPLOYEE_DISPLAY_NAME"),
  employeeLabel: required("ESBLA_E2E_EMPLOYEE_LABEL"),
  employeeOrigin: requiredLoopbackOrigin("ESBLA_E2E_EMPLOYEE_ORIGIN"),
  leaveReason: required("ESBLA_E2E_LEAVE_REASON"),
  leaveRequestId: requiredUuid("ESBLA_E2E_LEAVE_REQUEST_ID"),
  managerLabel: required("ESBLA_E2E_MANAGER_LABEL"),
  managerOrigin: requiredLoopbackOrigin("ESBLA_E2E_MANAGER_ORIGIN"),
};

if (fixture.employeeOrigin === fixture.managerOrigin) {
  throw new Error("Employee and manager browser origins must be distinct");
}
if (fixture.employeeLabel === fixture.managerLabel) {
  throw new Error("Employee and manager identity labels must be distinct");
}

function emptyDiagnostics() {
  return {
    consoleErrors: [],
    guardViolations: [],
    pageErrors: [],
    requestFailures: [],
    unexpectedHttp: [],
  };
}

function safeRequestDescription(request) {
  const url = new URL(request.url());
  return `${request.method()} ${url.origin}${url.pathname}`;
}

async function guardReadOnlyLoopbackPage(page, diagnostics, actorOrigin) {
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(`${error.name}: ${error.message}`);
  });
  page.on("request", (request) => {
    if (!isExactActorRequest(request.url(), request.method(), actorOrigin)) {
      diagnostics.guardViolations.push(safeRequestDescription(request));
    }
  });
  page.on("websocket", (socket) => {
    diagnostics.guardViolations.push(`WEBSOCKET ${new URL(socket.url()).origin}`);
  });
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push(
      `${safeRequestDescription(request)}: ${request.failure()?.errorText ?? "unknown failure"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.unexpectedHttp.push(
        `${response.status()} ${safeRequestDescription(response.request())}`,
      );
    }
  });

  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!isExactActorRequest(request.url(), request.method(), actorOrigin)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.routeWebSocket("**/*", async (socket) => {
    diagnostics.guardViolations.push(`WEBSOCKET ${new URL(socket.url()).origin}`);
    await socket.close({ code: 1008, reason: "Browser smoke is HTTP read-only" });
  });
}

function assertCleanDiagnostics(actor, diagnostics) {
  expect.soft(diagnostics.consoleErrors, `${actor} console errors`).toEqual([]);
  expect
    .soft(diagnostics.guardViolations, `${actor} non-loopback or mutating requests`)
    .toEqual([]);
  expect.soft(diagnostics.pageErrors, `${actor} page errors`).toEqual([]);
  expect.soft(diagnostics.requestFailures, `${actor} request failures`).toEqual([]);
  expect.soft(diagnostics.unexpectedHttp, `${actor} unexpected HTTP responses`).toEqual([]);
}

async function writeSanitizedObservations(employeeStatus, managerStatus, employee, manager) {
  const counts = (diagnostics) => ({
    consoleErrorCount: diagnostics.consoleErrors.length,
    guardViolationCount: diagnostics.guardViolations.length,
    pageErrorCount: diagnostics.pageErrors.length,
    requestFailureCount: diagnostics.requestFailures.length,
    unexpectedHttpCount: diagnostics.unexpectedHttp.length,
  });
  const observations = {
    employee: {
      responseStatus: employeeStatus,
      ...counts(employee),
    },
    manager: {
      responseStatus: managerStatus,
      ...counts(manager),
    },
    schemaVersion: 1,
  };

  await mkdir(fixture.artifactDirectory, { recursive: true });
  await writeFile(
    path.join(fixture.artifactDirectory, "browser-observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

test("employee own list and manager assigned work render the same submitted leave request", async ({
  browser,
}) => {
  const employeeDiagnostics = emptyDiagnostics();
  const managerDiagnostics = emptyDiagnostics();
  const employeeContext = await browser.newContext({ serviceWorkers: "block" });
  const managerContext = await browser.newContext({ serviceWorkers: "block" });
  const employeePage = await employeeContext.newPage();
  const managerPage = await managerContext.newPage();
  await guardReadOnlyLoopbackPage(employeePage, employeeDiagnostics, fixture.employeeOrigin);
  await guardReadOnlyLoopbackPage(managerPage, managerDiagnostics, fixture.managerOrigin);

  let employeeResponseStatus = null;
  let managerResponseStatus = null;

  try {
    const [employeeNavigation, managerNavigation] = await Promise.allSettled([
      employeePage.goto(`${fixture.employeeOrigin}/workspace/hr/leave`, {
        waitUntil: "networkidle",
      }),
      managerPage.goto(`${fixture.managerOrigin}/workspace/my-work`, {
        waitUntil: "networkidle",
      }),
    ]);

    expect.soft(employeeNavigation.status, "employee navigation succeeds").toBe("fulfilled");
    expect.soft(managerNavigation.status, "manager navigation succeeds").toBe("fulfilled");
    employeeResponseStatus =
      employeeNavigation.status === "fulfilled"
        ? (employeeNavigation.value?.status() ?? null)
        : null;
    managerResponseStatus =
      managerNavigation.status === "fulfilled" ? (managerNavigation.value?.status() ?? null) : null;
    expect.soft(employeeResponseStatus, "employee document response").toBe(200);
    expect.soft(managerResponseStatus, "manager document response").toBe(200);

    await expect
      .soft(employeePage.getByRole("heading", { exact: true, name: "My Leave Requests" }))
      .toBeVisible();
    await expect
      .soft(employeePage.getByLabel("Development identity status"))
      .toHaveText(fixture.employeeLabel);
    const employeeLink = employeePage.getByRole("link", { exact: true, name: "View details" });
    const employeeHref = `/workspace/hr/leave/${fixture.leaveRequestId}?returnContext=leave-list`;

    await expect
      .soft(managerPage.getByRole("heading", { exact: true, name: "Assigned work" }))
      .toBeVisible();
    await expect
      .soft(managerPage.getByLabel("Development identity status"))
      .toHaveText(fixture.managerLabel);
    const managerLink = managerPage.getByRole("link", { exact: true, name: "Review details" });
    const managerHref = `/workspace/hr/leave/${fixture.leaveRequestId}?returnContext=my-work`;
    const [employeeLinkCount, managerLinkCount] = await Promise.all([
      employeeLink.count(),
      managerLink.count(),
    ]);
    expect
      .soft(
        employeeLinkCount,
        "employee own list contains the deterministic submitted fixture href",
      )
      .toBe(1);
    expect
      .soft(
        managerLinkCount,
        "manager assigned list contains the same deterministic submitted fixture href",
      )
      .toBe(1);

    assertCleanDiagnostics("employee", employeeDiagnostics);
    assertCleanDiagnostics("manager", managerDiagnostics);
    if (employeeLinkCount !== 1 || managerLinkCount !== 1) return;

    await expect.soft(employeeLink).toHaveAttribute("href", employeeHref);
    const employeeRow = employeePage.locator("tbody tr").filter({ has: employeeLink });
    await expect.soft(employeeRow).toHaveCount(1);
    await expect.soft(employeeRow.locator(".leave-status")).toHaveText("submitted");
    await expect.soft(employeeRow.getByRole("cell", { exact: true, name: "Annual" })).toBeVisible();
    await expect
      .soft(employeeRow.getByRole("cell", { exact: true, name: "Aug 18, 2026" }))
      .toBeVisible();

    await expect.soft(managerLink).toHaveAttribute("href", managerHref);
    const managerCard = managerPage
      .locator('ol[aria-label="Assigned leave approvals"] > li')
      .filter({ has: managerLink });
    await expect.soft(managerCard).toHaveCount(1);
    await expect
      .soft(managerCard.getByRole("heading", { exact: true, name: fixture.employeeDisplayName }))
      .toBeVisible();
    await expect.soft(managerCard.locator(".work-queue-kicker")).toHaveText("Annual leave");
    await expect.soft(managerCard.locator(".work-queue-dates")).toHaveText("Aug 18, 2026");
    await expect.soft(managerCard.locator(".work-status")).toHaveText("Needs review");
    await expect.soft(managerCard.locator(".work-queue-reason")).toHaveText(fixture.leaveReason);
    await expect.soft(managerCard.getByText("Open", { exact: true })).toBeVisible();

    const [renderedEmployeeHref, renderedManagerHref] = await Promise.all([
      employeeLink.getAttribute("href"),
      managerLink.getAttribute("href"),
    ]);
    expect
      .soft(renderedEmployeeHref?.split("?")[0], "employee request path")
      .toBe(`/workspace/hr/leave/${fixture.leaveRequestId}`);
    expect
      .soft(renderedManagerHref?.split("?")[0], "manager request path")
      .toBe(`/workspace/hr/leave/${fixture.leaveRequestId}`);
  } finally {
    try {
      await writeSanitizedObservations(
        employeeResponseStatus,
        managerResponseStatus,
        employeeDiagnostics,
        managerDiagnostics,
      );
    } finally {
      await Promise.allSettled([employeeContext.close(), managerContext.close()]);
    }
  }
});
