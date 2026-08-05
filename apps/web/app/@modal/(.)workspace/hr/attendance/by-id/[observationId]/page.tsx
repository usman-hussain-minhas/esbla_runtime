import { ArrowLeft } from "lucide-react";
import {
  loadAttendanceDetail,
  loadOwnAttendance,
  loadReportAttendance,
} from "../../../../../../../lib/hr-attendance";
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
import AttendanceDetailPage from "../../../../../../workspace/hr/attendance/by-id/[observationId]/page";
import OwnAttendancePage from "../../../../../../workspace/hr/attendance/page";
import ReportAttendancePage from "../../../../../../workspace/hr/attendance/reports/page";

interface Props {
  readonly params: Promise<{ observationId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function InterceptedAttendanceDetailPage({ params, searchParams }: Props) {
  const [{ observationId }, parameters] = await Promise.all([params, searchParams]);
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/attendance",
    "/workspace/hr/attendance/reports",
  ]);
  const returnTo = one(parameters.returnTo);
  const masterKind = returnTo === "reports" ? "reports" : returnTo === "own" ? "own" : undefined;
  const masterPath =
    masterKind === "reports" ? "/workspace/hr/attendance/reports" : "/workspace/hr/attendance";
  const masterParameters = new URLSearchParams();
  const from = one(parameters.from);
  const to = one(parameters.to);
  if (from) masterParameters.set("from", from);
  if (to) masterParameters.set("to", to);
  const masterBaseHref = `${masterPath}${masterParameters.size > 0 ? `?${masterParameters}` : ""}`;
  const masterHref = buildNestedRouteBackedWidgetHref(masterBaseHref, origin);
  const detailState = await loadAttendanceDetail(observationId, parameters);
  const masterState =
    detailState.status === "success" && masterKind === "reports"
      ? await loadReportAttendance(parameters)
      : detailState.status === "success" && masterKind === "own"
        ? await loadOwnAttendance(parameters)
        : undefined;
  const showMaster = Boolean(masterKind) && masterState?.status === "success";
  const leadingControl = masterKind ? (
    <RouteBackedWidgetNestedBackLink href={masterHref}>
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
      Back to attendance
    </RouteBackedWidgetNestedBackLink>
  ) : undefined;

  return (
    <RouteBackedWidgetOverlay
      browserBackMode={showMaster ? "return-master" : "close-origin"}
      fallbackHref={origin.fallbackHref}
      label="Attendance detail"
      origin={origin}
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close Attendance detail"
        fallbackHref={origin.fallbackHref}
        layout={showMaster ? "master-detail" : "single"}
        workspaceId={`hr-attendance-${masterKind ?? "detail"}`}
      >
        {showMaster ? (
          <RouteBackedWidgetFocusPane kind="master">
            {masterKind === "reports" ? (
              <ReportAttendancePage
                focusOrigin={origin}
                mode="focus-master"
                preloadedState={masterState}
                searchParams={Promise.resolve(parameters)}
              />
            ) : (
              <OwnAttendancePage
                focusOrigin={origin}
                mode="focus-master"
                preloadedState={masterState}
                searchParams={Promise.resolve(parameters)}
              />
            )}
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          <AttendanceDetailPage
            focusOrigin={origin}
            leadingControl={leadingControl}
            mode="focus"
            params={Promise.resolve({ observationId })}
            preloadedState={detailState}
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
