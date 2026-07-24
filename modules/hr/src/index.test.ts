import { describe, expect, it } from "vitest";
import { hrManifest } from "./index.js";

describe("hrManifest", () => {
  it("stays inactive by default while declaring only ratified capabilities", () => {
    expect(hrManifest.activation).toBe("inactive_by_default");
    expect(hrManifest.capabilities.map((capability) => capability.id)).toEqual([
      "hr.attendance.activate_service",
      "hr.attendance.configure_service",
      "hr.attendance.record_manual",
      "hr.attendance.correct",
      "hr.attendance.deactivate_service",
      "hr.attendance.list_own",
      "hr.attendance.list_reports",
      "hr.attendance.view_detail",
      "hr.attendance.view_service_control",
      "hr.leave.activate",
      "hr.leave.approve",
      "hr.leave.deactivate",
      "hr.leave.list_assigned",
      "hr.leave.list_own",
      "hr.leave.reject",
      "hr.leave.submit",
      "hr.leave.view",
      "hr.shift.activate_service",
      "hr.shift.assign",
      "hr.shift.cancel",
      "hr.shift.configure_service",
      "hr.shift.create_roster",
      "hr.shift.deactivate_service",
      "hr.shift.list_roster",
      "hr.shift.publish",
      "hr.shift.view_detail",
      "hr.shift.view_service_control",
      "hr.employment.activate_service",
      "hr.employment.configure_service",
      "hr.employment.create_record",
      "hr.employment.create_version",
      "hr.employment.deactivate_service",
      "hr.employment.end_record",
      "hr.employment.list_authorized",
      "hr.employment.view_detail",
      "hr.employment.view_service_control",
      "hr.workforce.activate_service",
      "hr.workforce.change_reporting_relationship",
      "hr.workforce.change_status",
      "hr.workforce.create_profile",
      "hr.workforce.configure_service",
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
    expect(Object.isFrozen(hrManifest)).toBe(true);
    expect(Object.isFrozen(hrManifest.capabilities)).toBe(true);
    expect(hrManifest.capabilities.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(hrManifest.dependencies)).toBe(true);
  });
});
