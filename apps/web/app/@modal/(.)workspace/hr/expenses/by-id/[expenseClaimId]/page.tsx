import { ArrowLeft } from "lucide-react";
import { fromAssignedProviderMasterCursorParameters } from "../../../../../../../lib/assigned-provider-core";
import { parseOwnExpenseCursor } from "../../../../../../../lib/hr-expense-claim-core";
import {
  buildNestedRouteBackedWidgetHref,
  parseRouteBackedWidgetOrigin,
} from "../../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetNestedBackLink,
  RouteBackedWidgetOverlay,
} from "../../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import ExpenseClaimDetailPage from "../../../../../../workspace/hr/expenses/by-id/[expenseClaimId]/page";
import ExpensesPage from "../../../../../../workspace/hr/expenses/page";
import MyWorkPage from "../../../../../../workspace/my-work/page";

interface Props {
  readonly params: Promise<{ expenseClaimId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function InterceptedExpenseClaimDetailPage({ params, searchParams }: Props) {
  const [{ expenseClaimId }, parameters] = await Promise.all([params, searchParams]);
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/expenses",
    "/workspace/my-work",
  ]);
  const fromMyWork =
    one(parameters.returnContext) === "my-work" || one(parameters.returnTo) === "my-work";
  const masterKind = fromMyWork
    ? "my-work"
    : one(parameters.returnTo) === "own"
      ? "own"
      : undefined;
  const ownCursor = masterKind === "own" ? parseOwnExpenseCursor(parameters) : undefined;
  const masterParameters =
    masterKind === "my-work"
      ? fromAssignedProviderMasterCursorParameters(parameters)
      : ownCursor
        ? {
            cursorCreatedAt: ownCursor.createdAt,
            cursorExpenseClaimId: ownCursor.expenseClaimId,
          }
        : {};
  const masterPathname = masterKind === "my-work" ? "/workspace/my-work" : "/workspace/hr/expenses";
  const masterQuery = new URLSearchParams(masterParameters).toString();
  const masterPath = masterQuery ? `${masterPathname}?${masterQuery}` : masterPathname;
  const leadingControl = masterKind ? (
    <RouteBackedWidgetNestedBackLink
      className="text-command detail-back"
      href={buildNestedRouteBackedWidgetHref(masterPath, origin)}
    >
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
      {masterKind === "my-work" ? "Back to My Work" : "Back to Expense Claims"}
    </RouteBackedWidgetNestedBackLink>
  ) : undefined;

  return (
    <RouteBackedWidgetOverlay
      browserBackMode={masterKind ? "return-master" : "close-origin"}
      fallbackHref={origin.fallbackHref}
      label="Expense Claim detail"
      origin={origin}
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close Expense Claim detail"
        fallbackHref={origin.fallbackHref}
        layout={masterKind ? "master-detail" : "single"}
        workspaceId={`hr-expense-${masterKind ?? "detail"}`}
      >
        {masterKind ? (
          <RouteBackedWidgetFocusPane kind="master">
            {masterKind === "my-work" ? (
              <MyWorkPage focusOrigin={origin} searchParams={Promise.resolve(masterParameters)} />
            ) : (
              <ExpensesPage
                focusOrigin={origin}
                mode="focus-master"
                searchParams={Promise.resolve(masterParameters)}
              />
            )}
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          <ExpenseClaimDetailPage
            focusOrigin={origin}
            leadingControl={leadingControl}
            params={Promise.resolve({ expenseClaimId })}
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
