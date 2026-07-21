import { describe, expect, it } from "vitest";
import {
  hrReportingRelationshipSchema,
  hrWorkforceChangeReportingRelationshipBodySchema,
  hrWorkforceChangeStatusBodySchema,
  hrWorkforceCreateProfileBodySchema,
  hrWorkforceLinkPrincipalBodySchema,
  hrWorkforceOwnQuerySchema,
  hrWorkforceProfilePathSchema,
  hrWorkforceProfileSchema,
  parseHrReportingRelationship,
  parseHrWorkforceChangeReportingRelationshipBody,
  parseHrWorkforceChangeStatusBody,
  parseHrWorkforceCreateProfileBody,
  parseHrWorkforceLinkPrincipalBody,
  parseHrWorkforceOwnQuery,
  parseHrWorkforceProfile,
  parseHrWorkforceProfilePath,
} from "./hr-workforce-profile-api.js";

const profileId = "10000000-0000-4000-8000-000000000001";
const principalId = "10000000-0000-4000-8000-000000000002";
const profile = {
  employeeNumber: " EMP-OPAQUE ",
  principalLinked: true,
  version: 3,
  workerProfileId: profileId,
  workforceStatus: "active",
} as const;

describe("Workforce Profile API contracts", () => {
  it("publishes the exact ratified request and response identities", () => {
    expect([
      hrWorkforceCreateProfileBodySchema.$id,
      hrWorkforceLinkPrincipalBodySchema.$id,
      hrWorkforceOwnQuerySchema.$id,
      hrWorkforceChangeStatusBodySchema.$id,
      hrWorkforceProfileSchema.$id,
      hrWorkforceProfilePathSchema.$id,
    ]).toEqual([
      "HrWorkforceCreateProfileRequestV1",
      "HrWorkforceLinkPrincipalRequestV1",
      "HrWorkforceOwnQueryV1",
      "HrWorkforceChangeStatusRequestV1",
      "HrWorkforceProfileResponseV1",
      "HrWorkforceProfilePathV1",
    ]);
  });

  it("publishes the exact reporting relationship contract identities and fields", () => {
    const request = hrWorkforceChangeReportingRelationshipBodySchema;
    const response = hrReportingRelationshipSchema;
    expect([request.$id, response.$id]).toEqual([
      "HrWorkforceChangeReportingRelationshipRequestV1",
      "HrReportingRelationshipResponseV1",
    ]);
    const requestFields = "expectedVersion managerWorkerProfileId relationshipStatus".split(" ");
    expect(Object.keys(request.properties).sort()).toEqual(requestFields);
    expect([...request.required].sort()).toEqual(requestFields);
    const responseFields =
      "effectiveAt managerWorkerProfileId relationshipStatus relationshipVersion reportingRelationshipId supersedesReportingRelationshipId workerProfileId workerProfileVersion";
    expect(Object.keys(response.properties).sort()).toEqual(responseFields.split(" "));
    expect([...response.required].sort()).toEqual(Object.keys(response.properties).sort());
  });
  it("enforces the reporting request status and nullable-manager invariant", () => {
    const parse = parseHrWorkforceChangeReportingRelationshipBody;
    const assigned = {
      expectedVersion: 3,
      managerWorkerProfileId: principalId,
      relationshipStatus: "assigned",
    };
    const unassigned = {
      expectedVersion: 3,
      managerWorkerProfileId: null,
      relationshipStatus: "unassigned",
    };
    expect(parse(assigned)).toBe(assigned);
    expect(parse(unassigned)).toBe(unassigned);
    for (const invalid of [
      { ...assigned, managerWorkerProfileId: null },
      { ...unassigned, managerWorkerProfileId: principalId },
      { ...assigned, expectedVersion: "3" },
      { ...assigned, managerWorkerProfileId: "invalid" },
      { ...assigned, relationshipStatus: "pending" },
      { ...assigned, tenantId: profileId },
    ]) {
      expect(() => parse(invalid)).toThrow();
    }
  });
  it("accepts only the exact reporting relationship response", () => {
    const parse = parseHrReportingRelationship;
    const relationship = {
      effectiveAt: "2026-07-22T00:00:00.000Z",
      managerWorkerProfileId: principalId,
      relationshipStatus: "assigned",
      relationshipVersion: 2,
      reportingRelationshipId: "10000000-0000-4000-8000-000000000003",
      supersedesReportingRelationshipId: null,
      workerProfileId: profileId,
      workerProfileVersion: 4,
    };
    const unassigned = {
      ...relationship,
      managerWorkerProfileId: null,
      relationshipStatus: "unassigned",
      supersedesReportingRelationshipId: relationship.reportingRelationshipId,
    };
    expect(parse(relationship)).toBe(relationship);
    expect(parse(unassigned)).toBe(unassigned);
    for (const invalid of [
      { ...relationship, managerWorkerProfileId: null },
      { ...unassigned, managerWorkerProfileId: principalId },
      { ...relationship, effectiveAt: "today" },
      { ...relationship, relationshipVersion: 0 },
      { ...relationship, reportingRelationshipId: "invalid" },
      { ...unassigned, supersedesReportingRelationshipId: "invalid" },
      { ...relationship, workerProfileId: "invalid" },
      { ...relationship, workerProfileVersion: "4" },
      { ...relationship, actorPrincipalId: principalId },
    ]) {
      expect(() => parse(invalid)).toThrow();
    }
  });
  it("preserves optional opaque employee numbers and rejects injected create fields", () => {
    for (const body of [{}, { employeeNumber: null }, { employeeNumber: " EMP-001 " }]) {
      expect(parseHrWorkforceCreateProfileBody(body)).toBe(body);
    }
    for (const invalid of [null, [], { employeeNumber: 1 }, { tenantId: profileId }]) {
      expect(() => parseHrWorkforceCreateProfileBody(invalid)).toThrow();
    }
  });

  it("strictly parses link, status, own-query, and path inputs without coercion", () => {
    const link = { expectedVersion: 1, principalId };
    const status = { expectedVersion: 2, status: "active" };
    const path = { workerProfileId: profileId };
    const query = {};
    expect(parseHrWorkforceLinkPrincipalBody(link)).toBe(link);
    expect(parseHrWorkforceChangeStatusBody(status)).toBe(status);
    expect(parseHrWorkforceProfilePath(path)).toBe(path);
    expect(parseHrWorkforceOwnQuery(query)).toBe(query);
    for (const invalid of [
      { expectedVersion: "1", principalId },
      { expectedVersion: 1, principalId: "invalid" },
      { expectedVersion: 1, status: "draft" },
      { expectedVersion: Number.MAX_SAFE_INTEGER + 1, status: "active" },
      { workerProfileId: "invalid" },
      { unexpected: true },
    ]) {
      expect(() => {
        if ("principalId" in invalid) parseHrWorkforceLinkPrincipalBody(invalid);
        else if ("status" in invalid) parseHrWorkforceChangeStatusBody(invalid);
        else if ("workerProfileId" in invalid) parseHrWorkforceProfilePath(invalid);
        else parseHrWorkforceOwnQuery(invalid);
      }).toThrow();
    }
  });

  it("accepts only the exact five-field privacy-minimized profile response", () => {
    expect(parseHrWorkforceProfile(profile)).toBe(profile);
    const { version: _version, ...missingVersion } = profile;
    for (const invalid of [
      missingVersion,
      { ...profile, tenantId: profileId },
      { ...profile, principalLinked: "true" },
      { ...profile, version: 0 },
      { ...profile, workerProfileId: "invalid" },
      { ...profile, workforceStatus: "unknown" },
    ]) {
      expect(() => parseHrWorkforceProfile(invalid)).toThrow();
    }
  });
});
