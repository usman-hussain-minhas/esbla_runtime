import { ArrowLeft } from "lucide-react";
import {
  loadOwnShifts,
  loadRosterShifts,
  loadShiftDetail,
} from "../../../../../../../lib/hr-shift-assignment";
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
import ShiftDetailPage from "../../../../../../workspace/hr/shifts/by-id/[shiftAssignmentId]/page";
import OwnShiftsPage from "../../../../../../workspace/hr/shifts/page";
import ReportShiftsPage from "../../../../../../workspace/hr/shifts/reports/page";

interface Props {
  readonly params: Promise<{ shiftAssignmentId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function InterceptedShiftDetailPage({ params, searchParams }: Props) {
  const [{ shiftAssignmentId }, parameters] = await Promise.all([params, searchParams]);
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/shifts",
    "/workspace/hr/shifts/reports",
  ]);
  const returnTo = one(parameters.returnTo);
  const rosterVersionId = one(parameters.rosterVersionId);
  const masterKind =
    returnTo === "reports" && rosterVersionId ? "reports" : returnTo === "own" ? "own" : undefined;
  const masterParameters = new URLSearchParams();
  if (masterKind === "reports") {
    masterParameters.set("rosterVersionId", rosterVersionId as string);
    masterParameters.set("status", one(parameters.status) === "cancelled" ? "cancelled" : "active");
  } else {
    const from = one(parameters.from);
    const to = one(parameters.to);
    if (from) masterParameters.set("from", from);
    if (to) masterParameters.set("to", to);
  }
  const masterPath =
    masterKind === "reports" ? "/workspace/hr/shifts/reports" : "/workspace/hr/shifts";
  const masterBaseHref = `${masterPath}${masterParameters.size > 0 ? `?${masterParameters}` : ""}`;
  const masterHref = buildNestedRouteBackedWidgetHref(masterBaseHref, origin);
  const detailState = await loadShiftDetail(shiftAssignmentId);
  const masterState =
    detailState.status === "success" && masterKind === "reports"
      ? await loadRosterShifts({
          rosterVersionId: rosterVersionId as string,
          status: one(parameters.status) === "cancelled" ? "cancelled" : "active",
        })
      : detailState.status === "success" && masterKind === "own"
        ? await loadOwnShifts(parameters)
        : undefined;
  const showMaster = Boolean(masterKind) && masterState?.status === "success";
  const leadingControl = masterKind ? (
    <RouteBackedWidgetNestedBackLink href={masterHref}>
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
      Back to shifts
    </RouteBackedWidgetNestedBackLink>
  ) : undefined;

  return (
    <RouteBackedWidgetOverlay
      browserBackMode={showMaster ? "return-master" : "close-origin"}
      fallbackHref={origin.fallbackHref}
      label="Shift assignment"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close Shift assignment"
        fallbackHref={origin.fallbackHref}
        layout={showMaster ? "master-detail" : "single"}
        workspaceId={`hr-shifts-${masterKind ?? "detail"}`}
      >
        {showMaster ? (
          <RouteBackedWidgetFocusPane kind="master">
            {masterKind === "reports" ? (
              <ReportShiftsPage
                focusOrigin={origin}
                mode="focus-master"
                preloadedState={masterState}
                searchParams={Promise.resolve(parameters)}
              />
            ) : (
              <OwnShiftsPage
                focusOrigin={origin}
                mode="focus-master"
                preloadedState={masterState}
                searchParams={Promise.resolve(parameters)}
              />
            )}
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          <ShiftDetailPage
            leadingControl={leadingControl}
            mode="focus"
            params={Promise.resolve({ shiftAssignmentId })}
            preloadedState={detailState}
            searchParams={Promise.resolve(parameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
