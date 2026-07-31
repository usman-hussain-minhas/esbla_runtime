import { describe, expect, it } from "vitest";
import { getSurfaceDefinition } from "../theme/zen-theme/v1";
import {
  getEligibleZenSurfaceSections,
  resolveEligibleZenSurfaceSections,
  ZEN_SURFACE_SECTION_REGISTRY,
} from "./zen-section-rail-core";

describe("Zen surface section rail eligibility", () => {
  it("registers exactly one overview section for each initial Mission Control surface", () => {
    expect(ZEN_SURFACE_SECTION_REGISTRY).toEqual({
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
            ],
          },
        ],
        surfaceBaseVersion: 1,
        surfaceCanonicalHash: "b93cd55e7e3adf7da82346c21752439ef57938f8310403c98b75421c574be481",
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
            ],
          },
        ],
        surfaceBaseVersion: 1,
        surfaceCanonicalHash: "41a1378dfde6776b82a645971efbef53e59776892bb01ddaced10b57bc035609",
        surfaceDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
      },
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
