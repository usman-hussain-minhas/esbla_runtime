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
    ]);
    expect(hrManifest.capabilities).not.toContainEqual({
      exposure: "integration",
      id: expect.any(String),
    });
  });
});
