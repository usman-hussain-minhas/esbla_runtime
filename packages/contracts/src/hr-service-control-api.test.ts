import { describe, expect, it } from "vitest";
import {
  hrEmploymentRecordSettingsDefaults,
  hrServiceActivateBodySchema,
  hrServiceConfigureBodySchema,
  hrServiceControlQuerySchema,
  hrServiceControlSchema,
  hrServiceDeactivateBodySchema,
  hrServiceKeys,
  hrServiceMutationResponseSchema,
  parseHrServiceActivateBody,
  parseHrServiceConfigureBody,
  parseHrServiceControl,
  parseHrServiceControlQuery,
  parseHrServiceDeactivateBody,
  parseHrServiceMutationResponse,
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

const employmentRecordSettings = {
  effectiveRangeOverlapAllowed: false,
  employmentTypeCodes: "unspecified,Fixed Term",
} as const;

describe("shared HR service-control contracts", () => {
  it("publishes the exact schema identities and six included service keys", () => {
    expect([
      hrServiceControlQuerySchema.$id,
      hrServiceActivateBodySchema.$id,
      hrServiceConfigureBodySchema.$id,
      hrServiceDeactivateBodySchema.$id,
      hrServiceControlSchema.$id,
      hrServiceMutationResponseSchema.$id,
    ]).toEqual([
      "HrServiceControlQueryV1",
      "HrServiceActivateRequestV1",
      "HrServiceConfigureRequestV1",
      "HrServiceDeactivateRequestV1",
      "HrServiceControlResponseV1",
      "HrServiceMutationResponseV1",
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

  it("accepts the exact locked Employment Record settings replacement", () => {
    const body = { expectedSettingsVersion: 3, settings: employmentRecordSettings };
    expect(parseHrServiceConfigureBody(body)).toBe(body);
    for (const invalid of [
      { ...body, settings: { ...body.settings, effectiveRangeOverlapAllowed: true } },
      { ...body, settings: { ...body.settings, employmentTypeCodes: "" } },
      { ...body, settings: { ...body.settings, employmentTypeCodes: " unspecified" } },
      { ...body, settings: { ...body.settings, employmentTypeCodes: "unspecified, fixed" } },
      { ...body, settings: { ...body.settings, employmentTypeCodes: "unspecified," } },
      { ...body, settings: { ...body.settings, extra: true } },
      { ...body, settings: {} },
    ]) {
      expect(() => parseHrServiceConfigureBody(invalid)).toThrow();
    }
  });

  it("strictly parses the exact six-field response for every included service", () => {
    for (const serviceKey of hrServiceKeys) {
      const response = {
        ...serviceControl,
        serviceKey,
        settings:
          serviceKey === "workforce_profile"
            ? serviceControl.settings
            : serviceKey === "employment_record"
              ? employmentRecordSettings
              : {},
      };
      expect(parseHrServiceControl(response)).toBe(response);
    }
  });

  it("accepts only exact capability-minimal service mutation outcomes", () => {
    const activated = {
      activationState: "active",
      activationVersion: 3,
      controlVersion: 4,
      operation: "activate_service",
      serviceKey: "employment_record",
      settingsVersion: 2,
    } as const;
    const configured = { ...activated, operation: "configure_service" } as const;
    const deactivated = {
      ...activated,
      activationState: "inactive",
      operation: "deactivate_service",
    } as const;
    expect(parseHrServiceMutationResponse(activated)).toBe(activated);
    expect(parseHrServiceMutationResponse(configured)).toBe(configured);
    expect(parseHrServiceMutationResponse(deactivated)).toBe(deactivated);
    for (const invalid of [
      { ...activated, settings: employmentRecordSettings },
      { ...activated, updatedAt: serviceControl.updatedAt },
      { ...activated, activationState: "inactive" },
      { ...deactivated, activationState: "active" },
      { ...configured, controlVersion: 5 },
      { ...configured, operation: "view_service_control" },
      { ...configured, serviceKey: "leave_request" },
      { ...configured, settingsVersion: 0 },
    ]) {
      expect(() => parseHrServiceMutationResponse(invalid)).toThrow();
    }
  });

  it("registers and strictly preserves opaque Employment Record settings", () => {
    expect(hrEmploymentRecordSettingsDefaults).toEqual({
      effectiveRangeOverlapAllowed: false,
      employmentTypeCodes: "unspecified",
    });
    const response = {
      ...serviceControl,
      serviceKey: "employment_record",
      settings: employmentRecordSettings,
    } as const;
    expect(parseHrServiceControl(response)).toBe(response);

    for (const settings of [
      { ...employmentRecordSettings, employmentTypeCodes: "" },
      { ...employmentRecordSettings, employmentTypeCodes: "unspecified,,fixed" },
      { ...employmentRecordSettings, employmentTypeCodes: " unspecified" },
      { ...employmentRecordSettings, employmentTypeCodes: "unspecified, fixed" },
      { ...employmentRecordSettings, effectiveRangeOverlapAllowed: true },
      { ...employmentRecordSettings, privateSetting: true },
    ]) {
      expect(() => parseHrServiceControl({ ...response, settings })).toThrow();
    }
  });

  it("rejects missing, extra, coerced, unsafe, or invalid response fields", () => {
    const { version: _version, ...missingVersion } = serviceControl;
    for (const invalid of [
      missingVersion,
      { ...serviceControl, privateDetail: "secret" },
      { ...serviceControl, serviceKey: "leave_request" },
      { ...serviceControl, serviceKey: "attendance" },
      { ...serviceControl, serviceKey: "employment_record" },
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
