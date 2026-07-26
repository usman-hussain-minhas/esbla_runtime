import "server-only";

import type {
  HrExpenseClaimListResponse,
  HrExpenseClaimResponse,
} from "@esbla/contracts/hr-expense-claim-api";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildExpenseDetailPath,
  buildOwnExpensePath,
  decodeExpenseDetail,
  decodeExpenseList,
  decodeExpenseMutation,
  type ExpenseAction,
  type ExpenseAuthorizedAction,
  type ExpenseFailureState,
  expenseStateForError,
  hasExpenseAction,
  parseExpenseActions,
} from "./hr-expense-claim-core";

type Search = Readonly<Record<string, string | readonly string[] | undefined>>;
type Authority = Readonly<{ authorizedActions: readonly ExpenseAuthorizedAction[] }>;
type OwnExpensePage = Extract<HrExpenseClaimListResponse, { readonly kind: "own" }>;
export type ExpenseOwnListState = Authority &
  ({ readonly page: OwnExpensePage; readonly status: "success" } | ExpenseFailureState);
export type ExpenseDetailState = Authority &
  ({ readonly detail: HrExpenseClaimResponse; readonly status: "success" } | ExpenseFailureState);

const NO_ACTIONS: readonly ExpenseAuthorizedAction[] = Object.freeze([]);

export async function loadOwnExpenseClaims(search: Search = {}): Promise<ExpenseOwnListState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: buildOwnExpensePath(search),
    });
    authorizedActions = parseExpenseActions(response);
    if (response.status === 200 && !hasExpenseAction(authorizedActions, "list_own")) {
      throw new Error("Missing Expense Claim list authority");
    }
    return {
      authorizedActions,
      page: (await decodeExpenseList(response, "own")) as OwnExpensePage,
      status: "success",
    };
  } catch (error) {
    return { ...expenseStateForError(error), authorizedActions };
  }
}

export async function loadExpenseClaimDetail(
  expenseClaimId: string,
  search: Search = {},
): Promise<ExpenseDetailState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: buildExpenseDetailPath(expenseClaimId, search),
    });
    authorizedActions = parseExpenseActions(response);
    if (response.status === 200 && !hasExpenseAction(authorizedActions, "view_detail")) {
      throw new Error("Missing Expense Claim detail authority");
    }
    return {
      authorizedActions,
      detail: await decodeExpenseDetail(response),
      status: "success",
    };
  } catch (error) {
    return { ...expenseStateForError(error), authorizedActions };
  }
}

export async function executeExpenseAction(action: ExpenseAction): Promise<HrExpenseClaimResponse> {
  const path =
    action.operation === "create"
      ? "/v1/hr/expense-claims"
      : `/v1/hr/expense-claims/${encodeURIComponent(action.expenseClaimId)}/${
          action.operation === "edit_draft" ? "draft" : action.operation
        }`;
  return await decodeExpenseMutation(
    await fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: action.operation === "edit_draft" ? "PATCH" : "POST",
      path,
    }),
    action.operation,
  );
}
