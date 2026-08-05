import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import TimesheetsPage from "../../../../workspace/hr/timesheets/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedTimesheetsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(
    parameters,
    "/workspace/hr",
    "/workspace/hr/timesheets",
  );
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My Timesheets"
      origin={origin}
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close My Timesheets"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-timesheet-list"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <TimesheetsPage
            focusOrigin={origin}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
