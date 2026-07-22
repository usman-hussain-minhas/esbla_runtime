import { describe, expect, it } from "vitest";
import {
  buildWorkforceListApiPath,
  buildWorkforceListHref,
  decodeWorkforceListResponse,
  parseWorkforceListNavigation,
  WorkforceProfileListUiError,
  workforceListDetailHref,
  workforceListStateForError,
} from "./hr-workforce-profile-list-core";

const workerProfileId = "11111111-1111-4111-8111-111111111111";
const managerProfileId = "22222222-2222-4222-8222-222222222222";
const relationshipId = "33333333-3333-4333-8333-333333333333";
const otherRelationshipId = "44444444-4444-4444-8444-444444444444";
const effectiveAt = "2026-07-22T00:00:00.000Z";
const createdAt = "2026-07-21T00:00:00.000Z";
const profile = {
  employeeNumber: "EMP-001",
  principalLinked: true,
  version: 3,
  workerProfileId,
  workforceStatus: "active",
} as const;
const directReportsPage = {
  items: [
    {
      profile,
      relationship: {
        effectiveAt,
        managerWorkerProfileId: managerProfileId,
        relationshipStatus: "assigned",
        relationshipVersion: 2,
        reportingRelationshipId: relationshipId,
        supersedesReportingRelationshipId: null,
        workerProfileId,
        workerProfileVersion: 3,
      },
    },
  ],
  kind: "direct_reports",
  nextCursor: { effectiveAt, reportingRelationshipId: relationshipId },
} as const;
const workforcePage = {
  items: [profile],
  kind: "workforce",
  nextCursor: { createdAt, workerProfileId },
} as const;

function response(
  body: unknown,
  status = 200,
  contentType = status >= 400
    ? "Application/Problem+JSON; Charset=UTF-8"
    : "Application/JSON; Charset=UTF-8",
  replay?: string,
) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": contentType,
      ...(replay === undefined ? {} : { "idempotent-replayed": replay }),
    },
    status,
  });
}

function problem(code: string, status: number) {
  return {
    code,
    detail: "sensitive upstream detail",
    instance: "/v1/hr/workforce-profiles?private=true",
    requestId: "55555555-5555-4555-8555-555555555555",
    status,
    title: "Upstream failure",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

describe("Workforce Profile authorized-list rendered core", () => {
  it("keeps manager and HR navigation branches disjoint and strictly paired", () => {
    expect(
      parseWorkforceListNavigation(
        { cursorEffectiveAt: effectiveAt, cursorReportingRelationshipId: relationshipId },
        "direct_reports",
      ),
    ).toEqual({
      cursor: { effectiveAt, reportingRelationshipId: relationshipId },
      view: "direct_reports",
    });
    expect(parseWorkforceListNavigation({}, "workforce")).toEqual({
      status: "active",
      view: "workforce",
    });
    expect(
      parseWorkforceListNavigation(
        { cursorCreatedAt: createdAt, cursorWorkerProfileId: workerProfileId, status: "draft" },
        "workforce",
      ),
    ).toEqual({
      cursor: { createdAt, workerProfileId },
      status: "draft",
      view: "workforce",
    });
    const invalid: readonly ["direct_reports" | "workforce", unknown][] = [
      ["direct_reports", { cursorEffectiveAt: effectiveAt }],
      ["direct_reports", { cursorReportingRelationshipId: relationshipId }],
      [
        "direct_reports",
        { cursorEffectiveAt: "2026-07-22", cursorReportingRelationshipId: relationshipId },
      ],
      [
        "direct_reports",
        { cursorEffectiveAt: effectiveAt, cursorReportingRelationshipId: "invalid" },
      ],
      ["direct_reports", { status: "active" }],
      ["direct_reports", { cursorCreatedAt: createdAt, cursorWorkerProfileId: workerProfileId }],
      ["workforce", { cursorCreatedAt: createdAt }],
      ["workforce", { cursorWorkerProfileId: workerProfileId }],
      ["workforce", { cursorCreatedAt: "2026-07-21", cursorWorkerProfileId: workerProfileId }],
      ["workforce", { cursorCreatedAt: effectiveAt, cursorWorkerProfileId: "invalid" }],
      ["workforce", { status: "unknown" }],
      ["workforce", { cursorEffectiveAt: effectiveAt }],
      [
        "workforce",
        { cursorEffectiveAt: effectiveAt, cursorReportingRelationshipId: relationshipId },
      ],
      ["workforce", { status: ["active"] }],
      ["workforce", { actorPrincipalId: managerProfileId }],
    ];
    for (const [view, value] of invalid) {
      expect(() => parseWorkforceListNavigation(value, view)).toThrow();
    }
  });

  it("builds exact bounded API, pagination, filter-reset, and detail links", () => {
    const direct = parseWorkforceListNavigation(
      { cursorEffectiveAt: effectiveAt, cursorReportingRelationshipId: relationshipId },
      "direct_reports",
    );
    const workforce = parseWorkforceListNavigation(
      { cursorCreatedAt: createdAt, cursorWorkerProfileId: workerProfileId, status: "active" },
      "workforce",
    );
    expect(buildWorkforceListApiPath(direct)).toBe(
      `/v1/hr/workforce-profiles?pageSize=10&cursorEffectiveAt=${encodeURIComponent(effectiveAt)}` +
        `&cursorReportingRelationshipId=${relationshipId}`,
    );
    expect(buildWorkforceListApiPath(workforce)).toBe(
      `/v1/hr/workforce-profiles?pageSize=10&status=active&cursorCreatedAt=${encodeURIComponent(createdAt)}` +
        `&cursorWorkerProfileId=${workerProfileId}`,
    );
    expect(buildWorkforceListHref(direct, directReportsPage.nextCursor)).toBe(
      `/workspace/hr/profile/direct-reports?cursorEffectiveAt=${encodeURIComponent(effectiveAt)}` +
        `&cursorReportingRelationshipId=${relationshipId}`,
    );
    expect(buildWorkforceListHref(direct, null)).toBe("/workspace/hr/profile/direct-reports");
    expect(buildWorkforceListHref(workforce, workforcePage.nextCursor)).toBe(
      `/workspace/hr/profile/admin?status=active&cursorCreatedAt=${encodeURIComponent(createdAt)}` +
        `&cursorWorkerProfileId=${workerProfileId}`,
    );
    expect(buildWorkforceListHref({ status: "suspended", view: "workforce" }, null)).toBe(
      "/workspace/hr/profile/admin?status=suspended",
    );
    expect(workforceListDetailHref(workerProfileId, "direct_reports")).toBe(
      `/workspace/hr/profile/by-id/${workerProfileId}?returnContext=direct-reports`,
    );
    expect(workforceListDetailHref(workerProfileId, "workforce")).toBe(
      `/workspace/hr/profile/by-id/${workerProfileId}?returnContext=admin`,
    );
    for (const path of [buildWorkforceListApiPath(direct), buildWorkforceListApiPath(workforce)]) {
      expect(path).not.toMatch(/tenant|principal|manager/i);
    }
  });

  it("accepts only exact 200 pages bound to the requested server-derived branch", async () => {
    const direct = { view: "direct_reports" } as const;
    const workforce = { status: "active", view: "workforce" } as const;
    await expect(
      decodeWorkforceListResponse(Promise.resolve(response(directReportsPage)), direct),
    ).resolves.toEqual(directReportsPage);
    await expect(
      decodeWorkforceListResponse(Promise.resolve(response(workforcePage)), workforce),
    ).resolves.toEqual(workforcePage);
    await expect(
      decodeWorkforceListResponse(
        Promise.resolve(response({ items: [], kind: "direct_reports", nextCursor: null })),
        direct,
      ),
    ).resolves.toEqual({ items: [], kind: "direct_reports", nextCursor: null });
    for (const [payload, navigation] of [
      [workforcePage, direct],
      [directReportsPage, workforce],
      [{ ...workforcePage, items: [{ ...profile, workforceStatus: "draft" }] }, workforce],
      [
        {
          ...directReportsPage,
          items: [
            {
              ...directReportsPage.items[0],
              relationship: {
                ...directReportsPage.items[0].relationship,
                workerProfileId: managerProfileId,
              },
            },
          ],
        },
        direct,
      ],
      [
        {
          ...directReportsPage,
          items: [
            directReportsPage.items[0],
            {
              ...directReportsPage.items[0],
              relationship: {
                ...directReportsPage.items[0].relationship,
                reportingRelationshipId: otherRelationshipId,
              },
            },
          ],
        },
        direct,
      ],
    ] as const) {
      await expect(
        decodeWorkforceListResponse(Promise.resolve(response(payload)), navigation),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
    for (const invalid of [
      response(directReportsPage, 201),
      response(directReportsPage, 200, "text/json"),
      response(directReportsPage, 200, "application/json", "false"),
      response({ ...directReportsPage, tenantId: managerProfileId }),
    ]) {
      await expect(
        decodeWorkforceListResponse(Promise.resolve(invalid), direct),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
  });

  it("enforces the requested page bound and direct-report head ordering", async () => {
    const navigation = { view: "direct_reports" } as const;
    const secondWorkerProfileId = "66666666-6666-4666-8666-666666666666";
    const second = {
      profile: { ...profile, employeeNumber: "EMP-002", workerProfileId: secondWorkerProfileId },
      relationship: {
        ...directReportsPage.items[0].relationship,
        effectiveAt: "2026-07-23T00:00:00.000Z",
        reportingRelationshipId: otherRelationshipId,
        workerProfileId: secondWorkerProfileId,
      },
    };
    const oversized = Array.from({ length: 11 }, (_, index) => ({
      ...profile,
      workerProfileId: `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
    }));
    for (const invalid of [
      {
        ...directReportsPage,
        items: [
          {
            ...directReportsPage.items[0],
            relationship: {
              ...directReportsPage.items[0].relationship,
              managerWorkerProfileId: null,
              relationshipStatus: "unassigned",
            },
          },
        ],
      },
      {
        ...directReportsPage,
        items: [
          {
            ...directReportsPage.items[0],
            relationship: { ...directReportsPage.items[0].relationship, workerProfileVersion: 4 },
          },
        ],
      },
      {
        ...directReportsPage,
        nextCursor: { effectiveAt, reportingRelationshipId: otherRelationshipId },
      },
      { ...directReportsPage, items: [directReportsPage.items[0], second], nextCursor: null },
    ]) {
      await expect(
        decodeWorkforceListResponse(Promise.resolve(response(invalid)), navigation),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
    await expect(
      decodeWorkforceListResponse(
        Promise.resolve(response({ items: oversized, kind: "workforce", nextCursor: null })),
        { status: "active", view: "workforce" },
      ),
    ).rejects.toMatchObject({ kind: "operational_error" });
  });

  it("maps exact Problem Details to fixed states and rejects unsafe failures", async () => {
    const navigation = { view: "direct_reports" } as const;
    for (const [code, status, kind] of [
      ["POLICY_DENIED", 403, "denied"],
      ["ACTOR_NOT_ACTIVE_MEMBER", 403, "denied"],
      ["WORKFORCE_PROFILE_NOT_FOUND", 404, "not_found"],
      ["WORKFORCE_PROFILE_CONFLICT", 409, "conflict"],
      ["REQUEST_VALIDATION_FAILED", 400, "validation"],
      ["WORKFORCE_INPUT_INVALID", 400, "validation"],
      ["WORKFORCE_SERVICE_INACTIVE", 503, "inactive"],
      ["ACTIVATION_DEPENDENCY_BLOCKED", 503, "dependency_unavailable"],
    ] as const) {
      const error = await decodeWorkforceListResponse(
        Promise.resolve(response(problem(code, status), status)),
        navigation,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(`${JSON.stringify(error)} ${String(error)}`).not.toMatch(/sensitive|private=true/i);
    }
    for (const invalid of [
      response(problem("POLICY_DENIED", 403), 409),
      response({ ...problem("POLICY_DENIED", 403), tenantId: managerProfileId }, 403),
      response(problem("POLICY_DENIED", 403), 403, "application/json"),
    ]) {
      await expect(
        decodeWorkforceListResponse(Promise.resolve(invalid), navigation),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
    await expect(
      decodeWorkforceListResponse(Promise.reject(new Error("socket secret")), navigation),
    ).rejects.toMatchObject({ kind: "operational_error" });
  });

  it("produces fixed truthful state copy without upstream diagnostics", () => {
    for (const kind of [
      "conflict",
      "denied",
      "dependency_unavailable",
      "inactive",
      "not_found",
      "operational_error",
      "validation",
    ] as const) {
      const state = workforceListStateForError(new WorkforceProfileListUiError(kind));
      expect(state.status).toBe(kind);
      expect(state.message).not.toMatch(/sensitive|database|private/i);
      expect(state.title.length).toBeGreaterThan(0);
    }
  });
});
