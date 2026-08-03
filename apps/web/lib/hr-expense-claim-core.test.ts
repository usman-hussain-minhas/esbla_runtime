import type {
  HrExpenseClaimListResponse,
  HrExpenseClaimResponse,
} from "@esbla/contracts/hr-expense-claim-api";
import { describe, expect, it } from "vitest";
import {
  buildAssignedExpensePath,
  buildExpenseDetailPath,
  buildOwnExpensePath,
  decodeExpenseDetail,
  decodeExpenseList,
  decodeExpenseMutation,
  decodeExpenseServiceControl,
  decodeExpenseServiceMutation,
  ExpenseUiError,
  parseExpenseActions,
  validateExpenseAction,
  validateExpenseServiceAction,
} from "./hr-expense-claim-core";

const expenseClaimId = "10000000-0000-4000-8000-000000000001";
const expenseClaimVersionId = "20000000-0000-4000-8000-000000000001";
const workerProfileId = "30000000-0000-4000-8000-000000000001";
const idempotencyKey = "40000000-0000-4000-8000-000000000001";
const root = {
  currentVersion: {
    assignedApproverWorkerProfileId: null,
    currencyCode: "USD",
    expenseClaimVersionId,
    lines: [],
    rowVersion: 1,
    status: "draft",
    submittedAt: null,
    supersedesVersionId: null,
    totalAmountMinor: 0,
    version: 1,
  },
  expenseClaimId,
  rootVersion: 1,
  workerProfileId,
} satisfies HrExpenseClaimResponse;
const own = {
  items: [
    {
      createdAt: "2029-03-01T09:00:00.000Z",
      currencyCode: "USD",
      expenseClaimId,
      expenseClaimVersionId,
      rootVersion: 1,
      status: "draft",
      submittedAt: null,
      totalAmountMinor: 0,
      version: 1,
      workerProfileId,
      workItemId: null,
    },
  ],
  kind: "own",
  nextCursor: null,
} satisfies HrExpenseClaimListResponse;

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("Expense Claim rendered employee boundary", () => {
  it("accepts only the canonical current-authority projection", () => {
    expect(
      parseExpenseActions(
        json({}, 200, {
          "x-esbla-expense-actions": '["create","edit_draft","list_own","submit","view_detail"]',
        }),
      ),
    ).toEqual(["create", "edit_draft", "list_own", "submit", "view_detail"]);
    expect(() =>
      parseExpenseActions(
        json({}, 200, {
          "x-esbla-expense-actions": '["view_detail","create"]',
        }),
      ),
    ).toThrowError(ExpenseUiError);
    expect(() => parseExpenseActions(json({}))).toThrowError(ExpenseUiError);
  });

  it("decodes exact read and mutation status while rejecting wrong success shapes", async () => {
    await expect(decodeExpenseList(json(own), "own")).resolves.toEqual(own);
    await expect(
      decodeExpenseList(json({ ...own, kind: "assigned" }), "own"),
    ).rejects.toBeInstanceOf(ExpenseUiError);
    await expect(
      decodeExpenseDetail(
        json({
          ...root,
          accessScope: "own",
          decisionEligible: false,
          history: { items: [], nextCursor: null },
        }),
      ),
    ).resolves.toMatchObject({ accessScope: "own", decisionEligible: false, expenseClaimId });
    await expect(
      decodeExpenseDetail(
        json({
          ...root,
          accessScope: "assigned",
          history: { items: [], nextCursor: null },
        }),
      ),
    ).rejects.toBeInstanceOf(ExpenseUiError);
    await expect(
      decodeExpenseDetail(
        json({
          ...root,
          accessScope: "assigned",
          decisionEligible: true,
          history: { items: [], nextCursor: null },
        }),
      ),
    ).resolves.toMatchObject({ accessScope: "assigned", decisionEligible: true, expenseClaimId });
    await expect(decodeExpenseDetail(json({ ...root, accessScope: "own" }))).rejects.toBeInstanceOf(
      ExpenseUiError,
    );
    await expect(
      decodeExpenseMutation(json(root, 201, { "idempotent-replayed": "false" }), "create"),
    ).resolves.toEqual(root);
    await expect(
      decodeExpenseMutation(json(root, 201, { "idempotent-replayed": "true" }), "create"),
    ).rejects.toBeInstanceOf(ExpenseUiError);
    await expect(
      decodeExpenseMutation(json({ ...root, accessScope: "own" }), "create"),
    ).rejects.toBeInstanceOf(ExpenseUiError);
  });

  it("maps only strict Problem Details into sanitized UI states", async () => {
    const problem = new Response(
      JSON.stringify({
        code: "EXPENSE_SERVICE_INACTIVE",
        detail: "internal text must not escape",
        instance: "/v1/problems/50000000-0000-4000-8000-000000000001",
        requestId: "50000000-0000-4000-8000-000000000001",
        status: 503,
        title: "Unavailable",
        type: "urn:esbla:problem:expense_service_inactive",
      }),
      { headers: { "content-type": "application/problem+json" }, status: 503 },
    );
    await expect(decodeExpenseList(problem, "own")).rejects.toMatchObject({
      assignedUnavailableReason: "inactive",
      kind: "inactive",
      message: "Expense Claim request failed",
    });
    const inactiveMember = new Response(
      JSON.stringify({
        code: "ACTOR_NOT_ACTIVE_MEMBER",
        detail: "internal text must not escape",
        instance: "/v1/problems/50000000-0000-4000-8000-000000000002",
        requestId: "50000000-0000-4000-8000-000000000002",
        status: 403,
        title: "Forbidden",
        type: "urn:esbla:problem:actor_not_active_member",
      }),
      { headers: { "content-type": "application/problem+json" }, status: 403 },
    );
    await expect(decodeExpenseList(inactiveMember, "assigned")).rejects.toMatchObject({
      assignedUnavailableReason: undefined,
      kind: "denied",
    });
    const policyDenied = new Response(
      JSON.stringify({
        code: "POLICY_DENIED",
        detail: "internal text must not escape",
        instance: "/v1/problems/50000000-0000-4000-8000-000000000003",
        requestId: "50000000-0000-4000-8000-000000000003",
        status: 403,
        title: "Forbidden",
        type: "urn:esbla:problem:policy_denied",
      }),
      { headers: { "content-type": "application/problem+json" }, status: 403 },
    );
    await expect(decodeExpenseList(policyDenied, "assigned")).rejects.toMatchObject({
      assignedUnavailableReason: "ineligible",
      kind: "denied",
    });
  });

  it("validates exact create, line-edit, and submit form semantics", () => {
    expect(
      validateExpenseAction({ currencyCode: "USD", idempotencyKey, operation: "create" }),
    ).toMatchObject({
      ok: true,
      value: { body: { currencyCode: "USD" }, operation: "create" },
    });
    expect(
      validateExpenseAction({
        amountMinor_0: "12345",
        categoryCode_0: "travel",
        description_0: "Ground transport",
        expenseClaimId,
        expenseDate_0: "2029-03-01",
        expectedExpenseClaimVersionId: expenseClaimVersionId,
        expectedRootVersion: "1",
        expectedVersion: "1",
        idempotencyKey,
        operation: "edit_draft",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        body: {
          lines: [
            {
              amountMinor: 12345,
              categoryCode: "travel",
              description: "Ground transport",
              expenseDate: "2029-03-01",
            },
          ],
        },
        operation: "edit_draft",
      },
    });
    expect(
      validateExpenseAction({
        expenseClaimId,
        expectedExpenseClaimVersionId: expenseClaimVersionId,
        expectedRootVersion: "1",
        expectedVersion: "1",
        idempotencyKey,
        operation: "submit",
      }),
    ).toMatchObject({ ok: true, value: { operation: "submit" } });
    expect(
      validateExpenseAction({
        amountMinor_0: "0",
        categoryCode_0: "travel",
        expenseClaimId,
        expenseDate_0: "2029-02-30",
        expectedExpenseClaimVersionId: expenseClaimVersionId,
        expectedRootVersion: "1",
        expectedVersion: "1",
        idempotencyKey,
        operation: "edit_draft",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
  });

  it("binds only exact manager decisions and employee correction requests", () => {
    const expected = {
      expenseClaimId,
      expectedExpenseClaimVersionId: expenseClaimVersionId,
      expectedRootVersion: "1",
      expectedVersion: "3",
      idempotencyKey,
    };
    expect(
      validateExpenseAction({
        ...expected,
        decisionNote: "Current assigned facts reviewed",
        operation: "approve",
        returnTo: "my-work",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        body: { decisionNote: "Current assigned facts reviewed" },
        operation: "approve",
        returnTo: "my-work",
      },
    });
    expect(
      validateExpenseAction({
        ...expected,
        decisionNote: "",
        operation: "reject",
        returnTo: "detail",
      }),
    ).toMatchObject({
      ok: true,
      value: { body: { decisionNote: null }, operation: "reject", returnTo: "detail" },
    });
    expect(
      validateExpenseAction({
        ...expected,
        operation: "create_correction",
        returnTo: "own",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: "create_correction", returnTo: "own" },
    });
    expect(
      validateExpenseAction({
        ...expected,
        decisionNote: "Unexpected",
        operation: "create_correction",
        returnTo: "own",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
  });

  it("binds exact Expense service-control settings and mutation continuity", async () => {
    const initialized = {
      activationState: "active",
      activationVersion: 1,
      serviceKey: "expense_claim_boundary",
      settings: { categoryCodes: "other", rejectionNoteRequired: true },
      settingsVersion: 1,
      updatedAt: "2029-03-01T09:00:00.000Z",
      version: 1,
    } as const;
    const activate = validateExpenseServiceAction({
      expectedVersion: "",
      idempotencyKey,
      operation: "activate_service",
    });
    expect(activate).toMatchObject({
      ok: true,
      value: { body: { expectedVersion: null }, operation: "activate_service" },
    });
    if (!activate.ok) throw new Error("Expected valid activation");
    await expect(
      decodeExpenseServiceMutation(
        json(initialized, 200, { "idempotent-replayed": "false" }),
        activate.value,
      ),
    ).resolves.toEqual(initialized);

    const configure = validateExpenseServiceAction({
      categoryCodes: "travel,other",
      expectedSettingsVersion: "1",
      idempotencyKey,
      operation: "configure_service",
      rejectionNoteRequired: "false",
    });
    expect(configure).toMatchObject({
      ok: true,
      value: {
        body: {
          expectedSettingsVersion: 1,
          settings: { categoryCodes: "travel,other", rejectionNoteRequired: false },
        },
        operation: "configure_service",
      },
    });
    if (!configure.ok || configure.value.operation !== "configure_service") {
      throw new Error("Expected valid settings");
    }
    await expect(
      decodeExpenseServiceMutation(
        json(
          {
            ...initialized,
            settings: configure.value.body.settings,
            settingsVersion: 2,
            version: 2,
          },
          200,
          { "idempotent-replayed": "false" },
        ),
        configure.value,
      ),
    ).resolves.toMatchObject({ settingsVersion: 2, version: 2 });
    expect(
      validateExpenseServiceAction({
        categoryCodes: "travel,travel",
        expectedSettingsVersion: "1",
        idempotencyKey,
        operation: "configure_service",
        rejectionNoteRequired: "true",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
    expect(
      validateExpenseServiceAction({
        categoryCodes: Array.from({ length: 51 }, (_, index) => `category-${index}`).join(","),
        expectedSettingsVersion: "1",
        idempotencyKey,
        operation: "configure_service",
        rejectionNoteRequired: "true",
      }),
    ).toMatchObject({ ok: false, state: { kind: "validation" } });
    await expect(
      decodeExpenseServiceControl(json({ ...initialized, serviceKey: "timesheet" })),
    ).rejects.toBeInstanceOf(ExpenseUiError);
  });

  it("builds strict paired own and history cursors", () => {
    expect(buildAssignedExpensePath()).toBe("/v1/hr/expense-claims/assigned?pageSize=50");
    expect(
      buildAssignedExpensePath({
        expenseClaimVersionId,
        submittedAt: "2029-03-01T09:00:00.000Z",
      }),
    ).toBe(
      `/v1/hr/expense-claims/assigned?pageSize=50&cursorExpenseClaimVersionId=${expenseClaimVersionId}&cursorSubmittedAt=2029-03-01T09%3A00%3A00.000Z`,
    );
    const ownCursor = {
      cursorCreatedAt: "2029-03-01T09:00:00.000Z",
      cursorExpenseClaimId: expenseClaimId,
    };
    expect(buildOwnExpensePath(ownCursor)).toBe(
      `/v1/hr/expense-claims/own?cursorCreatedAt=2029-03-01T09%3A00%3A00.000Z&cursorExpenseClaimId=${expenseClaimId}`,
    );
    expect(() => buildOwnExpensePath({ cursorCreatedAt: "2029-03-01T09:00:00.000Z" })).toThrowError(
      ExpenseUiError,
    );
    expect(
      buildExpenseDetailPath(expenseClaimId, {
        cursorExpenseClaimVersionId: expenseClaimVersionId,
        cursorVersion: "2",
      }),
    ).toBe(
      `/v1/hr/expense-claims/by-id/${expenseClaimId}?cursorExpenseClaimVersionId=${expenseClaimVersionId}&cursorVersion=2`,
    );
  });
});
