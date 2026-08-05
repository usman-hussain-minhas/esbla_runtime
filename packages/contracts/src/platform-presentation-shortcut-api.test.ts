import { describe, expect, it } from "vitest";
import {
  PRESENTATION_SHORTCUT_TARGET_DEFINITIONS,
  parsePresentationShortcutDiscovery,
  parsePresentationShortcutDiscoveryQuery,
  parseUpdatePresentationShortcutBody,
  parseUpdatePresentationShortcutResponse,
  presentationShortcutSurfaceContextIds,
} from "./platform-presentation-shortcut-api.js";

const evidenceEventId = "40000000-0000-4000-8000-000000000001";
const home = {
  href: "/",
  id: "surface.mission-control",
  label: "Mission Control",
  semanticIcon: "home",
};
const hrMissionControl = {
  href: "/workspace/hr",
  id: "surface.hr.mission-control",
  label: "HR Mission Control",
  semanticIcon: "users-round",
};
const workforce = {
  href: "/workspace/hr/workforce",
  id: "surface.hr.workforce",
  label: "Workforce",
  semanticIcon: "users-round",
};
const timeAndScheduling = {
  href: "/workspace/hr/time-and-scheduling",
  id: "surface.hr.time-and-scheduling",
  label: "Time & Scheduling",
  semanticIcon: "calendar-range",
};
const requestsAndClaims = {
  href: "/workspace/hr/requests-and-claims",
  id: "surface.hr.requests-and-claims",
  label: "Requests & Claims",
  semanticIcon: "receipt-text",
};

const discovery = {
  contextual: {
    contextId: "surface.hr.mission-control",
    contextKind: "surface",
    editable: true,
    eligibleTargets: [workforce, timeAndScheduling, requestsAndClaims],
    items: [requestsAndClaims],
    settingKey: "navigation.contextual_shortcuts.v1",
    tombstoneCount: 0,
    version: 1,
  },
  universal: {
    contextId: "global",
    contextKind: "global",
    editable: true,
    eligibleTargets: [home, hrMissionControl, workforce, timeAndScheduling, requestsAndClaims],
    items: [requestsAndClaims],
    settingKey: "navigation.universal_shortcuts.v1",
    tombstoneCount: 0,
    version: 1,
  },
} as const;

const missionControlSurfaceDiscovery = {
  ...discovery,
  contextual: {
    contextId: "surface.mission-control",
    contextKind: "surface",
    editable: true,
    eligibleTargets: [hrMissionControl, workforce, timeAndScheduling, requestsAndClaims],
    items: [requestsAndClaims],
    settingKey: "navigation.contextual_shortcuts.v1",
    tombstoneCount: 0,
    version: 1,
  },
} as const;

describe("presentation shortcut API contracts", () => {
  it("registers the exact semantic surfaces as shortcut contexts and targets", () => {
    expect(PRESENTATION_SHORTCUT_TARGET_DEFINITIONS).toEqual([
      home,
      hrMissionControl,
      workforce,
      timeAndScheduling,
      requestsAndClaims,
    ]);
    expect(presentationShortcutSurfaceContextIds).toEqual(
      PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.map(({ id }) => id),
    );
    expect(new Set(PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.map(({ id }) => id)).size).toBe(
      PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.length,
    );
    expect(new Set(PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.map(({ href }) => href)).size).toBe(
      PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.length,
    );
  });

  it("strictly parses canonical universal and exact-surface discovery", () => {
    expect(parsePresentationShortcutDiscovery(discovery)).toEqual(discovery);
    expect(parsePresentationShortcutDiscovery({ ...discovery, contextual: null })).toEqual({
      ...discovery,
      contextual: null,
    });
    expect(parsePresentationShortcutDiscoveryQuery({})).toEqual({});
    expect(() => parsePresentationShortcutDiscoveryQuery({ contextServiceGroupId: "hr" })).toThrow(
      "Invalid presentation shortcut query",
    );
    expect(parsePresentationShortcutDiscovery(missionControlSurfaceDiscovery)).toEqual(
      missionControlSurfaceDiscovery,
    );
    expect(
      parsePresentationShortcutDiscoveryQuery({
        contextSurfaceId: "surface.hr.workforce",
      }),
    ).toEqual({ contextSurfaceId: "surface.hr.workforce" });
    expect(() =>
      parsePresentationShortcutDiscoveryQuery({
        contextServiceGroupId: "hr",
        contextSurfaceId: "surface.mission-control",
      }),
    ).toThrow("Invalid presentation shortcut query");
  });

  it("rejects cross-context, unregistered, ineligible and non-canonical discovery", () => {
    for (const candidate of [
      { ...discovery, actorId: "private" },
      {
        ...discovery,
        contextual: { ...discovery.contextual, contextId: "surface.mission-control" },
      },
      {
        ...discovery,
        universal: {
          ...discovery.universal,
          items: [{ ...requestsAndClaims, id: "private.route" }],
        },
      },
      {
        ...discovery,
        universal: {
          ...discovery.universal,
          eligibleTargets: [requestsAndClaims, home, hrMissionControl],
        },
      },
      {
        ...discovery,
        universal: {
          ...discovery.universal,
          eligibleTargets: [home, hrMissionControl],
          items: [requestsAndClaims],
        },
      },
      {
        ...missionControlSurfaceDiscovery,
        contextual: {
          ...missionControlSurfaceDiscovery.contextual,
          eligibleTargets: [home, hrMissionControl, workforce],
        },
      },
    ]) {
      expect(() => parsePresentationShortcutDiscovery(candidate)).toThrow(
        "Invalid presentation shortcuts",
      );
    }
    for (const query of [
      { contextServiceGroupId: "finance" },
      { contextSurfaceId: "surface.hr.unknown" },
    ]) {
      expect(() => parsePresentationShortcutDiscoveryQuery(query)).toThrow(
        "Invalid presentation shortcut query",
      );
    }
  });

  it("accepts only exact append or remove own-shortcut mutations", () => {
    const append = {
      contextId: "global",
      contextKind: "global",
      expectedVersion: 0,
      operation: "append",
      settingKey: "navigation.universal_shortcuts.v1",
      targetId: "surface.hr.requests-and-claims",
    } as const;
    expect(parseUpdatePresentationShortcutBody(append)).toEqual(append);
    expect(
      parseUpdatePresentationShortcutBody({
        ...append,
        contextId: "surface.hr.mission-control",
        contextKind: "surface",
        operation: "remove",
        settingKey: "navigation.contextual_shortcuts.v1",
      }),
    ).toEqual({
      ...append,
      contextId: "surface.hr.mission-control",
      contextKind: "surface",
      operation: "remove",
      settingKey: "navigation.contextual_shortcuts.v1",
    });
    expect(
      parseUpdatePresentationShortcutBody({
        ...append,
        contextId: "surface.mission-control",
        contextKind: "surface",
        settingKey: "navigation.contextual_shortcuts.v1",
      }),
    ).toEqual({
      ...append,
      contextId: "surface.mission-control",
      contextKind: "surface",
      settingKey: "navigation.contextual_shortcuts.v1",
    });
    expect(() =>
      parseUpdatePresentationShortcutBody({
        ...append,
        contextId: "surface.mission-control",
        contextKind: "surface",
        settingKey: "navigation.contextual_shortcuts.v1",
        targetId: "surface.mission-control",
      }),
    ).toThrow("Invalid presentation shortcut update");
    for (const candidate of [
      { ...append, anchorId: "surface.hr.workforce" },
      { ...append, contextKind: "service" },
      {
        ...append,
        contextId: "hr",
        contextKind: "service",
        settingKey: "navigation.contextual_shortcuts.v1",
      },
      { ...append, operation: "move" },
      { ...append, settingKey: "widget.presentation.visible_fields.v1" },
      { ...append, targetId: "private.route" },
    ]) {
      expect(() => parseUpdatePresentationShortcutBody(candidate)).toThrow(
        "Invalid presentation shortcut update",
      );
    }
  });

  it("strictly parses the non-billable evidence-backed mutation response", () => {
    const response = {
      billingState: "non_billable",
      evidenceEventId,
      replayed: false,
      set: discovery.universal,
    } as const;
    expect(parseUpdatePresentationShortcutResponse(response)).toEqual(response);
    expect(() =>
      parseUpdatePresentationShortcutResponse({ ...response, billingState: "billable" }),
    ).toThrow("Invalid presentation shortcut response");
  });
});
