import { describe, expect, it } from "vitest";
import {
  hrEmploymentCreateRecordBodySchema,
  hrEmploymentCreateVersionBodySchema,
  hrEmploymentDetailQuerySchema,
  hrEmploymentEndRecordBodySchema,
  hrEmploymentListQuerySchema,
  hrEmploymentListResponseSchema,
  hrEmploymentRecordPathSchema,
  hrEmploymentRecordSchema,
  hrEmploymentRecordVersionSchema,
  parseHrEmploymentCreateRecordBody,
  parseHrEmploymentCreateVersionBody,
  parseHrEmploymentDetailQuery,
  parseHrEmploymentEndRecordBody,
  parseHrEmploymentListQuery,
  parseHrEmploymentListResponse,
  parseHrEmploymentRecord,
  parseHrEmploymentRecordPath,
  parseHrEmploymentRecordVersion,
} from "./hr-employment-record-api.js";

const employmentRecordId = "10000000-0000-4000-8000-000000000001";
const workerProfileId = "10000000-0000-4000-8000-000000000002";
const employmentRecordVersionId = "10000000-0000-4000-8000-000000000003";
const successorVersionId = "10000000-0000-4000-8000-000000000004";
const createdAt = "2026-07-23T08:00:00.000Z";
const effectiveVersion = {
  effectiveFrom: "2026-07-01",
  effectiveTo: "2026-07-31",
  employmentTypeCode: " Fixed Term ",
  kind: "effective",
  organizationReference: " org:opaque ",
  positionReference: null,
  rowVersion: 1,
  supersedesVersionId: null,
  terminal: false,
  version: 1,
  employmentRecordVersionId,
} as const;
const endVersion = {
  ...effectiveVersion,
  effectiveTo: "2026-07-25",
  kind: "end",
  supersedesVersionId: employmentRecordVersionId,
  terminal: true,
  version: 2,
  employmentRecordVersionId: successorVersionId,
} as const;
const activeSummary = {
  createdAt,
  currentVersion: effectiveVersion,
  employmentRecordId,
  status: "active",
  version: 2,
  workerProfileId,
} as const;

describe("Employment Record API contracts", () => {
  it("publishes stable exact request and response schema identities", () => {
    expect([
      hrEmploymentCreateRecordBodySchema.$id,
      hrEmploymentCreateVersionBodySchema.$id,
      hrEmploymentEndRecordBodySchema.$id,
      hrEmploymentRecordPathSchema.$id,
      hrEmploymentListQuerySchema.$id,
      hrEmploymentDetailQuerySchema.$id,
      hrEmploymentRecordVersionSchema.$id,
      hrEmploymentRecordSchema.$id,
      hrEmploymentListResponseSchema.$id,
    ]).toEqual([
      "HrEmploymentCreateRecordRequestV1",
      "HrEmploymentCreateVersionRequestV1",
      "HrEmploymentEndRecordRequestV1",
      "HrEmploymentRecordPathV1",
      "HrEmploymentListQueryV1",
      "HrEmploymentDetailQueryV1",
      "HrEmploymentRecordVersionResponseV1",
      "HrEmploymentRecordResponseV1",
      "HrEmploymentListResponseV1",
    ]);
  });

  it("accepts only the exact worker-profile-bound create request and record path", () => {
    const create = { workerProfileId };
    const path = { employmentRecordId };
    expect(parseHrEmploymentCreateRecordBody(create)).toBe(create);
    expect(parseHrEmploymentRecordPath(path)).toBe(path);
    for (const invalid of [
      {},
      { workerProfileId: "invalid" },
      { workerProfileId, tenantId: employmentRecordId },
    ]) {
      expect(() => parseHrEmploymentCreateRecordBody(invalid)).toThrow();
    }
    for (const invalid of [
      {},
      { employmentRecordId: "invalid" },
      { employmentRecordId, actorPrincipalId: employmentRecordId },
    ]) {
      expect(() => parseHrEmploymentRecordPath(invalid)).toThrow();
    }
  });

  it("strictly parses immutable effective-version creation without coercion", () => {
    const body = {
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
      employmentTypeCode: "opaque code",
      expectedCurrentVersion: null,
      expectedVersion: 1,
      organizationReference: null,
      positionReference: " position:opaque ",
    };
    expect(parseHrEmploymentCreateVersionBody(body)).toBe(body);
    const successor = { ...body, effectiveTo: "2026-07-01", expectedCurrentVersion: 1 };
    expect(parseHrEmploymentCreateVersionBody(successor)).toBe(successor);
    for (const invalid of [
      { ...body, extra: true },
      { ...body, expectedVersion: 0 },
      { ...body, expectedVersion: 2_147_483_648 },
      { ...body, expectedCurrentVersion: "1" },
      { ...body, effectiveFrom: "2026-02-30" },
      { ...body, effectiveTo: "2026-06-30" },
      { ...body, employmentTypeCode: "   " },
      { ...body, organizationReference: 3 },
      { ...body, positionReference: undefined },
    ]) {
      expect(() => parseHrEmploymentCreateVersionBody(invalid)).toThrow();
    }
  });

  it("requires an exact positive-current-version end request and valid inclusive end date", () => {
    const body = { effectiveTo: "2026-07-31", expectedCurrentVersion: 2, expectedVersion: 3 };
    expect(parseHrEmploymentEndRecordBody(body)).toBe(body);
    for (const invalid of [
      { ...body, effectiveTo: "2026-02-30" },
      { ...body, expectedCurrentVersion: null },
      { ...body, expectedCurrentVersion: 0 },
      { ...body, expectedVersion: 2_147_483_648 },
      { ...body, deleteHistory: true },
    ]) {
      expect(() => parseHrEmploymentEndRecordBody(invalid)).toThrow();
    }
  });

  it("binds list and history cursors as strict pairs with a 50-item limit", () => {
    const list = {
      cursorCreatedAt: createdAt,
      cursorEmploymentRecordId: employmentRecordId,
      pageSize: 50,
    };
    const detail = {
      cursorVersion: 2,
      cursorEmploymentRecordVersionId: successorVersionId,
      pageSize: 1,
    };
    expect(parseHrEmploymentListQuery({})).toEqual({});
    expect(parseHrEmploymentDetailQuery({})).toEqual({});
    expect(parseHrEmploymentListQuery(list)).toBe(list);
    expect(parseHrEmploymentDetailQuery(detail)).toBe(detail);
    for (const invalid of [
      { cursorCreatedAt: createdAt },
      { cursorEmploymentRecordId: employmentRecordId },
      { ...list, cursorCreatedAt: "2026-07-23T08:00:00Z" },
      { ...list, pageSize: 51 },
      { ...list, actorPrincipalId: employmentRecordId },
    ]) {
      expect(() => parseHrEmploymentListQuery(invalid)).toThrow();
    }
    for (const invalid of [
      { cursorVersion: 2 },
      { cursorEmploymentRecordVersionId: successorVersionId },
      { ...detail, cursorVersion: 0 },
      { ...detail, cursorVersion: 2_147_483_648 },
      { ...detail, cursorEmploymentRecordVersionId: "invalid" },
      { ...detail, pageSize: "1" },
    ]) {
      expect(() => parseHrEmploymentDetailQuery(invalid)).toThrow();
    }
  });

  it("strictly preserves the fixed privacy-minimized version projection", () => {
    expect(parseHrEmploymentRecordVersion(effectiveVersion)).toBe(effectiveVersion);
    expect(parseHrEmploymentRecordVersion(endVersion)).toBe(endVersion);
    for (const invalid of [
      { ...effectiveVersion, actorPrincipalId: employmentRecordId },
      { ...effectiveVersion, effectiveFrom: "2026-02-30" },
      { ...effectiveVersion, effectiveTo: "2026-06-30" },
      { ...effectiveVersion, rowVersion: 0 },
      { ...effectiveVersion, version: 2_147_483_648 },
      { ...effectiveVersion, employmentRecordVersionId: "invalid" },
      { ...effectiveVersion, supersedesVersionId: "invalid" },
      { ...effectiveVersion, employmentTypeCode: "" },
      { ...effectiveVersion, kind: "end" },
      { ...endVersion, terminal: false },
    ]) {
      expect(() => parseHrEmploymentRecordVersion(invalid)).toThrow();
    }
  });

  it("accepts exact draft, active, and ended detail responses with bounded history", () => {
    const active = {
      ...activeSummary,
      accessScope: "tenant",
      history: {
        items: [effectiveVersion],
        nextCursor: { version: 1, employmentRecordVersionId },
      },
    } as const;
    const draft = {
      ...active,
      accessScope: "own",
      currentVersion: null,
      history: { items: [], nextCursor: null },
      status: "draft",
    } as const;
    const ended = {
      ...active,
      currentVersion: endVersion,
      history: { items: [endVersion, effectiveVersion], nextCursor: null },
      status: "ended",
    } as const;
    expect(parseHrEmploymentRecord(active)).toBe(active);
    expect(parseHrEmploymentRecord(draft)).toBe(draft);
    expect(parseHrEmploymentRecord(ended)).toBe(ended);
    for (const invalid of [
      { ...active, accessScope: "manager" },
      { ...active, tenantId: employmentRecordId },
      { ...active, status: "draft" },
      { ...active, status: "ended" },
      { ...draft, currentVersion: effectiveVersion },
      { ...ended, currentVersion: effectiveVersion },
      { ...active, createdAt: "today" },
      { ...active, history: { items: Array(51).fill(effectiveVersion), nextCursor: null } },
      { ...active, history: { items: [], nextCursor: { version: 1 } } },
      {
        ...active,
        history: {
          items: [{ ...effectiveVersion, evidenceId: employmentRecordId }],
          nextCursor: null,
        },
      },
    ]) {
      expect(() => parseHrEmploymentRecord(invalid)).toThrow();
    }
  });

  it("separates own and tenant list scope without returning detail history", () => {
    for (const accessScope of ["own", "tenant"] as const) {
      const response = {
        accessScope,
        items: [activeSummary],
        nextCursor: { createdAt, employmentRecordId },
      };
      expect(parseHrEmploymentListResponse(response)).toBe(response);
    }
    for (const invalid of [
      { accessScope: "manager", items: [activeSummary], nextCursor: null },
      { accessScope: "own", items: [activeSummary], nextCursor: { createdAt } },
      { accessScope: "own", items: [{ ...activeSummary, history: [] }], nextCursor: null },
      { accessScope: "own", items: Array(51).fill(activeSummary), nextCursor: null },
      {
        accessScope: "own",
        items: [activeSummary],
        nextCursor: null,
        tenantId: employmentRecordId,
      },
    ]) {
      expect(() => parseHrEmploymentListResponse(invalid)).toThrow();
    }
  });
});
