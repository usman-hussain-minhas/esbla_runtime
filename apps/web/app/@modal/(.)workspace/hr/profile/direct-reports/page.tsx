import { parseRouteBackedWidgetOrigin } from "../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import DirectReportsPage from "../../../../../workspace/hr/profile/direct-reports/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedDirectReportsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Direct reports"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close Direct reports"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-workforce-direct-reports"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <DirectReportsPage
            focusOrigin={origin}
            mode="focus-master"
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
