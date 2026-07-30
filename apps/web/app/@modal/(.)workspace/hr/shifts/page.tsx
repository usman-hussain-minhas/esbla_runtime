import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFullScreenFace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import OwnShiftsPage from "../../../../workspace/hr/shifts/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedShiftsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My shifts"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFullScreenFace
        closeLabel="Close My shifts"
        fallbackHref={origin.fallbackHref}
      >
        <OwnShiftsPage searchParams={Promise.resolve(parameters)} />
      </RouteBackedWidgetFullScreenFace>
    </RouteBackedWidgetOverlay>
  );
}
