import { expect, test } from "@playwright/test";
import { fixture } from "./hr-leave-fixture.mjs";

test.describe.configure({ mode: "serial" });

const hrSurfaces = [
  {
    heading: "People and work",
    href: "/workspace/hr",
    label: "HR Mission Control",
    surfaceId: "surface.hr.mission-control",
  },
  {
    heading: "Workforce",
    href: "/workspace/hr/workforce",
    label: "Workforce",
    surfaceId: "surface.hr.workforce",
  },
  {
    heading: "Time & Scheduling",
    href: "/workspace/hr/time-and-scheduling",
    label: "Time & Scheduling",
    surfaceId: "surface.hr.time-and-scheduling",
  },
  {
    heading: "Requests & Claims",
    href: "/workspace/hr/requests-and-claims",
    label: "Requests & Claims",
    surfaceId: "surface.hr.requests-and-claims",
  },
];

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

async function closeActor(actor) {
  expect.soft(actor.diagnostics.console, `${actor.label} console errors`).toEqual([]);
  expect.soft(actor.diagnostics.external, `${actor.label} external requests`).toEqual([]);
  expect.soft(actor.diagnostics.page, `${actor.label} page errors`).toEqual([]);
  expect.soft(actor.diagnostics.server, `${actor.label} server errors`).toEqual([]);
  await actor.context.close();
}

async function openHrSurfaceMenu(page) {
  const launcher = page.getByRole("button", { exact: true, name: "HR surfaces" });
  await expect(launcher).toBeVisible();
  await launcher.click();
  const menu = page.getByRole("navigation", { exact: true, name: "HR surfaces" });
  await expect(menu).toBeVisible();
  return menu;
}

test("manager receives only the exact ordered HR surfaces and can activate each one", async ({
  browser,
}) => {
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    await manager.page.setViewportSize({ height: 900, width: 1_440 });
    await manager.page.goto(`${manager.origin}/workspace/hr`, { waitUntil: "networkidle" });
    for (const surface of hrSurfaces) {
      const menu = await openHrSurfaceMenu(manager.page);
      expect(
        await menu.getByRole("link").evaluateAll((links) =>
          links.map((link) => ({
            href: link.getAttribute("href"),
            label: link.textContent?.trim(),
          })),
        ),
      ).toEqual(hrSurfaces.map(({ href, label }) => ({ href, label })));

      await menu.getByRole("link", { exact: true, name: surface.label }).click();
      await manager.page.waitForLoadState("networkidle");
      await expect(manager.page).toHaveURL(`${manager.origin}${surface.href}`);
      await expect(
        manager.page.getByRole("heading", { exact: true, level: 1, name: surface.heading }),
      ).toBeVisible();
      if (surface.surfaceId !== "surface.hr.mission-control") {
        await expect(
          manager.page.locator(`[data-presentation-surface-id="${surface.surfaceId}"]`),
        ).toHaveAttribute("data-presentation-surface-state", "ready");
      }
    }
  } finally {
    await closeActor(manager);
  }
});

test("Settings, Studio and shortcut chrome preserve exact surface identity and suppress self links", async ({
  browser,
}) => {
  const manager = await openActor(browser, fixture.managerOrigin, fixture.managerLabel);
  try {
    await manager.page.setViewportSize({ height: 900, width: 1_440 });
    const workforce = hrSurfaces[1];
    await manager.page.goto(`${manager.origin}${workforce.href}`, { waitUntil: "networkidle" });

    for (const scope of ["Universal shortcuts", "Workforce surface shortcuts"]) {
      const launcher = manager.page.getByRole("button", { exact: true, name: scope });
      await expect(launcher).toBeVisible();
      await launcher.click();
      const panel = manager.page.getByRole("dialog", { exact: true, name: scope });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("link", { exact: true, name: "Workforce" })).toHaveCount(0);
      const add = panel.getByRole("button", { exact: true, name: "Add shortcut" });
      if (await add.isVisible()) await add.click();
      await expect(
        panel.getByRole("button", { exact: true, name: `Add Workforce to ${scope}` }),
      ).toHaveCount(0);
      await manager.page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
    }

    await manager.page.goto(`${manager.origin}/settings`, { waitUntil: "networkidle" });
    for (const surface of [
      {
        href: "/studio/surfaces/surface.mission-control/personal",
        label: "Mission Control",
      },
      ...hrSurfaces.map(({ label, surfaceId }) => ({
        href: `/studio/surfaces/${surfaceId}/personal`,
        label,
      })),
    ]) {
      const card = manager.page.locator(".layout-settings-card").filter({
        has: manager.page.getByRole("heading", { exact: true, level: 3, name: surface.label }),
      });
      await expect(card).toHaveCount(1);
      await expect(
        card.getByRole("link", {
          exact: true,
          name: `Edit ${surface.label} personal layout`,
        }),
      ).toHaveAttribute("href", surface.href);
    }

    await manager.page
      .getByRole("link", { exact: true, name: "Edit Workforce personal layout" })
      .click();
    await expect(manager.page).toHaveURL(
      `${manager.origin}/studio/surfaces/surface.hr.workforce/personal`,
    );
    await expect(
      manager.page.getByRole("heading", { exact: true, level: 1, name: "Shape your Workforce" }),
    ).toBeVisible();
    const returnLink = manager.page.getByRole("link", { exact: true, name: "Return to Workforce" });
    await expect(returnLink).toHaveAttribute("href", workforce.href);
    await returnLink.click();
    await expect(manager.page).toHaveURL(`${manager.origin}${workforce.href}`);
  } finally {
    await closeActor(manager);
  }
});

test("grouped surfaces preserve exact launch identity and semantic expansion admission", async ({
  browser,
}) => {
  const employee = await openActor(browser, fixture.employeeOrigin, fixture.employeeLabel);
  const operator = await openActor(browser, fixture.operatorOrigin, fixture.operatorLabel);
  try {
    await employee.page.goto(`${employee.origin}/workspace/hr/requests-and-claims`, {
      waitUntil: "networkidle",
    });
    const requests = employee.page.locator(
      '[data-presentation-surface-id="surface.hr.requests-and-claims"]',
    );
    const leave = requests.locator('[data-widget-definition="hr.leave.my-requests"]');
    const leaveLauncher = leave.getByRole("link", {
      exact: true,
      name: "Open My Leave Requests workspace",
    });
    const leaveHref =
      "/workspace/hr/leave?originFocusId=hr-requests-and-claims.my-leave.full-screen&returnSurface=surface.hr.requests-and-claims&originWidgetDefinitionId=hr.leave.my-requests";
    await expect(leaveLauncher).toHaveAttribute("href", leaveHref);
    await leaveLauncher.click();
    const leaveOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "My leave requests",
    });
    await expect(leaveOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(`${employee.origin}${leaveHref}`);
    await leaveOverlay.getByRole("link", { exact: true, name: "New request" }).click();
    const newLeaveOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "New leave request",
    });
    await expect(newLeaveOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/leave/new?returnContext=hr-mission-control&originFocusId=hr-requests-and-claims.my-leave.full-screen&returnSurface=surface.hr.requests-and-claims&originWidgetDefinitionId=hr.leave.my-requests`,
    );
    await employee.page.goBack();
    await expect(leaveOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(`${employee.origin}${leaveHref}`);
    await leaveOverlay
      .getByRole("button", { exact: true, name: "Close My leave requests" })
      .click();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr/requests-and-claims`);
    await expect(employee.page.getByRole("dialog")).toHaveCount(0);
    await expect(
      employee.page.locator("#hr-requests-and-claims\\.my-leave\\.full-screen"),
    ).toBeFocused();

    await employee.page.goto(`${employee.origin}/workspace/hr/workforce`, {
      waitUntil: "networkidle",
    });
    const workforce = employee.page.locator(
      '[data-presentation-surface-id="surface.hr.workforce"]',
    );
    const profileLauncher = workforce
      .locator('[data-widget-definition="hr.workforce.my-profile"]')
      .getByRole("link", { exact: true, name: "Open My Profile quick view" });
    await expect(profileLauncher).toHaveAttribute(
      "href",
      "/workspace/hr/profile?originFocusId=hr-workforce.my-profile.full-screen&returnSurface=surface.hr.workforce&originWidgetDefinitionId=hr.workforce.my-profile",
    );
    await profileLauncher.click();
    const profileOverlay = employee.page.getByRole("dialog", {
      exact: true,
      name: "Workforce profile",
    });
    await expect(profileOverlay).toBeVisible();
    await expect(employee.page).toHaveURL(
      `${employee.origin}/workspace/hr/profile?originFocusId=hr-workforce.my-profile.full-screen&returnSurface=surface.hr.workforce&originWidgetDefinitionId=hr.workforce.my-profile`,
    );
    await profileOverlay
      .getByRole("button", { exact: true, name: "Close workforce profile" })
      .click();
    await expect(employee.page).toHaveURL(`${employee.origin}/workspace/hr/workforce`);
    await expect(employee.page.locator("#hr-workforce\\.my-profile\\.full-screen")).toBeFocused();

    await operator.page.goto(`${operator.origin}/workspace/hr/workforce`, {
      waitUntil: "networkidle",
    });
    const statusReporting = operator.page.locator(
      '[data-widget-definition="hr.workforce.status-reporting"]',
    );
    await expect(statusReporting).toBeVisible();
    await expect(statusReporting.locator(".icon-command")).toHaveCount(0);
  } finally {
    await closeActor(employee);
    await closeActor(operator);
  }
});
