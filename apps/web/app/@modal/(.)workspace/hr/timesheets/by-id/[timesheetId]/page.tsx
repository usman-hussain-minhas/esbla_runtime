import { ArrowLeft } from "lucide-react";
import { fromAssignedProviderMasterCursorParameters } from "../../../../../../../lib/assigned-provider-core";
import {
  parseOwnTimesheetCursor,
  TIMESHEET_CORRECTIONS_SURFACE_PATH,
} from "../../../../../../../lib/hr-timesheet-core";
import {
  buildNestedRouteBackedWidgetHref,
  parseRouteBackedWidgetOrigin,
} from "../../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetNestedBackLink,
  RouteBackedWidgetOverlay,
} from "../../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import TimesheetDetailPage from "../../../../../../workspace/hr/timesheets/by-id/[timesheetId]/page";
import TimesheetsPage from "../../../../../../workspace/hr/timesheets/page";
import MyWorkPage from "../../../../../../workspace/my-work/page";

interface Props {
  readonly params: Promise<{ timesheetId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function InterceptedTimesheetDetailPage({ params, searchParams }: Props) {
  const [{ timesheetId }, parameters] = await Promise.all([params, searchParams]);
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/timesheets",
    "/workspace/hr/timesheets/admin/corrections",
    "/workspace/my-work",
  ]);
  const fromMyWork =
    one(parameters.returnContext) === "my-work" || one(parameters.returnTo) === "my-work";
  const navigationKind = fromMyWork
    ? "my-work"
    : one(parameters.returnTo) === "own"
      ? "own"
      : one(parameters.returnTo) === "corrections"
        ? "corrections"
        : undefined;
  const showMaster = navigationKind === "my-work" || navigationKind === "own";
  const ownCursor = navigationKind === "own" ? parseOwnTimesheetCursor(parameters) : undefined;
  const masterParameters =
    navigationKind === "my-work"
      ? fromAssignedProviderMasterCursorParameters(parameters)
      : ownCursor
        ? {
            cursorPeriodStart: ownCursor.periodStart,
            cursorTimesheetId: ownCursor.timesheetId,
          }
        : {};
  const masterPathname =
    navigationKind === "my-work"
      ? "/workspace/my-work"
      : navigationKind === "corrections"
        ? TIMESHEET_CORRECTIONS_SURFACE_PATH
        : "/workspace/hr/timesheets";
  const masterQuery = new URLSearchParams(masterParameters).toString();
  const masterPath = masterQuery ? `${masterPathname}?${masterQuery}` : masterPathname;
  const leadingControl = navigationKind ? (
    <RouteBackedWidgetNestedBackLink
      className="text-command detail-back"
      href={buildNestedRouteBackedWidgetHref(masterPath, origin)}
    >
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
      {navigationKind === "my-work"
        ? "Back to My Work"
        : navigationKind === "corrections"
          ? "Back to Timesheet corrections"
          : "Back to Timesheets"}
    </RouteBackedWidgetNestedBackLink>
  ) : undefined;

  return (
    <RouteBackedWidgetOverlay
      browserBackMode={navigationKind ? "return-master" : "close-origin"}
      fallbackHref={origin.fallbackHref}
      label="Timesheet detail"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close Timesheet detail"
        fallbackHref={origin.fallbackHref}
        layout={showMaster ? "master-detail" : "single"}
        workspaceId={`hr-timesheet-${navigationKind ?? "detail"}`}
      >
        {showMaster ? (
          <RouteBackedWidgetFocusPane kind="master">
            {navigationKind === "my-work" ? (
              <MyWorkPage focusOrigin={origin} searchParams={Promise.resolve(masterParameters)} />
            ) : (
              <TimesheetsPage
                focusOrigin={origin}
                mode="focus-master"
                searchParams={Promise.resolve(masterParameters)}
              />
            )}
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          <TimesheetDetailPage
            focusOrigin={origin}
            leadingControl={leadingControl}
            params={Promise.resolve({ timesheetId })}
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
