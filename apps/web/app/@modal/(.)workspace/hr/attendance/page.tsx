import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import OwnAttendancePage from "../../../../workspace/hr/attendance/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedAttendancePage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My attendance"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close My attendance"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-attendance-own"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <OwnAttendancePage
            focusOrigin={origin}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
