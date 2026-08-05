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
