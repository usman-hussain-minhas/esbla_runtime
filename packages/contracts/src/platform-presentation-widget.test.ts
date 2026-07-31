import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizePresentationWidgetDefinition,
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
  PRESENTATION_WIDGET_DEFINITIONS,
  parsePresentationSemanticIconKey,
  parsePresentationWidgetDefinition,
  presentationSemanticIconKeys,
  validatePresentationWidgetRegistry,
} from "./platform-presentation-widget.js";

describe("presentation widget manifest", () => {
  it("registers the default Mission Control Product shapes in canonical identity order", () => {
    expect(PRESENTATION_WIDGET_DEFINITIONS.map(({ id }) => id)).toEqual([
      "hr.attendance.correction-queue",
      "hr.attendance.my-observations",
      "hr.attendance.reports",
      "hr.employment.admin-queue",
      "hr.employment.current-facts",
      "hr.employment.history",
      "hr.expense.mine",
      "hr.leave.assigned",
      "hr.leave.history",
      "hr.leave.my-requests",
      "hr.leave.request-form",
      "hr.shift.my-published",
      "hr.shift.publish-queue",
      "hr.shift.roster-overview",
      "hr.timesheet.draft",
      "hr.timesheet.mine",
      "hr.workforce.admin-queue",
      "hr.workforce.direct-reports",
      "hr.workforce.my-profile",
      "hr.workforce.status-reporting",
      "platform.my-work.queue",
      "workspace.tasks.mine",
    ]);
    expect(
      PRESENTATION_WIDGET_DEFINITIONS.filter(({ id }) =>
        [
          "hr.attendance.my-observations",
          "hr.expense.mine",
          "hr.workforce.direct-reports",
        ].includes(id),
      ),
    ).toMatchObject([
      {
        activationServiceKey: "attendance",
        allowedCommandIds: [],
        fullScreenRoute: "/workspace/hr/attendance",
        id: "hr.attendance.my-observations",
        inlineMutationEligible: false,
        readModelId: "hr.attendance.my-observations.read.v1",
        requiredCapabilityIds: ["hr.attendance.list_own", "hr.attendance.view_detail"],
        semanticIcon: "clock-3",
      },
      {
        activationServiceKey: "expense_claim_boundary",
        allowedCommandIds: [],
        fullScreenRoute: "/workspace/hr/expenses",
        id: "hr.expense.mine",
        inlineMutationEligible: false,
        readModelId: "hr.expense.mine.read.v1",
        requiredCapabilityIds: ["hr.expense.list_own", "hr.expense.view_detail"],
        semanticIcon: "receipt-text",
      },
      {
        activationServiceKey: "workforce_profile",
        allowedCommandIds: [],
        fullScreenRoute: "/workspace/hr/profile/direct-reports",
        id: "hr.workforce.direct-reports",
        inlineMutationEligible: false,
        readModelId: "hr.workforce.direct-reports.read.v1",
        requiredCapabilityIds: [
          "hr.workforce.list_authorized",
          "hr.workforce.view_authorized_detail",
        ],
        semanticIcon: "user-round",
      },
    ]);
    expect(
      PRESENTATION_WIDGET_DEFINITIONS.flatMap(({ requiredCapabilityIds }) =>
        (requiredCapabilityIds as readonly string[]).filter(
          (capabilityId) => capabilityId === "hr.attendance.record_synthetic_test",
        ),
      ),
    ).toEqual([]);
    expect(
      PRESENTATION_WIDGET_DEFINITIONS.find(({ id }) => id === "hr.timesheet.draft"),
    ).toMatchObject({
      allowedCommandIds: ["hr.timesheet.create", "hr.timesheet.edit_draft", "hr.timesheet.submit"],
      fullScreenRoute: "/workspace/hr/timesheets",
      id: "hr.timesheet.draft",
      inlineMutationEligible: true,
      readModelId: "hr.timesheet.draft.read.v1",
      requiredCapabilityIds: [
        "hr.timesheet.list_own",
        "hr.timesheet.view_detail",
        "hr.timesheet.create",
        "hr.timesheet.edit_draft",
        "hr.timesheet.submit",
      ],
      widgetKind: "operational",
    });
    expect(
      PRESENTATION_WIDGET_DEFINITIONS.filter(({ id }) =>
        ["hr.leave.assigned", "hr.leave.history", "hr.leave.request-form"].includes(id),
      ),
    ).toMatchObject([
      {
        allowedCommandIds: ["hr.leave.approve", "hr.leave.reject"],
        fullScreenRoute: "/workspace/my-work",
        id: "hr.leave.assigned",
        inlineMutationEligible: true,
        requiredCapabilityIds: ["hr.leave.list_assigned", "hr.leave.view"],
      },
      {
        allowedCommandIds: [],
        fullScreenRoute: "/workspace/hr/leave",
        id: "hr.leave.history",
        inlineMutationEligible: false,
        requiredCapabilityIds: ["hr.leave.list_own", "hr.leave.view"],
      },
      {
        allowedCommandIds: ["hr.leave.submit"],
        fullScreenRoute: "/workspace/hr/leave/new",
        id: "hr.leave.request-form",
        inlineMutationEligible: false,
        requiredCapabilityIds: ["hr.leave.submit"],
      },
    ]);
    expect(
      PRESENTATION_WIDGET_DEFINITIONS.filter(({ id }) =>
        [
          "hr.attendance.correction-queue",
          "hr.attendance.reports",
          "hr.shift.publish-queue",
          "hr.shift.roster-overview",
        ].includes(id),
      ),
    ).toMatchObject([
      {
        allowedCommandIds: ["hr.attendance.record_manual", "hr.attendance.correct"],
        fullScreenRoute: "/workspace/hr/attendance/reports",
        id: "hr.attendance.correction-queue",
        inlineMutationEligible: true,
        requiredCapabilityIds: [
          "hr.attendance.list_reports",
          "hr.attendance.view_detail",
          "hr.attendance.record_manual",
          "hr.attendance.correct",
        ],
      },
      {
        allowedCommandIds: [],
        fullScreenRoute: "/workspace/hr/attendance/reports",
        id: "hr.attendance.reports",
        inlineMutationEligible: false,
        requiredCapabilityIds: ["hr.attendance.list_reports", "hr.attendance.view_detail"],
      },
      {
        allowedCommandIds: [
          "hr.shift.create_roster",
          "hr.shift.assign",
          "hr.shift.cancel",
          "hr.shift.publish",
        ],
        fullScreenRoute: "/workspace/hr/shifts/reports",
        id: "hr.shift.publish-queue",
        inlineMutationEligible: true,
        requiredCapabilityIds: [
          "hr.shift.list_roster",
          "hr.shift.view_detail",
          "hr.shift.create_roster",
          "hr.shift.assign",
          "hr.shift.cancel",
          "hr.shift.publish",
        ],
      },
      {
        allowedCommandIds: [],
        fullScreenRoute: "/workspace/hr/shifts/reports",
        id: "hr.shift.roster-overview",
        inlineMutationEligible: false,
        requiredCapabilityIds: ["hr.shift.list_roster", "hr.shift.view_detail"],
      },
    ]);
    expect(
      PRESENTATION_WIDGET_DEFINITIONS.find(({ id }) => id === "platform.my-work.queue"),
    ).toMatchObject({
      activationServiceKey: "platform.my_work",
      allowedCommandIds: [
        "hr.leave.approve",
        "hr.leave.reject",
        "hr.timesheet.approve",
        "hr.timesheet.reject",
        "hr.expense.approve",
        "hr.expense.reject",
        "workspace.task.complete",
      ],
      inlineMutationEligible: true,
      widgetKind: "composite",
    });
  });

  it("binds every complete immutable widget definition to its startup hash", () => {
    for (const definition of PRESENTATION_WIDGET_DEFINITIONS) {
      const { canonicalHash, ...manifest } = definition;
      expect(
        createHash("sha256")
          .update(canonicalizePresentationWidgetDefinition(manifest))
          .digest("hex"),
      ).toBe(canonicalHash);
      expect(parsePresentationWidgetDefinition(definition)).toBe(definition);
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it("aligns the proven Leave face with the ratified V1 manifest semantics", () => {
    expect(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION).toMatchObject({
      activationServiceKey: "hr.leave_request",
      displayName: "My Leave Requests",
      eligibilityPolicyId: "current_tenant_activation_and_capability_v1",
      fullScreenRoute: "/workspace/hr/leave",
      id: "hr.leave.my-requests",
      readModelId: "hr.leave.my-requests.read.v1",
      sourceServiceGroup: "hr",
      sourceServiceKey: "leave_request",
      supportedSurfaceTypes: ["mission_control", "service_group_mission_control", "standalone"],
    });
    expect(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION.layoutConstraints.desktop).toMatchObject({
      maximumColumnSpan: 12,
      maximumRowSpan: 12,
      minimumColumnSpan: 4,
      minimumRowSpan: 3,
      preferredColumnSpan: 4,
      preferredRowSpan: 3,
    });
    expect(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION.fullWidthEligible).toBe(true);
    expect(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION.supportedStates).toContain("stale_retrying");
    expect(Object.isFrozen(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION)).toBe(true);
    expect(Object.isFrozen(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION.layoutConstraints.desktop)).toBe(
      true,
    );
  });

  it("validates the complete registry generically and rejects identity or hash collisions", () => {
    expect(validatePresentationWidgetRegistry(PRESENTATION_WIDGET_DEFINITIONS)).toBe(
      PRESENTATION_WIDGET_DEFINITIONS,
    );
    expect(() =>
      validatePresentationWidgetRegistry([
        ...PRESENTATION_WIDGET_DEFINITIONS,
        HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
      ]),
    ).toThrow("Duplicate presentation widget definition");
    expect(() =>
      validatePresentationWidgetRegistry([
        ...PRESENTATION_WIDGET_DEFINITIONS,
        { ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION, id: "hr.leave.second-face" },
      ]),
    ).toThrow("Duplicate presentation widget definition");
    expect(() =>
      validatePresentationWidgetRegistry([
        {
          ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
          canonicalHash: "f".repeat(64),
          id: "hr.leave.z-face",
        },
        HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
      ]),
    ).toThrow("Invalid presentation widget registry order");
  });

  it("canonicalizes arbitrary configuration keys by locale-independent code-unit order", () => {
    const { canonicalHash: _canonicalHash, ...manifest } = HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION;
    const canonical = canonicalizePresentationWidgetDefinition({
      ...manifest,
      configurationSchema: { z: true, ä: true },
    });
    expect(canonical.indexOf('"z"')).toBeLessThan(canonical.indexOf('"ä"'));
  });

  it("rejects definition drift and executable manifest extensions", () => {
    const cyclicConfiguration: Record<string, unknown> = {};
    cyclicConfiguration.self = cyclicConfiguration;
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        executableImport: "private/widget.js",
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        requiredCapabilityIds: ["unsafe capability"],
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        semanticIcon: "arbitrary-svg",
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        configurationSchema: cyclicConfiguration,
      }),
    ).toThrow("Invalid presentation widget definition");
  });

  it("accepts only the code-owned semantic icon registry and declares one fallback", () => {
    expect(presentationSemanticIconKeys).toContain("modules");
    expect(presentationSemanticIconKeys).toContain("menu");
    expect(presentationSemanticIconKeys).toContain("calendar-check");
    expect(presentationSemanticIconKeys).toContain("generic-service");
    expect(presentationSemanticIconKeys).not.toContain("service-groups");
    expect(presentationSemanticIconKeys).not.toContain("page-menu");
    expect(parsePresentationSemanticIconKey("calendar-check")).toBe("calendar-check");
    expect(() => parsePresentationSemanticIconKey("package/private-icon")).toThrow(
      "Invalid presentation semantic icon",
    );
  });
});
