import { describe, expect, it } from "vitest";
import {
  hrExpenseClaimApproveBodySchema,
  hrExpenseClaimAssignedListQuerySchema,
  hrExpenseClaimCreateBodySchema,
  hrExpenseClaimCreateCorrectionBodySchema,
  hrExpenseClaimDetailQuerySchema,
  hrExpenseClaimEditDraftBodySchema,
  hrExpenseClaimListResponseSchema,
  hrExpenseClaimOwnListQuerySchema,
  hrExpenseClaimPathSchema,
  hrExpenseClaimRejectBodySchema,
  hrExpenseClaimResponseSchema,
  hrExpenseClaimSubmitBodySchema,
  parseHrExpenseClaimApproveBody,
  parseHrExpenseClaimAssignedListQuery,
  parseHrExpenseClaimCreateBody,
  parseHrExpenseClaimCreateCorrectionBody,
  parseHrExpenseClaimDetailQuery,
  parseHrExpenseClaimEditDraftBody,
  parseHrExpenseClaimListResponse,
  parseHrExpenseClaimOwnListQuery,
  parseHrExpenseClaimPath,
  parseHrExpenseClaimRejectBody,
  parseHrExpenseClaimResponse,
  parseHrExpenseClaimSubmitBody,
} from "./hr-expense-claim-api.js";

const ids = {
  claim: "10000000-0000-4000-8000-000000000001",
  line: "20000000-0000-4000-8000-000000000001",
  manager: "30000000-0000-4000-8000-000000000001",
  version: "40000000-0000-4000-8000-000000000001",
  worker: "50000000-0000-4000-8000-000000000001",
  workItem: "60000000-0000-4000-8000-000000000001",
} as const;
const expected = {
  expectedExpenseClaimVersionId: ids.version,
  expectedRootVersion: 1,
  expectedVersion: 1,
} as const;
const line = {
  amountMinor: 12_500,
  categoryCode: "travel",
  description: "Train fare",
  expenseDate: "2027-01-05",
} as const;

describe("Expense Claim Boundary API contract", () => {
  it("publishes the exact Plan API schema identities", () => {
    expect([
      hrExpenseClaimCreateBodySchema.$id,
      hrExpenseClaimEditDraftBodySchema.$id,
      hrExpenseClaimSubmitBodySchema.$id,
      hrExpenseClaimApproveBodySchema.$id,
      hrExpenseClaimRejectBodySchema.$id,
      hrExpenseClaimCreateCorrectionBodySchema.$id,
      hrExpenseClaimPathSchema.$id,
      hrExpenseClaimOwnListQuerySchema.$id,
      hrExpenseClaimAssignedListQuerySchema.$id,
      hrExpenseClaimDetailQuerySchema.$id,
      hrExpenseClaimResponseSchema.$id,
      hrExpenseClaimListResponseSchema.$id,
    ]).toEqual([
      "HrExpenseCreateRequestV1",
      "HrExpenseEditDraftRequestV1",
      "HrExpenseSubmitRequestV1",
      "HrExpenseApproveRequestV1",
      "HrExpenseRejectRequestV1",
      "HrExpenseCreateCorrectionRequestV1",
      "HrExpenseClaimPathV1",
      "HrExpenseOwnListQueryV1",
      "HrExpenseAssignedListQueryV1",
      "HrExpenseDetailQueryV1",
      "HrExpenseClaimResponseV1",
      "HrExpenseListResponseV1",
    ]);
    expect(hrExpenseClaimEditDraftBodySchema.properties.lines.items.dependencies).toEqual({
      expenseLineId: ["expectedVersion"],
      expectedVersion: ["expenseLineId"],
    });
    expect(hrExpenseClaimResponseSchema.dependencies).toEqual({
      accessScope: ["history"],
      history: ["accessScope"],
    });
    expect(hrExpenseClaimPathSchema.properties.expenseClaimId).toMatchObject({
      maxLength: 36,
      minLength: 36,
    });
    expect(hrExpenseClaimEditDraftBodySchema.properties.lines.items.properties.expenseDate).toEqual(
      {
        format: "date",
        maxLength: 10,
        minLength: 10,
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        type: "string",
      },
    );
    expect(
      hrExpenseClaimListResponseSchema.oneOf[0].properties.items.items.properties.workItemId,
    ).toEqual({ type: "null" });
    expect(
      hrExpenseClaimListResponseSchema.oneOf[1].properties.items.items.properties,
    ).toMatchObject({
      status: { const: "submitted" },
      submittedAt: { format: "date-time", type: "string" },
      workItemId: {
        pattern:
          "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
        type: "string",
      },
    });
  });

  it("accepts an ISO currency and strict bounded line replacement", () => {
    expect(parseHrExpenseClaimCreateBody({ currencyCode: "USD" })).toEqual({
      currencyCode: "USD",
    });
    const body = { ...expected, lines: [line] };
    expect(parseHrExpenseClaimEditDraftBody(body)).toEqual(body);
    const existing = {
      ...body,
      lines: [{ ...line, expenseLineId: ids.line, expectedVersion: 2 }],
    };
    expect(parseHrExpenseClaimEditDraftBody(existing)).toEqual(existing);
    for (const invalid of [
      {},
      { currencyCode: "usd" },
      { currencyCode: "ZZZ" },
      { currencyCode: "USD", receiptId: ids.line },
      { ...body, lines: [{ ...line, amountMinor: 0 }] },
      { ...body, lines: [{ ...line, categoryCode: "travel,air" }] },
      { ...body, lines: [{ ...line, expenseDate: "2027-02-29" }] },
      { ...body, lines: [{ ...line, expenseDate: "2027-01-05\n" }] },
      { ...body, lines: [{ ...line, expenseLineId: ids.line }] },
      { ...body, lines: [{ ...line, expectedVersion: 1 }] },
      { ...body, financeHandoff: true },
    ]) {
      expect(() =>
        "currencyCode" in invalid
          ? parseHrExpenseClaimCreateBody(invalid)
          : parseHrExpenseClaimEditDraftBody(invalid),
      ).toThrow();
    }
  });

  it("strictly parses lifecycle, decision, path, and paired cursor inputs", () => {
    expect(parseHrExpenseClaimSubmitBody(expected)).toEqual(expected);
    expect(parseHrExpenseClaimCreateCorrectionBody(expected)).toEqual(expected);
    expect(parseHrExpenseClaimApproveBody(expected)).toEqual(expected);
    expect(parseHrExpenseClaimRejectBody({ ...expected, decisionNote: "Outside policy" })).toEqual({
      ...expected,
      decisionNote: "Outside policy",
    });
    expect(parseHrExpenseClaimPath({ expenseClaimId: ids.claim })).toEqual({
      expenseClaimId: ids.claim,
    });
    expect(() => parseHrExpenseClaimPath({ expenseClaimId: `${ids.claim}\n` })).toThrow();
    expect(
      parseHrExpenseClaimOwnListQuery({
        cursorCreatedAt: "2027-01-05T10:00:00.000Z",
        cursorExpenseClaimId: ids.claim,
        pageSize: 25,
      }),
    ).toBeTruthy();
    expect(
      parseHrExpenseClaimAssignedListQuery({
        cursorExpenseClaimVersionId: ids.version,
        cursorSubmittedAt: "2027-01-05T10:00:00.000Z",
      }),
    ).toBeTruthy();
    expect(
      parseHrExpenseClaimDetailQuery({
        cursorExpenseClaimVersionId: ids.version,
        cursorVersion: 1,
      }),
    ).toBeTruthy();
    for (const invalid of [
      { cursorCreatedAt: "2027-01-05T10:00:00.000Z" },
      { cursorExpenseClaimVersionId: ids.version },
      { cursorVersion: 1 },
      { ...expected, expectedVersion: 0 },
      { ...expected, settlement: true },
    ]) {
      expect(
        [
          () => parseHrExpenseClaimOwnListQuery(invalid),
          () => parseHrExpenseClaimAssignedListQuery(invalid),
          () => parseHrExpenseClaimDetailQuery(invalid),
          () => parseHrExpenseClaimSubmitBody(invalid),
        ].some((operation) => {
          try {
            operation();
            return true;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    }
  });

  it("parses exact mutation/detail and own/assigned projections without money effects", () => {
    const currentVersion = {
      assignedApproverWorkerProfileId: ids.manager,
      currencyCode: "USD",
      expenseClaimVersionId: ids.version,
      lines: [{ ...line, expenseLineId: ids.line, version: 1 }],
      rowVersion: 2,
      status: "submitted",
      submittedAt: "2027-01-05T10:00:00.000Z",
      supersedesVersionId: null,
      totalAmountMinor: line.amountMinor,
      version: 1,
    } as const;
    const mutation = {
      currentVersion,
      expenseClaimId: ids.claim,
      rootVersion: 1,
      workerProfileId: ids.worker,
    } as const;
    expect(parseHrExpenseClaimResponse(mutation)).toEqual(mutation);
    const detail = {
      ...mutation,
      accessScope: "own",
      history: {
        items: [
          {
            assignedApproverWorkerProfileId: ids.manager,
            currencyCode: "USD",
            decidedAt: null,
            decisionNote: null,
            expenseClaimVersionId: ids.version,
            rowVersion: 2,
            status: "submitted",
            submittedAt: "2027-01-05T10:00:00.000Z",
            supersedesVersionId: null,
            totalAmountMinor: line.amountMinor,
            version: 1,
          },
        ],
        nextCursor: null,
      },
    } as const;
    expect(parseHrExpenseClaimResponse(detail)).toEqual(detail);

    const baseItem = {
      createdAt: "2027-01-05T09:00:00.000Z",
      currencyCode: "USD",
      expenseClaimId: ids.claim,
      expenseClaimVersionId: ids.version,
      rootVersion: 1,
      status: "submitted",
      submittedAt: "2027-01-05T10:00:00.000Z",
      totalAmountMinor: line.amountMinor,
      version: 1,
      workerProfileId: ids.worker,
    } as const;
    expect(
      parseHrExpenseClaimListResponse({
        items: [{ ...baseItem, workItemId: null }],
        kind: "own",
        nextCursor: null,
      }),
    ).toBeTruthy();
    expect(
      parseHrExpenseClaimListResponse({
        items: [{ ...baseItem, workItemId: ids.workItem }],
        kind: "assigned",
        nextCursor: null,
      }),
    ).toBeTruthy();
    for (const invalid of [
      { ...mutation, receiptUrl: "https://example.invalid" },
      { ...mutation, paymentStatus: "pending" },
      { ...detail, accessScope: "tenant" },
      { ...detail, accessScope: new String("own") },
      {
        ...mutation,
        currentVersion: { ...currentVersion, status: new String("submitted") },
      },
      Object.fromEntries(Object.entries(detail).filter(([key]) => key !== "history")),
      Object.fromEntries(Object.entries(detail).filter(([key]) => key !== "accessScope")),
    ]) {
      expect(() => parseHrExpenseClaimResponse(invalid)).toThrow();
    }
    for (const invalid of [
      {
        items: [{ ...baseItem, workItemId: ids.workItem }],
        kind: "own",
        nextCursor: null,
      },
      {
        items: [{ ...baseItem, workItemId: null }],
        kind: "assigned",
        nextCursor: null,
      },
      {
        items: [{ ...baseItem, status: "approved", workItemId: ids.workItem }],
        kind: "assigned",
        nextCursor: null,
      },
    ]) {
      expect(() => parseHrExpenseClaimListResponse(invalid)).toThrow();
    }
  });
});
