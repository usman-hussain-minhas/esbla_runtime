import { describe, expect, it } from "vitest";
import {
  hrWorkforceChangeStatusBodySchema,
  hrWorkforceCreateProfileBodySchema,
  hrWorkforceLinkPrincipalBodySchema,
  hrWorkforceOwnQuerySchema,
  hrWorkforceProfilePathSchema,
  hrWorkforceProfileSchema,
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
