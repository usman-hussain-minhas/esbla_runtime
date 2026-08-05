import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import ExpensesPage from "../../../../workspace/hr/expenses/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedExpensesPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(
    parameters,
    "/workspace/hr",
    "/workspace/hr/expenses",
  );
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My Expense Claims"
      origin={origin}
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close My Expense Claims"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-expense-list"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <ExpensesPage
            focusOrigin={origin}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
