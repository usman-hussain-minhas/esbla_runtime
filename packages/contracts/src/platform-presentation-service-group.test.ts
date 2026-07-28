import { describe, expect, it } from "vitest";
import {
  getPresentationServiceGroupDefinition,
  PRESENTATION_SERVICE_GROUP_DEFINITIONS,
  parsePresentationNavigationDiscovery,
  parsePresentationServiceGroupDiscovery,
} from "./platform-presentation-service-group.js";

describe("presentation service-group contract", () => {
  it("owns the complete HR service eligibility boundary without exposing it in discovery", () => {
    const hr = getPresentationServiceGroupDefinition("hr");
    expect(hr.href).toBe("/workspace/hr");
    expect(hr.semanticIcon).toBe("users-round");
    expect(
      hr.services.map(({ activationServiceKey, serviceId }) => ({
        activationServiceKey,
        serviceId,
      })),
    ).toEqual([
      {
        activationServiceKey: "workforce_profile",
        serviceId: "workforce_profile",
      },
      {
        activationServiceKey: "employment_record",
        serviceId: "employment_record",
      },
      {
        activationServiceKey: "shift_assignment",
        serviceId: "shift_assignment",
      },
      {
        activationServiceKey: "attendance",
        serviceId: "attendance",
      },
      {
        activationServiceKey: "hr.leave_request",
        serviceId: "leave_request",
      },
      {
        activationServiceKey: "timesheet",
        serviceId: "timesheet",
      },
      {
        activationServiceKey: "expense_claim_boundary",
        serviceId: "expense_claim",
      },
    ]);
    expect(
      hr.services.flatMap(({ destinations }) =>
        destinations.map(({ destinationId, href }) => [destinationId, href]),
      ),
    ).toEqual([
      ["hr.workforce.own", "/workspace/hr/profile"],
      ["hr.workforce.direct_reports", "/workspace/hr/profile/direct-reports"],
      ["hr.workforce.admin", "/workspace/hr/profile/admin"],
      ["hr.workforce.settings", "/workspace/hr/profile/settings"],
      ["hr.employment.records", "/workspace/hr/employment"],
      ["hr.employment.admin", "/workspace/hr/employment/admin"],
      ["hr.employment.settings", "/workspace/hr/employment/settings"],
      ["hr.shift.own", "/workspace/hr/shifts"],
      ["hr.shift.reports", "/workspace/hr/shifts/reports"],
      ["hr.shift.settings", "/workspace/hr/shifts/settings"],
      ["hr.attendance.own", "/workspace/hr/attendance"],
      ["hr.attendance.reports", "/workspace/hr/attendance/reports"],
      ["hr.attendance.settings", "/workspace/hr/attendance/settings"],
      ["hr.leave.own", "/workspace/hr/leave"],
      ["hr.timesheet.own", "/workspace/hr/timesheets"],
      ["hr.timesheet.corrections", "/workspace/hr/timesheets/admin/corrections"],
      ["hr.timesheet.settings", "/workspace/hr/timesheets/settings"],
      ["hr.expense.own", "/workspace/hr/expenses"],
      ["hr.expense.settings", "/workspace/hr/expenses/settings"],
    ]);
    expect(
      hr.services.flatMap((service) =>
        "additionalVisibilityRules" in service
          ? service.additionalVisibilityRules.map(({ allowedRoleKeys, anyCapabilityIds }) => ({
              allowedRoleKeys,
              anyCapabilityIds,
              serviceId: service.serviceId,
            }))
          : [],
      ),
    ).toEqual([
      {
        allowedRoleKeys: ["manager"],
        anyCapabilityIds: ["hr.leave.list_assigned"],
        serviceId: "leave_request",
      },
      {
        allowedRoleKeys: ["manager"],
        anyCapabilityIds: ["hr.timesheet.list_assigned"],
        serviceId: "timesheet",
      },
      {
        allowedRoleKeys: ["manager"],
        anyCapabilityIds: ["hr.expense.list_assigned"],
        serviceId: "expense_claim",
      },
    ]);
    expect(PRESENTATION_SERVICE_GROUP_DEFINITIONS).toHaveLength(1);
    expect(parsePresentationServiceGroupDiscovery({ serviceGroupIds: ["hr"] })).toEqual({
      serviceGroupIds: ["hr"],
    });
    expect(
      parsePresentationNavigationDiscovery({
        serviceGroups: [{ destinationIds: ["hr.leave.own"], serviceGroupId: "hr" }],
      }),
    ).toEqual({
      serviceGroups: [{ destinationIds: ["hr.leave.own"], serviceGroupId: "hr" }],
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
    for (const invalid of [
      {
        serviceGroups: [{ destinationIds: ["hr.leave.own", "hr.leave.own"], serviceGroupId: "hr" }],
      },
      { serviceGroups: [{ destinationIds: ["unknown"], serviceGroupId: "hr" }] },
      { serviceGroups: [{ destinationIds: [], serviceGroupId: "finance" }] },
      {
        serviceGroups: [
          {
            destinationIds: ["hr.timesheet.settings", "hr.leave.own"],
            serviceGroupId: "hr",
          },
        ],
      },
      { serviceGroups: [] as unknown[], extra: true },
    ]) {
      expect(() => parsePresentationNavigationDiscovery(invalid)).toThrow(
        "Invalid presentation navigation discovery",
      );
    }
  });
});
