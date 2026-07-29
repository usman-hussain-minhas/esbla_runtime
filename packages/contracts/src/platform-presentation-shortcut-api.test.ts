import { describe, expect, it } from "vitest";
import {
  PRESENTATION_SHORTCUT_TARGET_DEFINITIONS,
  parsePresentationShortcutDiscovery,
  parsePresentationShortcutDiscoveryQuery,
  parseUpdatePresentationShortcutBody,
  parseUpdatePresentationShortcutResponse,
} from "./platform-presentation-shortcut-api.js";

const evidenceEventId = "40000000-0000-4000-8000-000000000001";
const home = {
  href: "/",
  id: "platform.mission_control",
  label: "Mission Control",
  semanticIcon: "home",
};
const hrMissionControl = {
  href: "/workspace/hr",
  id: "service_group.hr.mission_control",
  label: "HR Mission Control",
  semanticIcon: "users-round",
};
const leave = {
  href: "/workspace/hr/leave",
  id: "hr.leave.own",
  label: "Leave Requests",
  semanticIcon: "calendar-check",
};

const discovery = {
  contextual: {
    contextId: "hr",
    contextKind: "service",
    editable: true,
    eligibleTargets: [hrMissionControl, leave],
    items: [leave],
    settingKey: "navigation.contextual_shortcuts.v1",
    tombstoneCount: 0,
    version: 1,
  },
  universal: {
    contextId: "global",
    contextKind: "global",
    editable: true,
    eligibleTargets: [home, hrMissionControl, leave],
    items: [leave],
    settingKey: "navigation.universal_shortcuts.v1",
    tombstoneCount: 0,
    version: 1,
  },
} as const;

describe("presentation shortcut API contracts", () => {
  it("registers one canonical internal target catalog without route aliases", () => {
    expect(PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.slice(0, 3)).toEqual([
      home,
      hrMissionControl,
      expect.objectContaining({ id: "hr.workforce.own" }),
    ]);
    expect(new Set(PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.map(({ id }) => id)).size).toBe(
      PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.length,
    );
    expect(new Set(PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.map(({ href }) => href)).size).toBe(
      PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.length,
    );
  });

  it("strictly parses canonical universal and exact-service discovery", () => {
    expect(parsePresentationShortcutDiscovery(discovery)).toEqual(discovery);
    expect(parsePresentationShortcutDiscovery({ ...discovery, contextual: null })).toEqual({
      ...discovery,
      contextual: null,
    });
    expect(parsePresentationShortcutDiscoveryQuery({})).toEqual({});
    expect(parsePresentationShortcutDiscoveryQuery({ contextServiceGroupId: "hr" })).toEqual({
      contextServiceGroupId: "hr",
    });
  });

  it("rejects cross-context, unregistered, ineligible and non-canonical discovery", () => {
    for (const candidate of [
      { ...discovery, actorId: "private" },
      {
        ...discovery,
        contextual: { ...discovery.contextual, contextId: "global" },
      },
      {
        ...discovery,
        universal: { ...discovery.universal, items: [{ ...leave, id: "private.route" }] },
      },
      {
        ...discovery,
        universal: {
          ...discovery.universal,
          eligibleTargets: [leave, home, hrMissionControl],
        },
      },
      {
        ...discovery,
        universal: {
          ...discovery.universal,
          eligibleTargets: [home, hrMissionControl],
          items: [leave],
        },
      },
    ]) {
      expect(() => parsePresentationShortcutDiscovery(candidate)).toThrow(
        "Invalid presentation shortcuts",
      );
    }
    expect(() =>
      parsePresentationShortcutDiscoveryQuery({ contextServiceGroupId: "finance" }),
    ).toThrow("Invalid presentation shortcut query");
  });

  it("accepts only exact append or remove own-shortcut mutations", () => {
    const append = {
      contextId: "global",
      contextKind: "global",
      expectedVersion: 0,
      operation: "append",
      settingKey: "navigation.universal_shortcuts.v1",
      targetId: "hr.leave.own",
    } as const;
    expect(parseUpdatePresentationShortcutBody(append)).toEqual(append);
    expect(
      parseUpdatePresentationShortcutBody({
        ...append,
        contextId: "hr",
        contextKind: "service",
        operation: "remove",
        settingKey: "navigation.contextual_shortcuts.v1",
      }),
    ).toEqual({
      ...append,
      contextId: "hr",
      contextKind: "service",
      operation: "remove",
      settingKey: "navigation.contextual_shortcuts.v1",
    });
    for (const candidate of [
      { ...append, anchorId: "hr.workforce.own" },
      { ...append, contextKind: "service" },
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
