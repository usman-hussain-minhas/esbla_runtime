import { parseRouteBackedWidgetOrigin } from "../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import ReportShiftsPage from "../../../../../workspace/hr/shifts/reports/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedShiftReportsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(
    parameters,
    "/workspace/hr",
    "/workspace/hr/shifts/reports",
  );
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Report shifts"
      origin={origin}
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close Report shifts"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-shifts-reports"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <ReportShiftsPage
            focusOrigin={origin}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
