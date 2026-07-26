import type {
  HrExpenseClaimListResponse,
  HrExpenseClaimResponse,
} from "@esbla/contracts/hr-expense-claim-api";
import { describe, expect, it } from "vitest";
import {
  buildExpenseDetailPath,
  buildOwnExpensePath,
  decodeExpenseDetail,
  decodeExpenseList,
  decodeExpenseMutation,
  ExpenseUiError,
  parseExpenseActions,
  validateExpenseAction,
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
          history: { items: [], nextCursor: null },
        }),
      ),
    ).resolves.toMatchObject({ accessScope: "own", expenseClaimId });
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
      kind: "inactive",
      message: "Expense Claim request failed",
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

  it("builds strict paired own and history cursors", () => {
    expect(
      buildOwnExpensePath({
        cursorCreatedAt: "2029-03-01T09:00:00.000Z",
        cursorExpenseClaimId: expenseClaimId,
      }),
    ).toBe(
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
