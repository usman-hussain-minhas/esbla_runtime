import { describe, expect, it } from "vitest";
import {
  buildZenNavigationModel,
  decodePresentationNavigationDiscoveryResponse,
  getZenDiscoveredSurfaceIds,
  PresentationNavigationError,
  projectZenNavigationModel,
} from "./presentation-navigation-core";

const discovery = {
  serviceGroups: [
    {
      serviceGroupId: "hr" as const,
      surfaceIds: [
        "surface.hr.mission-control",
        "surface.hr.workforce",
        "surface.hr.time-and-scheduling",
        "surface.hr.requests-and-claims",
      ] as const,
    },
  ],
};

describe("presentation navigation web boundary", () => {
  it("accepts only exact HTTP 200 strict navigation discovery", async () => {
    await expect(
      decodePresentationNavigationDiscoveryResponse(
        Promise.resolve(Response.json(discovery, { status: 200 })),
      ),
    ).resolves.toEqual(discovery);
    await expect(
      decodePresentationNavigationDiscoveryResponse(
        Promise.resolve(Response.json({ ...discovery, actorId: "private" }, { status: 200 })),
      ),
    ).rejects.toBeInstanceOf(PresentationNavigationError);
    await expect(
      decodePresentationNavigationDiscoveryResponse(
        Promise.resolve(Response.json(discovery, { status: 201 })),
      ),
    ).rejects.toBeInstanceOf(PresentationNavigationError);
  });

  it("sanitizes transport and Problem Details failures", async () => {
    await expect(
      decodePresentationNavigationDiscoveryResponse(
        Promise.reject(new Error("private upstream detail")),
      ),
    ).rejects.toThrow("Presentation navigation is unavailable");
    await expect(
      decodePresentationNavigationDiscoveryResponse(
        Promise.resolve(
          Response.json(
            {
              code: "POLICY_DENIED",
              detail: "private policy detail",
              instance: "/v1/platform/presentation/navigation",
              status: 403,
              title: "Forbidden",
              type: "https://errors.esbla.com/policy-denied",
            },
            { status: 403 },
          ),
        ),
      ),
    ).rejects.toThrow("Presentation navigation is unavailable");
  });

  it("builds one exact registry-derived HR surface menu without leaf-route leakage", () => {
    const model = buildZenNavigationModel(discovery, "/workspace/hr/time-and-scheduling");
    expect(model.serviceGroups.map(({ label }) => label)).toEqual(["HR"]);
    expect(model.contextualMenu).toMatchObject({
      activeDestinationId: "surface.hr.time-and-scheduling",
      label: "HR surfaces",
      serviceGroupId: "hr",
    });
    expect(model.contextualMenu?.destinations.map(({ id }) => id)).toEqual([
      "surface.hr.mission-control",
      "surface.hr.workforce",
      "surface.hr.time-and-scheduling",
      "surface.hr.requests-and-claims",
    ]);
    expect(model.contextualMenu?.destinations.map(({ href }) => href)).toEqual([
      "/workspace/hr",
      "/workspace/hr/workforce",
      "/workspace/hr/time-and-scheduling",
      "/workspace/hr/requests-and-claims",
    ]);
    expect(
      model.contextualMenu?.destinations.some(({ href }) =>
        ["/workspace/hr/profile", "/workspace/hr/leave", "/workspace/hr/settings"].includes(href),
      ),
    ).toBe(false);
  });

  it("omits contextual navigation outside a group, for empty groups and with no alternative", () => {
    expect(buildZenNavigationModel(discovery, "/").contextualMenu).toBeUndefined();
    expect(buildZenNavigationModel({ serviceGroups: [] }, "/workspace/hr").serviceGroups).toEqual(
      [],
    );
    expect(
      buildZenNavigationModel({ serviceGroups: [] }, "/workspace/hr").contextualMenu,
    ).toBeUndefined();
    const workforceOnly = buildZenNavigationModel(
      {
        serviceGroups: [
          {
            serviceGroupId: "hr",
            surfaceIds: ["surface.hr.workforce"],
          },
        ],
      },
      "/workspace/hr/workforce",
    );
    expect(workforceOnly.contextualMenu).toBeUndefined();
    expect(workforceOnly.serviceGroups).toMatchObject([
      { href: "/workspace/hr/workforce", serviceGroupId: "hr" },
    ]);
  });

  it("projects only the universal and currently discovered surfaces in registry order", () => {
    expect(getZenDiscoveredSurfaceIds(discovery)).toEqual([
      "surface.mission-control",
      "surface.hr.mission-control",
      "surface.hr.workforce",
      "surface.hr.time-and-scheduling",
      "surface.hr.requests-and-claims",
    ]);
    expect(getZenDiscoveredSurfaceIds({ serviceGroups: [] })).toEqual(["surface.mission-control"]);
  });

  it("projects a synthetic future service group through the production navigation seam", () => {
    const serviceGroups = new Map([
      [
        "finance",
        {
          href: "/workspace/finance",
          label: "Finance",
          semanticIcon: "generic-service" as const,
          serviceGroupId: "finance",
        },
      ],
    ]);
    const surfaces = new Map([
      [
        "surface.finance.accounts",
        {
          label: "Accounts",
          route: "/workspace/finance/accounts",
          semanticIcon: "generic-service" as const,
          surfaceId: "surface.finance.accounts",
        },
      ],
      [
        "surface.finance.reports",
        {
          label: "Reports",
          route: "/workspace/finance/reports",
          semanticIcon: "generic-service" as const,
          surfaceId: "surface.finance.reports",
        },
      ],
    ]);
    const registry = {
      serviceGroup: (serviceGroupId: string) => {
        const definition = serviceGroups.get(serviceGroupId);
        if (!definition) throw new Error("Unknown synthetic service group");
        return definition;
      },
      surface: (surfaceId: string) => {
        const definition = surfaces.get(surfaceId);
        if (!definition) throw new Error("Unknown synthetic surface");
        return definition;
      },
    };
    const multiple = projectZenNavigationModel(
      {
        serviceGroups: [
          {
            serviceGroupId: "finance",
            surfaceIds: ["surface.finance.accounts", "surface.finance.reports"],
          },
        ],
      },
      "/workspace/finance/reports/quarterly",
      registry,
    );
    expect(multiple.serviceGroups).toMatchObject([
      { href: "/workspace/finance/accounts", label: "Finance", serviceGroupId: "finance" },
    ]);
    expect(multiple.contextualMenu).toMatchObject({
      activeDestinationId: "surface.finance.reports",
      label: "Finance surfaces",
      serviceGroupId: "finance",
    });
    expect(multiple.contextualMenu?.destinations.map(({ id }) => id)).toEqual([
      "surface.finance.accounts",
      "surface.finance.reports",
    ]);
    expect(JSON.stringify(multiple)).not.toContain("/workspace/finance/invoices");

    const singleton = projectZenNavigationModel(
      {
        serviceGroups: [{ serviceGroupId: "finance", surfaceIds: ["surface.finance.reports"] }],
      },
      "/workspace/finance/reports",
      registry,
    );
    expect(singleton.serviceGroups).toMatchObject([
      { href: "/workspace/finance/reports", serviceGroupId: "finance" },
    ]);
    expect(singleton.contextualMenu).toBeUndefined();
  });
});
