import { parseRouteBackedWidgetOrigin } from "../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetOverlay,
} from "../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import MyWorkPage from "../../../workspace/my-work/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedMyWorkPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/", "/workspace/my-work");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My Work"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="master"
        closeLabel="Close My Work"
        fallbackHref={origin.fallbackHref}
        layout="single"
        workspaceId="my-work"
      >
        <RouteBackedWidgetFocusPane kind="master">
          <MyWorkPage focusOrigin={origin} searchParams={Promise.resolve(parameters)} />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
