import { ArrowLeft } from "lucide-react";
import {
  loadEmploymentDetail,
  loadEmploymentList,
} from "../../../../../../../lib/hr-employment-record";
import {
  buildNestedRouteBackedWidgetHref,
  parseRouteBackedWidgetOrigin,
  withoutRouteBackedWidgetOrigin,
} from "../../../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetFocusPane,
  RouteBackedWidgetFocusWorkspace,
  RouteBackedWidgetNestedBackLink,
  RouteBackedWidgetOverlay,
} from "../../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import EmploymentDetailPage from "../../../../../../workspace/hr/employment/by-id/[employmentRecordId]/page";
import EmploymentPage from "../../../../../../workspace/hr/employment/page";

interface Props {
  readonly params: Promise<{ employmentRecordId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function InterceptedEmploymentDetailPage({ params, searchParams }: Props) {
  const [{ employmentRecordId }, parameters] = await Promise.all([params, searchParams]);
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/employment",
    "/workspace/hr/employment/admin",
    "/workspace/hr/profile/admin",
  ]);
  const returnTo = one(parameters.returnTo);
  const masterKind = returnTo === "list" ? "list" : returnTo === "admin" ? "admin" : undefined;
  const domainParameters = withoutRouteBackedWidgetOrigin(parameters);
  const detailState = await loadEmploymentDetail(employmentRecordId, domainParameters);
  const masterState =
    detailState.status === "success" && masterKind === "list"
      ? await loadEmploymentList()
      : undefined;
  const showMaster = masterKind === "list" && masterState?.status === "success";
  const masterPath =
    masterKind === "admin" ? "/workspace/hr/employment/admin" : "/workspace/hr/employment";
  const leadingControl = masterKind ? (
    <RouteBackedWidgetNestedBackLink
      className="text-command detail-back"
      href={buildNestedRouteBackedWidgetHref(masterPath, origin)}
    >
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
      {masterKind === "admin" ? "Back to employment administration" : "Back to employment records"}
    </RouteBackedWidgetNestedBackLink>
  ) : undefined;

  return (
    <RouteBackedWidgetOverlay
      browserBackMode={masterKind ? "return-master" : "close-origin"}
      fallbackHref={origin.fallbackHref}
      label="Employment detail"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close Employment detail"
        fallbackHref={origin.fallbackHref}
        layout={showMaster ? "master-detail" : "single"}
        workspaceId={
          showMaster ? "hr-employment-list" : `hr-employment-${masterKind ?? "detail"}-detail`
        }
      >
        {showMaster ? (
          <RouteBackedWidgetFocusPane kind="master">
            <EmploymentPage
              focusOrigin={origin}
              mode="focus-master"
              preloadedState={masterState}
              searchParams={Promise.resolve({})}
            />
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          <EmploymentDetailPage
            focusOrigin={origin}
            leadingControl={leadingControl}
            mode="focus"
            params={Promise.resolve({ employmentRecordId })}
            preloadedState={detailState}
            searchParams={Promise.resolve(
              domainParameters as Record<string, string | string[] | undefined>,
            )}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
