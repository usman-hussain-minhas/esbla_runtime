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
    ]);
  });
});
