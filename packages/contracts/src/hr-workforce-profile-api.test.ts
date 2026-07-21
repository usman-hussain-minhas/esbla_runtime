import { describe, expect, it } from "vitest";
import {
  hrWorkforceChangeStatusBodySchema,
  hrWorkforceCreateProfileBodySchema,
  hrWorkforceLinkPrincipalBodySchema,
  hrWorkforceProfilePathSchema,
  hrWorkforceProfileSchema,
  hrWorkforceServiceActivateBodySchema,
  hrWorkforceServiceControlSchema,
  hrWorkforceServiceDeactivateBodySchema,
  hrWorkforceServiceLifecycleBodySchema,
  parseHrWorkforceProfile,
  parseHrWorkforceServiceControl,
} from "./hr-workforce-profile-api.js";

const profile = {
  createdAt: "2026-07-21T06:00:00.000Z",
  employeeNumber: "EMP-0001",
  principalLinked: false,
  updatedAt: "2026-07-21T06:00:00.000Z",
  version: 1,
  workerProfileId: "10000000-0000-4000-8000-000000000201",
  workforceStatus: "draft",
} as const;

const serviceControl = {
  activationState: "inactive",
  activationVersion: 1,
  serviceKey: "workforce_profile",
  settingsVersion: 1,
  updatedAt: "2026-07-21T06:00:00.000Z",
  version: 1,
} as const;

describe("HR Workforce Profile API contracts", () => {
  it("uses exact Plan request and response contract keys", () => {
    expect([
      hrWorkforceCreateProfileBodySchema.$id,
      hrWorkforceLinkPrincipalBodySchema.$id,
      hrWorkforceChangeStatusBodySchema.$id,
      hrWorkforceProfileSchema.$id,
      hrWorkforceServiceActivateBodySchema.$id,
      hrWorkforceServiceDeactivateBodySchema.$id,
      hrWorkforceServiceControlSchema.$id,
    ]).toEqual([
      "HrWorkforceCreateProfileRequestV1",
      "HrWorkforceLinkPrincipalRequestV1",
      "HrWorkforceChangeStatusRequestV1",
      "HrWorkforceProfileResponseV1",
      "HrServiceActivateRequestV1",
      "HrServiceDeactivateRequestV1",
      "HrServiceControlResponseV1",
    ]);
  });

  it("keeps mutation inputs bounded and server-derived identity out of create", () => {
    expect(hrWorkforceCreateProfileBodySchema).toMatchObject({
      additionalProperties: false,
      properties: { employeeNumber: { maxLength: 64, minLength: 1 } },
    });
    expect(hrWorkforceLinkPrincipalBodySchema.required).toEqual(["principalId", "expectedVersion"]);
    expect(hrWorkforceChangeStatusBodySchema.properties.targetStatus.enum).toEqual([
      "active",
      "suspended",
      "terminated",
    ]);
    expect(hrWorkforceProfilePathSchema.required).toEqual(["workerProfileId"]);
    expect(hrWorkforceServiceLifecycleBodySchema.properties.expectedVersion.anyOf).toEqual([
      { minimum: 1, type: "integer" },
      { type: "null" },
    ]);
  });

  it("strictly decodes only the privacy-minimized profile projection", () => {
    expect(parseHrWorkforceProfile(profile)).toBe(profile);
    expect(() => parseHrWorkforceProfile({ ...profile, tenantId: "private" })).toThrow(
      "unexpected or missing fields",
    );
    expect(() => parseHrWorkforceProfile({ ...profile, principalId: "private" })).toThrow(
      "unexpected or missing fields",
    );
    expect(() => parseHrWorkforceProfile({ ...profile, employeeNumber: "x".repeat(65) })).toThrow(
      "at most 64 characters",
    );
    expect(() =>
      parseHrWorkforceProfile({
        ...profile,
        principalLinked: false,
        workforceStatus: "active",
      }),
    ).toThrow("must have a principal link");
    expect(() => parseHrWorkforceProfile({ ...profile, updatedAt: "not-a-date" })).toThrow(
      "ISO date-time",
    );
  });

  it("strictly decodes bounded service control without tenant internals", () => {
    expect(parseHrWorkforceServiceControl(serviceControl)).toBe(serviceControl);
    expect(() =>
      parseHrWorkforceServiceControl({ ...serviceControl, tenantId: "private" }),
    ).toThrow("unexpected or missing fields");
    expect(() =>
      parseHrWorkforceServiceControl({ ...serviceControl, serviceKey: "hr.leave_request" }),
    ).toThrow("serviceKey is invalid");
    expect(() =>
      parseHrWorkforceServiceControl({ ...serviceControl, activationVersion: 0 }),
    ).toThrow("positive integer");
  });
});
