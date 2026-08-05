import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import OwnShiftsPage from "../../../../workspace/hr/shifts/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedShiftsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", "/workspace/hr/shifts");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My shifts"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close My shifts"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-shifts-own"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <OwnShiftsPage
            focusOrigin={origin}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
