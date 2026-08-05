import { describe, expect, it } from "vitest";
import {
  buildPresentationShortcutsPath,
  decodePresentationShortcutDiscoveryResponse,
  decodePresentationShortcutUpdateResponse,
  getPresentationShortcutContextSurfaceIds,
  PresentationShortcutsError,
  parsePresentationShortcutUpdateRequest,
  replacePresentationShortcutSet,
  selectPresentationShortcutDiscovery,
} from "./presentation-shortcuts-core";

const evidenceEventId = "40000000-0000-4000-8000-000000000001";
const idempotencyKey = "50000000-0000-4000-8000-000000000001";
const home = {
  href: "/",
  id: "surface.mission-control",
  label: "Mission Control",
  semanticIcon: "home",
} as const;
const workforceTarget = {
  href: "/workspace/hr/workforce",
  id: "surface.hr.workforce",
  label: "Workforce",
  semanticIcon: "users-round",
} as const;
const requests = {
  href: "/workspace/hr/requests-and-claims",
  id: "surface.hr.requests-and-claims",
  label: "Requests & Claims",
  semanticIcon: "receipt-text",
} as const;
const universal = {
  contextId: "global",
  contextKind: "global",
  editable: true,
  eligibleTargets: [home, workforceTarget, requests],
  items: [requests],
  settingKey: "navigation.universal_shortcuts.v1",
  tombstoneCount: 0,
  version: 1,
} as const;
const discovery = { contextual: null, universal } as const;
const workforce = {
  contextId: "surface.hr.workforce",
  contextKind: "surface",
  editable: true,
  eligibleTargets: [requests],
  items: [requests],
  settingKey: "navigation.contextual_shortcuts.v1",
  tombstoneCount: 0,
  version: 2,
} as const;

describe("presentation shortcut web boundary", () => {
  it("builds only zero or one canonical exact-surface context query", () => {
    expect(buildPresentationShortcutsPath()).toBe("/v1/platform/presentation/shortcuts");
    expect(
      buildPresentationShortcutsPath({
        contextSurfaceId: "surface.mission-control",
      }),
    ).toBe("/v1/platform/presentation/shortcuts?contextSurfaceId=surface.mission-control");
    expect(() => buildPresentationShortcutsPath({ contextServiceGroupId: "hr" } as never)).toThrow(
      PresentationShortcutsError,
    );
  });

  it("derives shortcut context requests only from currently discovered registered surfaces", () => {
    expect(
      getPresentationShortcutContextSurfaceIds({
        serviceGroups: [
          {
            serviceGroupId: "hr",
            surfaceIds: ["surface.hr.workforce", "surface.hr.requests-and-claims"],
          },
        ],
      }),
    ).toEqual([
      "surface.mission-control",
      "surface.hr.workforce",
      "surface.hr.requests-and-claims",
    ]);
    expect(getPresentationShortcutContextSurfaceIds({ serviceGroups: [] })).toEqual([
      "surface.mission-control",
    ]);
  });

  it("selects the exact registered route or explicit Studio origin without prefix guessing", () => {
    const universalWithCurrentSurface = {
      ...universal,
      items: [workforceTarget, requests],
    } as const;
    const exactUniversal = {
      ...universalWithCurrentSurface,
      items: [home, workforceTarget],
      version: 9,
    } as const;
    const discoveries = [
      { contextual: null, universal: universalWithCurrentSurface },
      { contextual: workforce, universal: exactUniversal },
    ] as const;
    expect(selectPresentationShortcutDiscovery(discoveries, "/workspace/hr/workforce")).toEqual({
      contextual: workforce,
      universal: {
        ...exactUniversal,
        eligibleTargets: [home, requests],
        items: [home],
      },
    });
    expect(universalWithCurrentSurface.items).toEqual([workforceTarget, requests]);
    expect(
      selectPresentationShortcutDiscovery(
        discoveries,
        "/studio/surfaces/surface.hr.workforce/personal",
        "surface.hr.workforce",
      ),
    ).toEqual({
      contextual: workforce,
      universal: {
        ...exactUniversal,
        eligibleTargets: [home, requests],
        items: [home],
      },
    });
    expect(selectPresentationShortcutDiscovery(discoveries, "/workspace/hr/profile/admin")).toEqual(
      { contextual: null, universal: universalWithCurrentSurface },
    );
  });

  it("keeps a surviving contextual result usable when the universal-only request failed", () => {
    const contextualOnly = { contextual: workforce, universal } as const;
    expect(
      selectPresentationShortcutDiscovery([contextualOnly], "/workspace/hr/workforce"),
    ).toEqual({
      contextual: workforce,
      universal: {
        ...universal,
        eligibleTargets: [home, requests],
      },
    });
    expect(
      selectPresentationShortcutDiscovery([contextualOnly], "/workspace/hr/profile/admin"),
    ).toEqual(discovery);
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
      targetId: "surface.hr.requests-and-claims",
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
        contextId: "surface.hr.workforce",
        contextKind: "surface",
        settingKey: "navigation.contextual_shortcuts.v1",
      }),
    ).toThrow(PresentationShortcutsError);

    const surface = {
      ...universal,
      contextId: "surface.hr.workforce",
      contextKind: "surface",
      eligibleTargets: [requests],
      items: [requests],
      settingKey: "navigation.contextual_shortcuts.v1",
    } as const;
    const surfaceDiscovery = { contextual: surface, universal } as const;
    expect(replacePresentationShortcutSet(surfaceDiscovery, { ...surface, version: 2 })).toEqual({
      contextual: { ...surface, version: 2 },
      universal,
    });

    const universalMutationWithActiveSurface = {
      ...universal,
      items: [workforceTarget, requests],
      version: 3,
    } as const;
    expect(
      replacePresentationShortcutSet(
        surfaceDiscovery,
        universalMutationWithActiveSurface,
        "surface.hr.workforce",
      ),
    ).toEqual({
      contextual: surface,
      universal: {
        ...universalMutationWithActiveSurface,
        eligibleTargets: [home, requests],
        items: [requests],
      },
    });
    expect(universalMutationWithActiveSurface.items).toEqual([workforceTarget, requests]);
  });
});
