import { describe, expect, it } from "vitest";
import { hrManifest } from "./index.js";

describe("hrManifest", () => {
  it("stays inactive by default while declaring only ratified capabilities", () => {
    expect(hrManifest.activation).toBe("inactive_by_default");
    expect(hrManifest.capabilities.map((capability) => capability.id)).toEqual([
      "hr.leave.activate",
      "hr.leave.approve",
      "hr.leave.deactivate",
      "hr.leave.list_assigned",
      "hr.leave.list_own",
      "hr.leave.reject",
      "hr.leave.submit",
      "hr.leave.view",
      "hr.workforce.activate_service",
      "hr.workforce.deactivate_service",
      "hr.workforce.view_service_control",
    ]);
    expect(
      hrManifest.capabilities.filter((capability) => capability.id.startsWith("hr.workforce.")),
    ).toEqual([
      { exposure: "admin", id: "hr.workforce.activate_service" },
      { exposure: "admin", id: "hr.workforce.deactivate_service" },
      { exposure: "admin", id: "hr.workforce.view_service_control" },
    ]);
    expect(Object.isFrozen(hrManifest)).toBe(true);
    expect(Object.isFrozen(hrManifest.capabilities)).toBe(true);
    expect(hrManifest.capabilities.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(hrManifest.dependencies)).toBe(true);
  });
});
