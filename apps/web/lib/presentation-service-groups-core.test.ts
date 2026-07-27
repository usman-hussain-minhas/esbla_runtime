import { describe, expect, it } from "vitest";
import {
  decodePresentationServiceGroupDiscoveryResponse,
  PresentationServiceGroupsError,
} from "./presentation-service-groups-core";

describe("presentation service-group web boundary", () => {
  it("accepts only an exact successful discovery response", async () => {
    await expect(
      decodePresentationServiceGroupDiscoveryResponse(
        Promise.resolve(Response.json({ serviceGroupIds: ["hr"] })),
      ),
    ).resolves.toEqual({ serviceGroupIds: ["hr"] });
    await expect(
      decodePresentationServiceGroupDiscoveryResponse(
        Promise.resolve(Response.json({ serviceGroupIds: ["hr"], services: [] })),
      ),
    ).rejects.toBeInstanceOf(PresentationServiceGroupsError);
    await expect(
      decodePresentationServiceGroupDiscoveryResponse(
        Promise.resolve(new Response("{}", { status: 201 })),
      ),
    ).rejects.toBeInstanceOf(PresentationServiceGroupsError);
  });

  it("sanitizes transport and Problem Details failures", async () => {
    await expect(
      decodePresentationServiceGroupDiscoveryResponse(
        Promise.reject(new Error("private upstream detail")),
      ),
    ).rejects.toThrow("Presentation service groups are unavailable");
    await expect(
      decodePresentationServiceGroupDiscoveryResponse(
        Promise.resolve(
          Response.json(
            {
              code: "POLICY_DENIED",
              detail: "private policy detail",
              instance: "/v1/platform/presentation/service-groups",
              status: 403,
              title: "Forbidden",
              type: "https://errors.esbla.com/policy-denied",
            },
            { status: 403 },
          ),
        ),
      ),
    ).rejects.toThrow("Presentation service groups are unavailable");
  });
});
