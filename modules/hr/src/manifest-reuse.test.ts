import { describe, expect, it } from "vitest";
import { hrManifest } from "./index.js";

describe("HR passenger manifest reuse contract", () => {
  it("keeps HR inactive until Foundry/Core activation and depends on platform core", () => {
    expect(hrManifest.activation).toBe("inactive_by_default");
    expect(hrManifest.dependencies).toEqual(["platform_core"]);
    expect(hrManifest.id).toBe("hr");
    expect(hrManifest.version).toBe("0.1.0");
  });

  it("declares bounded tenant/admin capabilities without provider, money, or deployment exposure", () => {
    const exposures = new Set(hrManifest.capabilities.map((capability) => capability.exposure));
    expect(exposures).toEqual(new Set(["admin", "tenant"]));
    expect(hrManifest.capabilities.map((capability) => capability.id).sort()).toEqual([
      "hr.leave.activate",
      "hr.leave.approve",
      "hr.leave.deactivate",
      "hr.leave.list_assigned",
      "hr.leave.list_own",
      "hr.leave.reject",
      "hr.leave.submit",
      "hr.leave.view",
      "hr.workforce.activate_service",
      "hr.workforce.change_reporting_relationship",
      "hr.workforce.change_status",
      "hr.workforce.configure_service",
      "hr.workforce.create_profile",
      "hr.workforce.deactivate_service",
      "hr.workforce.link_principal",
      "hr.workforce.list_authorized",
      "hr.workforce.view_authorized_detail",
      "hr.workforce.view_own",
      "hr.workforce.view_service_control",
    ]);
    expect(
      hrManifest.capabilities.filter((capability) => capability.id.startsWith("hr.workforce.")),
    ).toEqual([
      { exposure: "admin", id: "hr.workforce.activate_service" },
      { exposure: "tenant", id: "hr.workforce.change_reporting_relationship" },
      { exposure: "tenant", id: "hr.workforce.change_status" },
      { exposure: "tenant", id: "hr.workforce.create_profile" },
      { exposure: "admin", id: "hr.workforce.configure_service" },
      { exposure: "admin", id: "hr.workforce.deactivate_service" },
      { exposure: "tenant", id: "hr.workforce.link_principal" },
      { exposure: "tenant", id: "hr.workforce.list_authorized" },
      { exposure: "tenant", id: "hr.workforce.view_authorized_detail" },
      { exposure: "tenant", id: "hr.workforce.view_own" },
      { exposure: "admin", id: "hr.workforce.view_service_control" },
    ]);
    expect(hrManifest.capabilities).not.toContainEqual({
      exposure: "integration",
      id: expect.any(String),
    });
  });
});
