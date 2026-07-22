import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as submitEmploymentAction } from "../app/workspace/hr/employment/action/route";
import {
  EMPLOYMENT_MUTATION_RECEIPT_MAX_AGE_SECONDS,
  readEmploymentMutationReceipt,
  sealEmploymentMutationReceipt,
} from "./hr-employment-record";
import {
  decodeEmploymentList,
  decodeEmploymentMutation,
  EMPLOYMENT_AUTHORIZED_ACTIONS,
  EmploymentUiError,
  hasEmploymentAction,
  parseEmploymentAuthorizedActions,
  parseEmploymentWorkerSelection,
  validateEmploymentAction,
} from "./hr-employment-record-core";

vi.mock("server-only", () => ({}));

const ids = {
  idempotency: "70000000-0000-4000-8000-000000000001",
  record: "70000000-0000-4000-8000-000000000002",
  version: "70000000-0000-4000-8000-000000000003",
  worker: "70000000-0000-4000-8000-000000000004",
  otherPrincipal: "70000000-0000-4000-8000-000000000005",
  principal: "70000000-0000-4000-8000-000000000006",
  tenant: "70000000-0000-4000-8000-000000000007",
  otherTenant: "70000000-0000-4000-8000-000000000008",
} as const;

const secret = "employment-receipt-test-secret-with-at-least-32-bytes";

function stubSession(overrides: Readonly<Record<string, string>> = {}): void {
  for (const [name, value] of Object.entries({
    ESBLA_API_BASE_URL: "http://127.0.0.1:3001",
    ESBLA_DEV_AUTH_SECRET: secret,
    ESBLA_DEV_PRINCIPAL_ID: ids.principal,
    ESBLA_DEV_SESSION_LABEL: "Employment receipt test",
    ESBLA_DEV_TENANT_ID: ids.tenant,
    NODE_ENV: "development",
    ...overrides,
  })) {
    vi.stubEnv(name, value);
  }
}

beforeEach(() => stubSession());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const headers = { "content-type": "application/json", "idempotent-replayed": "false" };
const version = {
  effectiveFrom: "2027-01-01",
  effectiveTo: "2027-03-31",
  employmentRecordVersionId: ids.version,
  employmentTypeCode: "standard",
  kind: "effective",
  organizationReference: null,
  positionReference: null,
  rowVersion: 1,
  supersedesVersionId: null,
  terminal: false,
  version: 1,
} as const;
const record = {
  accessScope: "tenant",
  createdAt: "2027-01-01T00:00:00.000Z",
  currentVersion: version,
  employmentRecordId: ids.record,
  history: { items: [version], nextCursor: null },
  status: "active",
  version: 2,
  workerProfileId: ids.worker,
} as const;
const summary = {
  createdAt: record.createdAt,
  currentVersion: record.currentVersion,
  employmentRecordId: record.employmentRecordId,
  status: record.status,
  version: record.version,
  workerProfileId: record.workerProfileId,
};
const createdMutation = {
  currentVersion: null,
  employmentRecordId: ids.record,
  operation: "create_record",
  rootVersion: 1,
  status: "draft",
} as const;
const versionedMutation = {
  currentVersion: 1,
  employmentRecordId: ids.record,
  operation: "create_version",
  rootVersion: 2,
  status: "active",
} as const;
const endedMutation = {
  currentVersion: 2,
  employmentRecordId: ids.record,
  operation: "end_record",
  rootVersion: 3,
  status: "ended",
} as const;
const activatedMutation = {
  activationState: "active",
  activationVersion: 1,
  controlVersion: 1,
  operation: "activate_service",
  serviceKey: "employment_record",
  settingsVersion: 1,
} as const;

const createAction = {
  body: { workerProfileId: ids.worker },
  idempotencyKey: ids.idempotency,
  operation: "create_record",
} as const;

describe("Employment Record rendered boundary", () => {
  it("accepts only the canonical bounded current-action response header", () => {
    const response = (value?: string) =>
      new Response(null, {
        headers: value === undefined ? {} : { "x-esbla-employment-actions": value },
      });
    const all = parseEmploymentAuthorizedActions(
      response(JSON.stringify(EMPLOYMENT_AUTHORIZED_ACTIONS)),
    );
    expect(all).toEqual(EMPLOYMENT_AUTHORIZED_ACTIONS);
    expect(hasEmploymentAction(all, "view_detail")).toBe(true);
    expect(parseEmploymentAuthorizedActions(response("[]"))).toEqual([]);

    for (const invalid of [
      undefined,
      "not-json",
      "{}",
      '["unknown"]',
      '["view_detail","view_detail"]',
      '["view_detail","list_authorized"]',
      '[ "view_detail" ]',
      JSON.stringify(["view_detail".repeat(257)]),
    ]) {
      expect(() => parseEmploymentAuthorizedActions(response(invalid))).toThrow(EmploymentUiError);
    }
  });

  it("accepts only an exact optional Workforce-to-Employment handoff", () => {
    expect(parseEmploymentWorkerSelection(undefined)).toBeUndefined();
    expect(parseEmploymentWorkerSelection(ids.worker.toUpperCase())).toBe(ids.worker);
    expect(() => parseEmploymentWorkerSelection([ids.worker])).toThrow(EmploymentUiError);
    expect(() => parseEmploymentWorkerSelection("not-a-worker-id")).toThrow(EmploymentUiError);
  });

  it("accepts every exact form operation and normalizes optional facts", () => {
    expect(
      validateEmploymentAction({
        idempotencyKey: ids.idempotency,
        operation: "create_record",
        workerProfileId: ids.worker,
      }),
    ).toMatchObject({ ok: true, value: { body: { workerProfileId: ids.worker } } });

    expect(
      validateEmploymentAction({
        effectiveFrom: "2027-04-01",
        effectiveTo: "",
        employmentRecordId: ids.record,
        employmentTypeCode: "standard",
        expectedCurrentVersion: "1",
        expectedVersion: "2",
        idempotencyKey: ids.idempotency,
        operation: "create_version",
        organizationReference: "",
        positionReference: "position-a",
      }),
    ).toEqual({
      ok: true,
      value: {
        body: {
          effectiveFrom: "2027-04-01",
          effectiveTo: null,
          employmentTypeCode: "standard",
          expectedCurrentVersion: 1,
          expectedVersion: 2,
          organizationReference: null,
          positionReference: "position-a",
        },
        employmentRecordId: ids.record,
        idempotencyKey: ids.idempotency,
        operation: "create_version",
      },
    });

    expect(
      validateEmploymentAction({
        effectiveTo: "2027-06-30",
        employmentRecordId: ids.record,
        expectedCurrentVersion: "2",
        expectedVersion: "3",
        idempotencyKey: ids.idempotency,
        operation: "end_record",
      }),
    ).toMatchObject({ ok: true, value: { body: { expectedVersion: 3 } } });

    expect(
      validateEmploymentAction({
        effectiveRangeOverlapAllowed: "false",
        employmentTypeCodes: "standard,temporary",
        expectedSettingsVersion: "1",
        idempotencyKey: ids.idempotency,
        operation: "configure_service",
      }),
    ).toMatchObject({ ok: true, value: { body: { expectedSettingsVersion: 1 } } });

    for (const [operation, expectedVersion] of [
      ["activate_service", ""],
      ["deactivate_service", "2"],
    ] as const) {
      expect(
        validateEmploymentAction({
          expectedVersion,
          idempotencyKey: ids.idempotency,
          operation,
        }).ok,
      ).toBe(true);
    }
  });

  it("rejects extra fields, invalid dates, broken policy floors, and unsafe versions", () => {
    for (const value of [
      {
        extra: "actor",
        idempotencyKey: ids.idempotency,
        operation: "create_record",
        workerProfileId: ids.worker,
      },
      {
        effectiveTo: "2027-02-30",
        employmentRecordId: ids.record,
        expectedCurrentVersion: "1",
        expectedVersion: "2",
        idempotencyKey: ids.idempotency,
        operation: "end_record",
      },
      {
        effectiveRangeOverlapAllowed: "true",
        employmentTypeCodes: "standard",
        expectedSettingsVersion: "1",
        idempotencyKey: ids.idempotency,
        operation: "configure_service",
      },
      {
        expectedVersion: "2147483648",
        idempotencyKey: ids.idempotency,
        operation: "deactivate_service",
      },
    ]) {
      expect(validateEmploymentAction(value)).toMatchObject({
        ok: false,
        state: { kind: "validation" },
      });
    }
  });

  it("decodes strict minimized list and mutation responses", async () => {
    await expect(
      decodeEmploymentList(
        Promise.resolve(
          Response.json(
            { accessScope: "tenant", items: [summary], nextCursor: null },
            { status: 200 },
          ),
        ),
      ),
    ).resolves.toMatchObject({ accessScope: "tenant", items: [{ status: "active" }] });

    await expect(
      decodeEmploymentMutation(
        Promise.resolve(Response.json(createdMutation, { headers, status: 201 })),
        "create_record",
      ),
    ).resolves.toEqual(createdMutation);

    await expect(
      decodeEmploymentMutation(
        Promise.resolve(
          Response.json(versionedMutation, {
            headers: { ...headers, "idempotent-replayed": "true" },
            status: 200,
          }),
        ),
        "create_version",
      ),
    ).resolves.toEqual(versionedMutation);

    for (const [expected, status, replay] of [
      ["create_record", 200, "false"],
      ["create_version", 201, "true"],
      ["end_record", 201, "false"],
      ["activate_service", 201, "false"],
    ] as const) {
      await expect(
        decodeEmploymentMutation(
          Promise.resolve(
            Response.json(createdMutation, {
              headers: { ...headers, "idempotent-replayed": replay },
              status,
            }),
          ),
          expected,
        ),
      ).rejects.toBeInstanceOf(EmploymentUiError);
    }
  });

  it("maps bounded Problem Details and treats malformed success as operational failure", async () => {
    const problem = {
      code: "EMPLOYMENT_VERSION_CONFLICT",
      detail: "Employment record version changed",
      instance: "/v1/hr/employment-records/:employmentRecordId/versions",
      requestId: ids.idempotency,
      status: 409,
      title: "Conflict",
      type: "urn:esbla:problem:employment_version_conflict",
    };
    await expect(
      decodeEmploymentMutation(
        Promise.resolve(
          Response.json(problem, {
            headers: { "content-type": "application/problem+json" },
            status: 409,
          }),
        ),
        "create_version",
      ),
    ).rejects.toMatchObject({ kind: "conflict" });

    await expect(
      decodeEmploymentMutation(
        Promise.resolve(
          Response.json({ ...createdMutation, tenantId: ids.worker }, { headers, status: 201 }),
        ),
        "create_record",
      ),
    ).rejects.toBeInstanceOf(EmploymentUiError);
    await expect(
      decodeEmploymentMutation(
        Promise.resolve(Response.json(record, { headers, status: 201 })),
        "create_version",
      ),
    ).rejects.toBeInstanceOf(EmploymentUiError);
    await expect(
      decodeEmploymentMutation(
        Promise.resolve(
          Response.json(
            {
              activationState: "active",
              activationVersion: 1,
              serviceKey: "employment_record",
              settings: {
                effectiveRangeOverlapAllowed: false,
                employmentTypeCodes: "standard",
              },
              settingsVersion: 2,
              updatedAt: "2027-01-01T00:00:00.000Z",
              version: 2,
            },
            { headers, status: 200 },
          ),
        ),
        "configure_service",
      ),
    ).rejects.toBeInstanceOf(EmploymentUiError);
  });

  it("seals only short-lived actor-bound audience-specific continuity fields", () => {
    const now = 10_000;
    const sealed = sealEmploymentMutationReceipt(createAction, createdMutation, now);
    expect(readEmploymentMutationReceipt(sealed, "admin", now)).toEqual({
      audience: "admin",
      currentVersion: null,
      employmentRecordId: ids.record,
      kind: "record",
      operation: "create_record",
      rootVersion: 1,
      status: "draft",
    });
    expect(readEmploymentMutationReceipt(sealed, "settings", now)).toBeNull();
    expect(EMPLOYMENT_MUTATION_RECEIPT_MAX_AGE_SECONDS).toBe(300);

    const body = Buffer.from(sealed.split(".")[0] ?? "", "base64url").toString("utf8");
    expect(body).not.toContain(ids.tenant);
    expect(body).not.toContain(ids.principal);
    expect(body).not.toContain(ids.worker);

    const [payload, signature] = sealed.split(".");
    if (!payload || !signature) throw new Error("Expected a sealed receipt");
    const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(readEmploymentMutationReceipt(tampered, "admin", now)).toBeNull();
    expect(readEmploymentMutationReceipt(sealed, "admin", now - 5_001)).toBeNull();
    expect(readEmploymentMutationReceipt(sealed, "admin", now + 300_000)).toBeNull();

    for (const override of [
      { ESBLA_DEV_PRINCIPAL_ID: ids.otherPrincipal },
      { ESBLA_DEV_TENANT_ID: ids.otherTenant },
      { ESBLA_DEV_AUTH_SECRET: `${secret}-other` },
    ]) {
      stubSession();
      stubSession(override);
      expect(readEmploymentMutationReceipt(sealed, "admin", now)).toBeNull();
    }
  });

  it("rejects mutation responses that do not match the submitted record or service action", () => {
    expect(() =>
      sealEmploymentMutationReceipt(createAction, {
        ...createdMutation,
        rootVersion: 2,
      } as never),
    ).toThrow(EmploymentUiError);

    const versionAction = {
      body: {
        effectiveFrom: version.effectiveFrom,
        effectiveTo: version.effectiveTo,
        employmentTypeCode: version.employmentTypeCode,
        expectedCurrentVersion: null,
        expectedVersion: 1,
        organizationReference: version.organizationReference,
        positionReference: version.positionReference,
      },
      employmentRecordId: ids.record,
      idempotencyKey: ids.idempotency,
      operation: "create_version",
    } as const;
    expect(
      readEmploymentMutationReceipt(
        sealEmploymentMutationReceipt(versionAction, versionedMutation),
        "admin",
      ),
    ).toMatchObject({ operation: "create_version", rootVersion: 2 });
    expect(() =>
      sealEmploymentMutationReceipt(versionAction, {
        ...versionedMutation,
        rootVersion: 3,
      } as never),
    ).toThrow(EmploymentUiError);

    const endAction = {
      body: { effectiveTo: "2027-03-31", expectedCurrentVersion: 1, expectedVersion: 2 },
      employmentRecordId: ids.record,
      idempotencyKey: ids.idempotency,
      operation: "end_record",
    } as const;
    expect(
      readEmploymentMutationReceipt(
        sealEmploymentMutationReceipt(endAction, endedMutation),
        "admin",
      ),
    ).toMatchObject({ currentVersion: 2, operation: "end_record", status: "ended" });

    const configureAction = {
      body: {
        expectedSettingsVersion: 1,
        settings: {
          effectiveRangeOverlapAllowed: false,
          employmentTypeCodes: "standard,temporary",
        },
      },
      idempotencyKey: ids.idempotency,
      operation: "configure_service",
    } as const;
    const configuredMutation = {
      ...activatedMutation,
      operation: "configure_service",
      settingsVersion: 2,
      controlVersion: 2,
    } as const;
    expect(
      readEmploymentMutationReceipt(
        sealEmploymentMutationReceipt(configureAction, configuredMutation),
        "settings",
      ),
    ).toMatchObject({ controlVersion: 2, operation: "configure_service", settingsVersion: 2 });
    expect(() =>
      sealEmploymentMutationReceipt(configureAction, {
        ...configuredMutation,
        settingsVersion: 3,
        controlVersion: 3,
      } as never),
    ).toThrow(EmploymentUiError);
    expect(() =>
      sealEmploymentMutationReceipt(configureAction, {
        ...configuredMutation,
        controlVersion: 3,
      } as never),
    ).toThrow(EmploymentUiError);

    const activateAction = {
      body: { expectedVersion: null },
      idempotencyKey: ids.idempotency,
      operation: "activate_service",
    } as const;
    expect(
      readEmploymentMutationReceipt(
        sealEmploymentMutationReceipt(activateAction, activatedMutation),
        "settings",
      ),
    ).toMatchObject({ activationState: "active", operation: "activate_service" });

    const deactivateAction = {
      body: { expectedVersion: 1 },
      idempotencyKey: ids.idempotency,
      operation: "deactivate_service",
    } as const;
    expect(
      readEmploymentMutationReceipt(
        sealEmploymentMutationReceipt(deactivateAction, {
          ...activatedMutation,
          activationState: "inactive",
          activationVersion: 2,
          controlVersion: 2,
          operation: "deactivate_service",
        }),
        "settings",
      ),
    ).toMatchObject({ activationState: "inactive", operation: "deactivate_service" });
  });

  it("uses receipt-only redirects and clears stale continuity on failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(createdMutation, {
        headers: { "idempotent-replayed": "false" },
        status: 201,
      }),
    );
    const form = new URLSearchParams({
      idempotencyKey: ids.idempotency,
      operation: "create_record",
      workerProfileId: ids.worker,
    });
    const request = () =>
      new Request("http://localhost:3000/workspace/hr/employment/action", {
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      });
    const success = await submitEmploymentAction(request());
    expect(success.status).toBe(303);
    expect(success.headers.get("location")).toBe(
      "/workspace/hr/employment/admin?result=success#employment-result",
    );
    expect(success.headers.get("location")).not.toContain(ids.record);
    expect(success.headers.get("set-cookie")).toMatch(
      /Path=\/workspace\/hr\/employment; HttpOnly; SameSite=Strict; Max-Age=300$/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        {
          code: "EMPLOYMENT_VERSION_CONFLICT",
          detail: "Employment record changed",
          instance: "/v1/hr/employment-records",
          requestId: ids.idempotency,
          status: 409,
          title: "Conflict",
          type: "urn:esbla:problem:employment_version_conflict",
        },
        { headers: { "content-type": "application/problem+json" }, status: 409 },
      ),
    );
    const failed = await submitEmploymentAction(request());
    expect(failed.status).toBe(303);
    expect(failed.headers.get("location")).toContain("result=conflict");
    expect(failed.headers.get("set-cookie")).toMatch(
      /^esbla_employment_mutation_receipt=; .*Max-Age=0$/,
    );
  });
});
