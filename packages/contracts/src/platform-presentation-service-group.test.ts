import { describe, expect, it } from "vitest";
import {
  getPresentationServiceGroupDefinition,
  PRESENTATION_DEEP_ROUTE_DEFINITIONS,
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
    expect(PRESENTATION_DEEP_ROUTE_DEFINITIONS).toHaveLength(22);
    expect(
      PRESENTATION_DEEP_ROUTE_DEFINITIONS.filter(({ exposure }) => exposure === "action_only"),
    ).toHaveLength(6);
    expect(
      PRESENTATION_DEEP_ROUTE_DEFINITIONS.filter(({ exposure }) => exposure === "widget_route"),
    ).toHaveLength(16);
    expect(
      PRESENTATION_DEEP_ROUTE_DEFINITIONS.slice(-3).map(({ destinationId, exposure, href }) => ({
        destinationId,
        exposure,
        href,
      })),
    ).toEqual([
      {
        destinationId: "hr.leave.create",
        exposure: "widget_route",
        href: "/workspace/hr/leave/new",
      },
      {
        destinationId: "platform.my-work",
        exposure: "widget_route",
        href: "/workspace/my-work",
      },
      {
        destinationId: "workspace.tasks",
        exposure: "widget_route",
        href: "/workspace/tasks",
      },
    ]);
    expect(parsePresentationServiceGroupDiscovery({ serviceGroupIds: ["hr"] })).toEqual({
      serviceGroupIds: ["hr"],
    });
    expect(
      parsePresentationNavigationDiscovery({
        serviceGroups: [
          {
            serviceGroupId: "hr",
            surfaceIds: [
              "surface.hr.mission-control",
              "surface.hr.workforce",
              "surface.hr.time-and-scheduling",
              "surface.hr.requests-and-claims",
            ],
          },
        ],
      }),
    ).toEqual({
      serviceGroups: [
        {
          serviceGroupId: "hr",
          surfaceIds: [
            "surface.hr.mission-control",
            "surface.hr.workforce",
            "surface.hr.time-and-scheduling",
            "surface.hr.requests-and-claims",
          ],
        },
      ],
    });
  });

  it("rejects leaf, unknown, duplicate, out-of-order and cross-group navigation surfaces", () => {
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
        serviceGroups: [
          {
            serviceGroupId: "hr",
            surfaceIds: ["surface.hr.workforce", "surface.hr.workforce"],
          },
        ],
      },
      { serviceGroups: [{ serviceGroupId: "hr", surfaceIds: ["hr.leave.own"] }] },
      { serviceGroups: [{ serviceGroupId: "hr", surfaceIds: ["surface.hr.unknown"] }] },
      { serviceGroups: [{ serviceGroupId: "hr", surfaceIds: ["surface.mission-control"] }] },
      { serviceGroups: [{ serviceGroupId: "hr", surfaceIds: [] }] },
      { serviceGroups: [{ serviceGroupId: "finance", surfaceIds: [] }] },
      {
        serviceGroups: [
          {
            serviceGroupId: "hr",
            surfaceIds: ["surface.hr.requests-and-claims", "surface.hr.time-and-scheduling"],
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
