import { parseRouteBackedWidgetOrigin } from "../../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import TimesheetCorrectionsPage from "../../../../../../workspace/hr/timesheets/admin/corrections/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedTimesheetCorrectionsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(
    parameters,
    "/workspace/hr",
    "/workspace/hr/timesheets/admin/corrections",
  );
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Timesheet corrections"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close Timesheet corrections"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-timesheet-corrections"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <TimesheetCorrectionsPage
            focusOrigin={origin}
            mode="focus"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
