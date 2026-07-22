import { describe, expect, it } from "vitest";
import {
  buildWorkforceDetailApiPath,
  buildWorkforceDetailHistoryHref,
  decodeWorkforceDetailResponse,
  parseWorkforceDetailNavigation,
  WorkforceProfileDetailUiError,
  workforceDetailReturnLink,
  workforceDetailStateForError,
} from "./hr-workforce-profile-detail-core";

const workerProfileId = "11111111-1111-4111-8111-111111111111";
const managerProfileId = "22222222-2222-4222-8222-222222222222";
const relationshipId = "33333333-3333-4333-8333-333333333333";
const statusHistoryId = "44444444-4444-4444-8444-444444444444";
const effectiveAt = "2026-07-22T00:00:00.000Z";
const detail = {
  employeeNumber: "EMP-001",
  principalLinked: true,
  relationshipHistory: {
    items: [
      {
        effectiveAt,
        managerWorkerProfileId: managerProfileId,
        relationshipStatus: "assigned",
        relationshipVersion: 2,
        reportingRelationshipId: relationshipId,
        supersedesReportingRelationshipId: null,
        workerProfileId,
      },
    ],
    nextCursor: { relationshipVersion: 2, reportingRelationshipId: relationshipId },
  },
  statusHistory: {
    items: [
      {
        effectiveAt,
        newStatus: "active",
        previousStatus: "draft",
        workforceStatusHistoryId: statusHistoryId,
      },
    ],
    nextCursor: { effectiveAt, workforceStatusHistoryId: statusHistoryId },
  },
  version: 3,
  workerProfileId,
  workforceStatus: "active",
} as const;
function response(
  body: unknown,
  status = 200,
  contentType = status >= 400
    ? "Application/Problem+JSON; Charset=UTF-8"
    : "application/json; charset=utf-8",
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
    detail: "sensitive database detail",
    instance: `/v1/hr/workforce-profiles/by-id/${workerProfileId}`,
    requestId: "55555555-5555-4555-8555-555555555555",
    status,
    title: "Request failed",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}
describe("Workforce Profile authorized-detail rendered core", () => {
  it("strictly parses only paired independent history cursors and safe return context", () => {
    const raw = {
      relationshipCursorReportingRelationshipId: relationshipId,
      relationshipCursorVersion: "2",
      returnContext: "direct-reports",
      statusCursorEffectiveAt: effectiveAt,
      statusCursorWorkforceStatusHistoryId: statusHistoryId,
    };
    expect(parseWorkforceDetailNavigation(raw)).toEqual({
      relationshipCursor: { relationshipVersion: 2, reportingRelationshipId: relationshipId },
      returnContext: "direct-reports",
      statusCursor: { effectiveAt, workforceStatusHistoryId: statusHistoryId },
    });
    expect(parseWorkforceDetailNavigation({ returnContext: "unknown" })).toEqual({
      returnContext: null,
    });
    for (const invalid of [
      { relationshipCursorVersion: "2" },
      { relationshipCursorReportingRelationshipId: relationshipId },
      { statusCursorEffectiveAt: effectiveAt },
      { statusCursorWorkforceStatusHistoryId: statusHistoryId },
      { relationshipCursorReportingRelationshipId: "invalid", relationshipCursorVersion: "2" },
      { relationshipCursorReportingRelationshipId: relationshipId, relationshipCursorVersion: "0" },
      {
        statusCursorEffectiveAt: "2026-07-22",
        statusCursorWorkforceStatusHistoryId: statusHistoryId,
      },
      { returnContext: ["own"] },
      { actorPrincipalId: managerProfileId },
      { unexpected: "value" },
    ]) {
      expect(() => parseWorkforceDetailNavigation(invalid)).toThrow();
    }
  });

  it("builds the exact bounded API query without forwarding navigation authority", () => {
    const navigation = parseWorkforceDetailNavigation({
      relationshipCursorReportingRelationshipId: relationshipId,
      relationshipCursorVersion: "2",
      returnContext: "admin",
      statusCursorEffectiveAt: effectiveAt,
      statusCursorWorkforceStatusHistoryId: statusHistoryId,
    });
    expect(buildWorkforceDetailApiPath(workerProfileId, navigation)).toBe(
      `/v1/hr/workforce-profiles/by-id/${workerProfileId}?pageSize=10` +
        `&relationshipCursorVersion=2&relationshipCursorReportingRelationshipId=${relationshipId}` +
        `&statusCursorEffectiveAt=2026-07-22T00%3A00%3A00.000Z` +
        `&statusCursorWorkforceStatusHistoryId=${statusHistoryId}`,
    );
    expect(() => buildWorkforceDetailApiPath("invalid", navigation)).toThrow();
  });

  it("preserves the other history cursor and whitelists return navigation", () => {
    const navigation = parseWorkforceDetailNavigation({
      relationshipCursorReportingRelationshipId: relationshipId,
      relationshipCursorVersion: "2",
      returnContext: "own",
      statusCursorEffectiveAt: effectiveAt,
      statusCursorWorkforceStatusHistoryId: statusHistoryId,
    });
    expect(workforceDetailReturnLink(navigation.returnContext)).toEqual({
      href: "/workspace/hr/profile",
      label: "Back to my profile",
    });
    expect(workforceDetailReturnLink("direct-reports").href).toBe(
      "/workspace/hr/profile/direct-reports",
    );
    expect(workforceDetailReturnLink("admin").href).toBe("/workspace/hr/profile/admin");
    expect(workforceDetailReturnLink(null).href).toBe("/workspace/hr");
    const root = `/workspace/hr/profile/by-id/${workerProfileId}?returnContext=own`;
    const relationship = `relationshipCursorVersion=2&relationshipCursorReportingRelationshipId=${relationshipId}`;
    const status = `statusCursorEffectiveAt=2026-07-22T00%3A00%3A00.000Z&statusCursorWorkforceStatusHistoryId=${statusHistoryId}`;
    const nextRelationship = { relationshipVersion: 1, reportingRelationshipId: relationshipId };
    const nextStatus = {
      effectiveAt: "2026-07-21T00:00:00.000Z",
      workforceStatusHistoryId: statusHistoryId,
    };
    const updates = [
      { history: "status", nextCursor: nextStatus },
      { history: "status", nextCursor: null },
      { history: "relationship", nextCursor: nextRelationship },
      { history: "relationship", nextCursor: null },
    ] as const;
    expect(
      updates.map((update) => buildWorkforceDetailHistoryHref(workerProfileId, navigation, update)),
    ).toEqual([
      `${root}&${relationship}&statusCursorEffectiveAt=2026-07-21T00%3A00%3A00.000Z&statusCursorWorkforceStatusHistoryId=${statusHistoryId}`,
      `${root}&${relationship}`,
      `${root}&relationshipCursorVersion=1&relationshipCursorReportingRelationshipId=${relationshipId}&${status}`,
      `${root}&${status}`,
    ]);
  });

  it("accepts only exact 200 enriched detail bound to the requested worker", async () => {
    const empty = {
      ...detail,
      relationshipHistory: { items: [], nextCursor: null },
      statusHistory: { items: [], nextCursor: null },
    };
    for (const valid of [detail, empty]) {
      await expect(
        decodeWorkforceDetailResponse(Promise.resolve(response(valid)), workerProfileId),
      ).resolves.toEqual(valid);
    }
    const { relationshipHistory: _relationships, statusHistory: _statuses, ...base } = detail;
    for (const invalid of [
      response(base),
      response({ ...detail, workerProfileId: managerProfileId }),
      response({
        ...detail,
        relationshipHistory: {
          ...detail.relationshipHistory,
          items: [{ ...detail.relationshipHistory.items[0], workerProfileId: managerProfileId }],
        },
      }),
      response({ ...detail, actorPrincipalId: managerProfileId }),
      response(detail, 201),
      response(detail, 200, "text/plain"),
      response(detail, 200, "application/json", "false"),
    ]) {
      await expect(
        decodeWorkforceDetailResponse(Promise.resolve(invalid), workerProfileId),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
  });

  it("strictly maps bounded Problem Details without retaining sensitive detail", async () => {
    for (const [code, status, kind] of [
      ["POLICY_DENIED", 403, "denied"],
      ["ACTOR_NOT_ACTIVE_MEMBER", 403, "denied"],
      ["WORKFORCE_PROFILE_NOT_FOUND", 404, "not_found"],
      ["WORKFORCE_PROFILE_CONFLICT", 409, "conflict"],
      ["REQUEST_VALIDATION_FAILED", 400, "validation"],
      ["WORKFORCE_SERVICE_INACTIVE", 503, "inactive"],
      ["ACTIVATION_DEPENDENCY_BLOCKED", 503, "dependency_unavailable"],
    ] as const) {
      const error = await decodeWorkforceDetailResponse(
        Promise.resolve(response(problem(code, status), status)),
        workerProfileId,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(String(error)).not.toContain("database");
    }
    for (const invalid of [
      response(problem("POLICY_DENIED", 403), 409),
      response({ ...problem("POLICY_DENIED", 403), tenantId: managerProfileId }, 403),
      response(problem("POLICY_DENIED", 403), 403, "application/json"),
    ]) {
      await expect(
        decodeWorkforceDetailResponse(Promise.resolve(invalid), workerProfileId),
      ).rejects.toMatchObject({ kind: "operational_error" });
    }
    await expect(
      decodeWorkforceDetailResponse(Promise.reject(new Error("socket secret")), workerProfileId),
    ).rejects.toMatchObject({ kind: "operational_error" });
  });

  it("produces fixed safe rendered states and never echoes upstream details", () => {
    for (const kind of [
      "conflict",
      "denied",
      "dependency_unavailable",
      "inactive",
      "not_found",
      "operational_error",
      "validation",
    ] as const) {
      const state = workforceDetailStateForError(new WorkforceProfileDetailUiError(kind));
      expect(state.status).toBe(kind);
      expect(state.message).not.toContain("database");
      expect(state.title.length).toBeGreaterThan(0);
    }
  });
});
