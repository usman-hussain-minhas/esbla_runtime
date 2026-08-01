import { describe, expect, it } from "vitest";
import {
  buildPresentationShortcutsPath,
  decodePresentationShortcutDiscoveryResponse,
  decodePresentationShortcutUpdateResponse,
  PresentationShortcutsError,
  parsePresentationShortcutUpdateRequest,
  replacePresentationShortcutSet,
} from "./presentation-shortcuts-core";

const evidenceEventId = "40000000-0000-4000-8000-000000000001";
const idempotencyKey = "50000000-0000-4000-8000-000000000001";
const home = {
  href: "/",
  id: "platform.mission_control",
  label: "Mission Control",
  semanticIcon: "home",
} as const;
const leave = {
  href: "/workspace/hr/leave",
  id: "hr.leave.own",
  label: "Leave Requests",
  semanticIcon: "calendar-check",
} as const;
const universal = {
  contextId: "global",
  contextKind: "global",
  editable: true,
  eligibleTargets: [home, leave],
  items: [leave],
  settingKey: "navigation.universal_shortcuts.v1",
  tombstoneCount: 0,
  version: 1,
} as const;
const discovery = { contextual: null, universal } as const;

describe("presentation shortcut web boundary", () => {
  it("builds only zero or one canonical service or surface context query", () => {
    expect(buildPresentationShortcutsPath()).toBe("/v1/platform/presentation/shortcuts");
    expect(buildPresentationShortcutsPath({ contextServiceGroupId: "hr" })).toBe(
      "/v1/platform/presentation/shortcuts?contextServiceGroupId=hr",
    );
    expect(
      buildPresentationShortcutsPath({
        contextSurfaceId: "surface.mission-control",
      }),
    ).toBe("/v1/platform/presentation/shortcuts?contextSurfaceId=surface.mission-control");
    expect(() =>
      buildPresentationShortcutsPath({
        contextServiceGroupId: "hr",
        contextSurfaceId: "surface.mission-control",
      } as never),
    ).toThrow(PresentationShortcutsError);
  });

  it("accepts only exact HTTP 200 strict discovery and update responses", async () => {
    await expect(
      decodePresentationShortcutDiscoveryResponse(
        Promise.resolve(Response.json(discovery, { status: 200 })),
      ),
    ).resolves.toEqual(discovery);
    await expect(
      decodePresentationShortcutDiscoveryResponse(
        Promise.resolve(Response.json({ ...discovery, actorId: "private" }, { status: 200 })),
      ),
    ).rejects.toBeInstanceOf(PresentationShortcutsError);
    await expect(
      decodePresentationShortcutDiscoveryResponse(
        Promise.resolve(Response.json(discovery, { status: 201 })),
      ),
    ).rejects.toBeInstanceOf(PresentationShortcutsError);

    const response = {
      billingState: "non_billable",
      evidenceEventId,
      replayed: false,
      set: universal,
    } as const;
    await expect(
      decodePresentationShortcutUpdateResponse(
        Promise.resolve(Response.json(response, { status: 200 })),
      ),
    ).resolves.toEqual(response);
  });

  it("sanitizes transport and strict Problem Details failures", async () => {
    await expect(
      decodePresentationShortcutDiscoveryResponse(
        Promise.reject(new Error("private upstream detail")),
      ),
    ).rejects.toThrow("Presentation shortcuts are unavailable");
    await expect(
      decodePresentationShortcutUpdateResponse(
        Promise.resolve(
          Response.json(
            {
              code: "POLICY_DENIED",
              detail: "private policy detail",
              instance: "/v1/platform/presentation/shortcuts?private=true",
              requestId: "request-private",
              status: 403,
              title: "Forbidden",
              type: "https://errors.esbla.com/policy-denied",
            },
            { status: 403 },
          ),
        ),
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("strictly separates the browser idempotency key from the API body", () => {
    const request = {
      contextId: "global",
      contextKind: "global",
      expectedVersion: 1,
      idempotencyKey,
      operation: "remove",
      settingKey: "navigation.universal_shortcuts.v1",
      targetId: "hr.leave.own",
    } as const;
    expect(parsePresentationShortcutUpdateRequest(request)).toEqual(request);
    for (const candidate of [
      { ...request, extra: "private" },
      { ...request, idempotencyKey: "invalid" },
      { ...request, contextKind: "service" },
    ]) {
      expect(() => parsePresentationShortcutUpdateRequest(candidate)).toThrow(
        PresentationShortcutsError,
      );
    }
  });

  it("replaces only the exact returned scope in client state", () => {
    expect(replacePresentationShortcutSet(discovery, { ...universal, version: 2 })).toEqual({
      contextual: null,
      universal: { ...universal, version: 2 },
    });
    expect(() =>
      replacePresentationShortcutSet(discovery, {
        ...universal,
        contextId: "hr",
        contextKind: "service",
        settingKey: "navigation.contextual_shortcuts.v1",
      }),
    ).toThrow(PresentationShortcutsError);

    const surface = {
      ...universal,
      contextId: "surface.mission-control",
      contextKind: "surface",
      settingKey: "navigation.contextual_shortcuts.v1",
    } as const;
    const surfaceDiscovery = { contextual: surface, universal } as const;
    expect(replacePresentationShortcutSet(surfaceDiscovery, { ...surface, version: 2 })).toEqual({
      contextual: { ...surface, version: 2 },
      universal,
    });
  });
});
