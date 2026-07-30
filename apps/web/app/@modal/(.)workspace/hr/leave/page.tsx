import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFullScreenFace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import HrLeaveRequestPage from "../../../../workspace/hr/leave/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedLeavePage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My leave requests"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFullScreenFace
        closeLabel="Close My leave requests"
        fallbackHref={origin.fallbackHref}
      >
        <HrLeaveRequestPage searchParams={Promise.resolve(parameters)} />
      </RouteBackedWidgetFullScreenFace>
    </RouteBackedWidgetOverlay>
  );
}
