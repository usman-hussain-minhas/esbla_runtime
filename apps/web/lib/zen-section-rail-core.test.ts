import { describe, expect, it } from "vitest";
import { getSurfaceDefinition } from "../theme/zen-theme/v1";
import {
  getEligibleZenSurfaceSections,
  resolveEligibleZenSurfaceSections,
  ZEN_SURFACE_SECTION_REGISTRY,
} from "./zen-section-rail-core";

describe("Zen surface section rail eligibility", () => {
  it("registers exactly one overview section for every active surface", () => {
    expect(Object.keys(ZEN_SURFACE_SECTION_REGISTRY).sort()).toEqual([
      "surface.hr.mission-control",
      "surface.hr.requests-and-claims",
      "surface.hr.time-and-scheduling",
      "surface.hr.workforce",
      "surface.mission-control",
    ]);
    expect(ZEN_SURFACE_SECTION_REGISTRY).toMatchObject({
      "surface.hr.mission-control": {
        sectionDefinitionVersion: 1,
        sections: [
          {
            authorizedContentAnchorIds: ["hr-services"],
            headingId: "hr-hub-heading",
            id: "overview",
            label: "Overview",
            widgetInstanceIds: [
              "hr-mission-control.my-profile",
              "hr-mission-control.current-employment",
              "hr-mission-control.my-work",
              "hr-mission-control.my-published-shifts",
              "hr-mission-control.my-attendance",
              "hr-mission-control.my-leave",
              "hr-mission-control.my-timesheets",
              "hr-mission-control.my-expenses",
              "hr-mission-control.employment-admin",
              "hr-mission-control.employment-history",
              "hr-mission-control.workforce-admin",
              "hr-mission-control.workforce-status",
              "hr-mission-control.roster-overview",
              "hr-mission-control.roster-publish",
              "hr-mission-control.attendance-reports",
              "hr-mission-control.attendance-corrections",
              "hr-mission-control.leave-assigned",
              "hr-mission-control.leave-history",
              "hr-mission-control.leave-request",
              "hr-mission-control.timesheet-assigned",
              "hr-mission-control.timesheet-draft",
              "hr-mission-control.timesheet-corrections",
              "hr-mission-control.expense-assigned",
              "hr-mission-control.expense-draft",
              "hr-mission-control.expense-corrections",
            ],
          },
        ],
        surfaceBaseVersion: 1,
        surfaceCanonicalHash: "dafe03ca3473b95bc679c67f531dd62c3d5b95c06a5339155a95407733392a4b",
        surfaceDefinitionHash: "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
      },
      "surface.mission-control": {
        sectionDefinitionVersion: 1,
        sections: [
          {
            authorizedContentAnchorIds: [],
            headingId: "mission-control-heading",
            id: "overview",
            label: "Overview",
            widgetInstanceIds: [
              "mission-control.my-work",
              "mission-control.my-published-shifts",
              "mission-control.my-leave",
              "mission-control.my-attendance",
              "mission-control.my-timesheets",
              "mission-control.my-expenses",
              "mission-control.my-profile",
              "mission-control.direct-reports",
              "mission-control.employment-admin",
              "mission-control.employment-history",
              "mission-control.workforce-admin",
              "mission-control.workforce-status",
              "mission-control.my-tasks",
              "mission-control.roster-overview",
              "mission-control.roster-publish",
              "mission-control.attendance-reports",
              "mission-control.attendance-corrections",
              "mission-control.leave-assigned",
              "mission-control.leave-history",
              "mission-control.leave-request",
              "mission-control.timesheet-assigned",
              "mission-control.timesheet-draft",
              "mission-control.timesheet-corrections",
              "mission-control.expense-assigned",
              "mission-control.expense-draft",
              "mission-control.expense-corrections",
            ],
          },
        ],
        surfaceBaseVersion: 1,
        surfaceCanonicalHash: "d6a467292414d34beb296b81f2b40b50132f1ebd8fd040a9a6e2dc4d93c364e3",
        surfaceDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
      },
    });
    expect(ZEN_SURFACE_SECTION_REGISTRY["surface.hr.workforce"]).toMatchObject({
      sections: [
        {
          headingId: "hr-workforce-heading",
          widgetInstanceIds: [
            "hr-workforce.my-profile",
            "hr-workforce.direct-reports",
            "hr-workforce.admin-queue",
            "hr-workforce.status-reporting",
            "hr-workforce.current-employment",
            "hr-workforce.employment-history",
            "hr-workforce.employment-admin-queue",
          ],
        },
      ],
      surfaceCanonicalHash: "d4c9e5727e17afd3b412b2625e362e9e022b69bd6082afebf263a70199a06895",
      surfaceDefinitionHash: "8c945cf827e6949b3f454bd8afdea68351ebbd6de68062933a48845aa3af32c3",
    });
    expect(ZEN_SURFACE_SECTION_REGISTRY["surface.hr.time-and-scheduling"]).toMatchObject({
      sections: [
        {
          headingId: "hr-time-and-scheduling-heading",
          widgetInstanceIds: [
            "hr-time-and-scheduling.my-published-shifts",
            "hr-time-and-scheduling.roster-overview",
            "hr-time-and-scheduling.publish-queue",
            "hr-time-and-scheduling.my-attendance",
            "hr-time-and-scheduling.attendance-reports",
            "hr-time-and-scheduling.attendance-correction-queue",
            "hr-time-and-scheduling.my-timesheets",
            "hr-time-and-scheduling.timesheet-draft",
            "hr-time-and-scheduling.timesheet-assigned",
            "hr-time-and-scheduling.timesheet-corrections",
          ],
        },
      ],
      surfaceCanonicalHash: "bbd0d87dded7676e1894ecb6e644adf7803de1417c5b86c3e770c7955bc88f32",
      surfaceDefinitionHash: "1308489fb489e2638eeafd8e57a9db7de08a8690cca247e69e8492014c3d4629",
    });
    expect(ZEN_SURFACE_SECTION_REGISTRY["surface.hr.requests-and-claims"]).toMatchObject({
      sections: [
        {
          headingId: "hr-requests-and-claims-heading",
          widgetInstanceIds: [
            "hr-requests-and-claims.my-leave",
            "hr-requests-and-claims.leave-request-form",
            "hr-requests-and-claims.leave-assigned",
            "hr-requests-and-claims.leave-history",
            "hr-requests-and-claims.my-expenses",
            "hr-requests-and-claims.expense-draft",
            "hr-requests-and-claims.expense-assigned",
            "hr-requests-and-claims.expense-corrections",
          ],
        },
      ],
      surfaceCanonicalHash: "879b2e93a964a5685392946ef6c5f8c79befea6a6f9328a28432a27dbf476259",
      surfaceDefinitionHash: "2436f49c88ac0e71c1dca8c1c0d9027e86e5c8a92ee2a8a725c7ff19d2caebdc",
    });
  });

  it("keeps the initial rail absent while retaining one eligible semantic section", () => {
    expect(
      getEligibleZenSurfaceSections(getSurfaceDefinition("surface.mission-control"), {
        authorizedContentAnchorIds: [],
        eligibleWidgetInstanceIds: ["mission-control.my-leave"],
      }),
    ).toEqual([
      {
        headingId: "mission-control-heading",
        id: "overview",
        label: "Overview",
      },
    ]);
    expect(
      getEligibleZenSurfaceSections(getSurfaceDefinition("surface.hr.mission-control"), {
        authorizedContentAnchorIds: ["hr-services"],
        eligibleWidgetInstanceIds: [],
      }),
    ).toEqual([
      {
        headingId: "hr-hub-heading",
        id: "overview",
        label: "Overview",
      },
    ]);
  });

  it("fails closed when the caller surface binding or registered contract drifts", () => {
    const surface = getSurfaceDefinition("surface.mission-control");
    expect(() =>
      getEligibleZenSurfaceSections(
        {
          ...surface,
          definitionHash: "0".repeat(64),
        },
        {
          authorizedContentAnchorIds: [],
          eligibleWidgetInstanceIds: ["mission-control.my-leave"],
        },
      ),
    ).toThrow("Invalid Zen surface section binding");
  });

  it("filters empty sections and preserves code order only after eligibility is proved", () => {
    expect(
      resolveEligibleZenSurfaceSections(
        [
          {
            authorizedContentAnchorIds: [],
            headingId: "summary-heading",
            id: "summary",
            label: "Summary",
            widgetInstanceIds: ["widget.summary"],
          },
          {
            authorizedContentAnchorIds: ["authorized-history"],
            headingId: "history-heading",
            id: "history",
            label: "History",
            widgetInstanceIds: ["widget.history"],
          },
          {
            authorizedContentAnchorIds: [],
            headingId: "empty-heading",
            id: "empty",
            label: "Empty",
            widgetInstanceIds: ["widget.empty"],
          },
        ],
        {
          authorizedContentAnchorIds: ["authorized-history"],
          eligibleWidgetInstanceIds: ["widget.summary"],
        },
      ),
    ).toEqual([
      { headingId: "summary-heading", id: "summary", label: "Summary" },
      { headingId: "history-heading", id: "history", label: "History" },
    ]);
  });

  it("fails closed on duplicate semantics or unsafe identifiers", () => {
    expect(() =>
      resolveEligibleZenSurfaceSections(
        [
          {
            authorizedContentAnchorIds: [],
            headingId: "same-heading",
            id: "same",
            label: "Same",
            widgetInstanceIds: ["widget.one"],
          },
          {
            authorizedContentAnchorIds: [],
            headingId: "same-heading",
            id: "same",
            label: "Duplicate",
            widgetInstanceIds: ["widget.two"],
          },
        ],
        {
          authorizedContentAnchorIds: [],
          eligibleWidgetInstanceIds: ["widget.one", "widget.two"],
        },
      ),
    ).toThrow("Invalid Zen surface section registry");
    expect(() =>
      resolveEligibleZenSurfaceSections(
        [
          {
            authorizedContentAnchorIds: [],
            headingId: "Unsafe Heading",
            id: "unsafe",
            label: "Unsafe",
            widgetInstanceIds: ["widget.one"],
          },
        ],
        {
          authorizedContentAnchorIds: [],
          eligibleWidgetInstanceIds: ["widget.one"],
        },
      ),
    ).toThrow("Invalid Zen surface section registry");
  });
});
