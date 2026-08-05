import { parseRouteBackedWidgetOrigin } from "../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import WorkforceProfileAdminPage from "../../../../../workspace/hr/profile/admin/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedWorkforceAdminPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/employment",
    "/workspace/hr/employment/admin",
    "/workspace/hr/profile/admin",
  ]);
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Workforce administration"
      origin={origin}
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close Workforce administration"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-workforce-admin"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <WorkforceProfileAdminPage
            focusOrigin={origin}
            mode="focus"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
