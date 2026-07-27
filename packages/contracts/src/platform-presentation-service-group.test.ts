import { describe, expect, it } from "vitest";
import {
  getPresentationServiceGroupDefinition,
  PRESENTATION_SERVICE_GROUP_DEFINITIONS,
  parsePresentationServiceGroupDiscovery,
} from "./platform-presentation-service-group.js";

describe("presentation service-group contract", () => {
  it("owns the complete HR service eligibility boundary without exposing it in discovery", () => {
    const hr = getPresentationServiceGroupDefinition("hr");
    expect(hr.href).toBe("/workspace/hr");
    expect(hr.semanticIcon).toBe("users-round");
    expect(hr.services).toEqual([
      {
        activationServiceKey: "workforce_profile",
        anyReadCapabilityIds: [
          "hr.workforce.list_authorized",
          "hr.workforce.view_authorized_detail",
          "hr.workforce.view_own",
          "hr.workforce.view_service_control",
        ],
      },
      {
        activationServiceKey: "employment_record",
        anyReadCapabilityIds: [
          "hr.employment.list_authorized",
          "hr.employment.view_detail",
          "hr.employment.view_service_control",
        ],
      },
      {
        activationServiceKey: "shift_assignment",
        anyReadCapabilityIds: [
          "hr.shift.list_roster",
          "hr.shift.view_detail",
          "hr.shift.view_service_control",
        ],
      },
      {
        activationServiceKey: "attendance",
        anyReadCapabilityIds: [
          "hr.attendance.list_own",
          "hr.attendance.list_reports",
          "hr.attendance.view_detail",
          "hr.attendance.view_service_control",
        ],
      },
      {
        activationServiceKey: "hr.leave_request",
        anyReadCapabilityIds: ["hr.leave.list_assigned", "hr.leave.list_own", "hr.leave.view"],
      },
      {
        activationServiceKey: "timesheet",
        anyReadCapabilityIds: [
          "hr.timesheet.list_assigned",
          "hr.timesheet.list_own",
          "hr.timesheet.view_detail",
          "hr.timesheet.view_service_control",
        ],
      },
      {
        activationServiceKey: "expense_claim_boundary",
        anyReadCapabilityIds: [
          "hr.expense.list_assigned",
          "hr.expense.list_own",
          "hr.expense.view_detail",
          "hr.expense.view_service_control",
        ],
      },
    ]);
    expect(PRESENTATION_SERVICE_GROUP_DEFINITIONS).toHaveLength(1);
    expect(parsePresentationServiceGroupDiscovery({ serviceGroupIds: ["hr"] })).toEqual({
      serviceGroupIds: ["hr"],
    });
  });

  it("rejects topology, duplicates, unknown groups, and non-canonical response order", () => {
    for (const invalid of [
      { serviceGroupIds: ["hr", "hr"] },
      { serviceGroupIds: ["finance"] },
      { serviceGroupIds: [], services: [] },
      { serviceGroupIds: "hr" },
    ]) {
      expect(() => parsePresentationServiceGroupDiscovery(invalid)).toThrow(
        "Invalid presentation service-group discovery",
      );
    }
  });
});
