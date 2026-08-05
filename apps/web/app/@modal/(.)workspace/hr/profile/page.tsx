import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import OwnWorkforceProfilePage from "../../../../workspace/hr/profile/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedProfilePage({ searchParams }: Props) {
  const origin = parseRouteBackedWidgetOrigin(
    await searchParams,
    "/workspace/hr",
    "/workspace/hr/profile",
  );
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Workforce profile"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close workforce profile"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="hr-workforce-own"
      >
        <RouteBackedWidgetFocusPane kind="detail">
          <OwnWorkforceProfilePage focusOrigin={origin} mode="focus" />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
