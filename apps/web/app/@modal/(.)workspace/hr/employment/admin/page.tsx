import { parseRouteBackedWidgetOrigin } from "../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import EmploymentAdminPage from "../../../../../workspace/hr/employment/admin/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedEmploymentAdminPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Employment administration"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close Employment administration"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-employment-admin"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <EmploymentAdminPage
            focusOrigin={origin}
            mode="focus"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
