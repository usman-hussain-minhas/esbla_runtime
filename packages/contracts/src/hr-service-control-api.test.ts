import { describe, expect, it } from "vitest";
import {
  hrServiceActivateBodySchema,
  hrServiceConfigureBodySchema,
  hrServiceControlQuerySchema,
  hrServiceControlSchema,
  hrServiceDeactivateBodySchema,
  hrServiceKeys,
  parseHrServiceActivateBody,
  parseHrServiceConfigureBody,
  parseHrServiceControl,
  parseHrServiceControlQuery,
  parseHrServiceDeactivateBody,
} from "./hr-service-control-api.js";

const serviceControl = {
  activationState: "active",
  activationVersion: 3,
  serviceKey: "workforce_profile",
  settings: {
    employeeNumberRequired: false,
    managerVisibility: "minimized",
    unlinkedWorkerCreationAllowed: true,
  },
  settingsVersion: 2,
  updatedAt: "2026-07-21T08:30:00.000Z",
  version: 4,
} as const;

describe("shared HR service-control contracts", () => {
  it("publishes the exact schema identities and six included service keys", () => {
    expect([
      hrServiceControlQuerySchema.$id,
      hrServiceActivateBodySchema.$id,
      hrServiceConfigureBodySchema.$id,
      hrServiceDeactivateBodySchema.$id,
      hrServiceControlSchema.$id,
    ]).toEqual([
      "HrServiceControlQueryV1",
      "HrServiceActivateRequestV1",
      "HrServiceConfigureRequestV1",
      "HrServiceDeactivateRequestV1",
      "HrServiceControlResponseV1",
    ]);
    expect(hrServiceKeys).toEqual([
      "attendance",
      "employment_record",
      "expense_claim_boundary",
      "shift_assignment",
      "timesheet",
      "workforce_profile",
    ]);
  });

  it("accepts only an exact empty service-control query", () => {
    const query = {};
    expect(parseHrServiceControlQuery(query)).toBe(query);
    for (const invalid of [null, [], { serviceKey: "workforce_profile" }]) {
      expect(() => parseHrServiceControlQuery(invalid)).toThrow();
    }
  });

  it("accepts only null or a positive safe integer activation version", () => {
    for (const expectedVersion of [null, 1, Number.MAX_SAFE_INTEGER]) {
      const body = { expectedVersion };
      expect(parseHrServiceActivateBody(body)).toBe(body);
    }
    for (const invalid of [
      {},
      { expectedVersion: 1, extra: true },
      { expectedVersion: "1" },
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => parseHrServiceActivateBody(invalid)).toThrow();
    }
  });

  it("requires an exact positive safe integer deactivation version", () => {
    for (const expectedVersion of [1, Number.MAX_SAFE_INTEGER]) {
      const body = { expectedVersion };
      expect(parseHrServiceDeactivateBody(body)).toBe(body);
    }
    for (const invalid of [
      {},
      { expectedVersion: 1, extra: true },
      { expectedVersion: null },
      { expectedVersion: "1" },
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => parseHrServiceDeactivateBody(invalid)).toThrow();
    }
  });

  it("accepts only an exact full Workforce Profile settings replacement", () => {
    const body = { expectedSettingsVersion: 2, settings: serviceControl.settings };
    expect(parseHrServiceConfigureBody(body)).toBe(body);
    for (const invalid of [
      {},
      { ...body, extra: true },
      { ...body, expectedSettingsVersion: 0 },
      { ...body, expectedSettingsVersion: 2_147_483_648 },
      { ...body, settings: { ...body.settings, managerVisibility: "all" } },
      { ...body, settings: { ...body.settings, employeeNumberRequired: "true" } },
      {
        ...body,
        settings: { ...body.settings, unlinkedWorkerCreationAllowed: false, extra: true },
      },
    ]) {
      expect(() => parseHrServiceConfigureBody(invalid)).toThrow();
    }
  });

  it("strictly parses the exact six-field response for every included service", () => {
    for (const serviceKey of hrServiceKeys) {
      const response = {
        ...serviceControl,
        serviceKey,
        settings: serviceKey === "workforce_profile" ? serviceControl.settings : {},
      };
      expect(parseHrServiceControl(response)).toBe(response);
    }
  });

  it("rejects missing, extra, coerced, unsafe, or invalid response fields", () => {
    const { version: _version, ...missingVersion } = serviceControl;
    for (const invalid of [
      missingVersion,
      { ...serviceControl, privateDetail: "secret" },
      { ...serviceControl, serviceKey: "leave_request" },
      { ...serviceControl, serviceKey: "attendance" },
      { ...serviceControl, settings: {} },
      { ...serviceControl, settings: { ...serviceControl.settings, privateSetting: true } },
      { ...serviceControl, activationState: "enabled" },
      { ...serviceControl, activationVersion: "3" },
      { ...serviceControl, settingsVersion: 1.5 },
      { ...serviceControl, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...serviceControl, updatedAt: "not-a-timestamp" },
      { ...serviceControl, updatedAt: "2026-02-30T08:30:00.000Z" },
    ]) {
      expect(() => parseHrServiceControl(invalid)).toThrow();
    }
  });
});
