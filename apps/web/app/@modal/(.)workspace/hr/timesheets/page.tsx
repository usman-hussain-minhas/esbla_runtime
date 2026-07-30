import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFullScreenFace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import TimesheetsPage from "../../../../workspace/hr/timesheets/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedTimesheetsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="My Timesheets"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFullScreenFace
        closeLabel="Close My Timesheets"
        fallbackHref={origin.fallbackHref}
      >
        <TimesheetsPage searchParams={Promise.resolve(parameters)} />
      </RouteBackedWidgetFullScreenFace>
    </RouteBackedWidgetOverlay>
  );
}
