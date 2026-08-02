import { parseRouteBackedWidgetOrigin } from "../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import ReportAttendancePage from "../../../../../workspace/hr/attendance/reports/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedAttendanceReportsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Attendance reports"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close Attendance reports"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-attendance-reports"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <ReportAttendancePage
            focusOrigin={origin}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
