import { parseRouteBackedWidgetOrigin } from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFullScreenFace,
  RouteBackedWidgetOverlay,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import EmploymentPage from "../../../../workspace/hr/employment/page";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function InterceptedEmploymentPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr");
  return (
    <RouteBackedWidgetOverlay
      fallbackHref={origin.fallbackHref}
      label="Employment facts"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFullScreenFace
        closeLabel="Close employment facts"
        fallbackHref={origin.fallbackHref}
      >
        <EmploymentPage searchParams={Promise.resolve(parameters)} />
      </RouteBackedWidgetFullScreenFace>
    </RouteBackedWidgetOverlay>
  );
}
