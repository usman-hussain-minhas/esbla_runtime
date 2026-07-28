import { describe, expect, it } from "vitest";
import {
  buildZenNavigationModel,
  decodePresentationNavigationDiscoveryResponse,
  PresentationNavigationError,
} from "./presentation-navigation-core";

const discovery = {
  serviceGroups: [
    {
      destinationIds: ["hr.workforce.own", "hr.leave.own"] as const,
      serviceGroupId: "hr" as const,
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

  it("builds one deduplicated HR context menu and selects the longest matching route", () => {
    const model = buildZenNavigationModel(
      discovery,
      "/workspace/hr/profile/by-id/91000000-0000-4000-8000-000000000001",
    );
    expect(model.serviceGroups.map(({ label }) => label)).toEqual(["HR"]);
    expect(model.contextualMenu).toMatchObject({
      activeDestinationId: "hr.workforce.own",
      label: "HR pages",
      serviceGroupId: "hr",
    });
    expect(model.contextualMenu?.destinations.map(({ href }) => href)).toEqual([
      "/workspace/hr",
      "/workspace/hr/profile",
      "/workspace/hr/leave",
    ]);
  });

  it("omits contextual navigation outside a service group and omits empty groups", () => {
    expect(buildZenNavigationModel(discovery, "/").contextualMenu).toBeUndefined();
    expect(buildZenNavigationModel({ serviceGroups: [] }, "/workspace/hr").serviceGroups).toEqual(
      [],
    );
    expect(
      buildZenNavigationModel({ serviceGroups: [] }, "/workspace/hr").contextualMenu,
    ).toBeUndefined();
  });
});
