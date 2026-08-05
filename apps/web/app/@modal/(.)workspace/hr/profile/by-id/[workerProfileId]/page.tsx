import { ArrowLeft } from "lucide-react";
import { loadAuthorizedWorkforceProfileDetail } from "../../../../../../../lib/hr-workforce-profile-detail";
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
import WorkforceProfileAdminPage from "../../../../../../workspace/hr/profile/admin/page";
import WorkforceProfileDetailPage from "../../../../../../workspace/hr/profile/by-id/[workerProfileId]/page";
import DirectReportsPage from "../../../../../../workspace/hr/profile/direct-reports/page";

interface Props {
  readonly params: Promise<{ workerProfileId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function InterceptedWorkforceDetailPage({ params, searchParams }: Props) {
  const [{ workerProfileId }, parameters] = await Promise.all([params, searchParams]);
  const origin = parseRouteBackedWidgetOrigin(parameters, "/workspace/hr", [
    "/workspace/hr/employment",
    "/workspace/hr/employment/admin",
    "/workspace/hr/profile",
    "/workspace/hr/profile/direct-reports",
    "/workspace/hr/profile/admin",
  ]);
  const returnContext = one(parameters.returnContext);
  const masterKind =
    returnContext === "admin"
      ? "admin"
      : returnContext === "direct-reports"
        ? "direct-reports"
        : returnContext === "own"
          ? "own"
          : undefined;
  const productParameters = withoutRouteBackedWidgetOrigin(parameters) as Record<
    string,
    string | string[] | undefined
  >;
  const detailState = await loadAuthorizedWorkforceProfileDetail(
    workerProfileId,
    productParameters,
  );
  const showMaster = masterKind === "admin" || masterKind === "direct-reports";
  const masterPath =
    masterKind === "admin"
      ? "/workspace/hr/profile/admin"
      : masterKind === "direct-reports"
        ? "/workspace/hr/profile/direct-reports"
        : "/workspace/hr/profile";
  const leadingControl = masterKind ? (
    <RouteBackedWidgetNestedBackLink
      className="text-command detail-back"
      href={buildNestedRouteBackedWidgetHref(masterPath, origin)}
    >
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
      {masterKind === "admin"
        ? "Back to workforce administration"
        : masterKind === "direct-reports"
          ? "Back to direct reports"
          : "Back to my profile"}
    </RouteBackedWidgetNestedBackLink>
  ) : undefined;

  return (
    <RouteBackedWidgetOverlay
      browserBackMode={masterKind ? "return-master" : "close-origin"}
      fallbackHref={origin.fallbackHref}
      label="Workforce profile detail"
      returnFocusId={origin.returnFocusId}
    >
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel="Close Workforce profile detail"
        fallbackHref={origin.fallbackHref}
        layout={showMaster ? "master-detail" : "single"}
        workspaceId={
          masterKind === "admin"
            ? "hr-workforce-admin"
            : masterKind === "direct-reports"
              ? "hr-workforce-direct-reports"
              : "hr-workforce-own"
        }
      >
        {showMaster ? (
          <RouteBackedWidgetFocusPane kind="master">
            {masterKind === "admin" ? (
              <WorkforceProfileAdminPage
                focusOrigin={origin}
                mode="focus-master"
                searchParams={Promise.resolve({ status: "active" })}
              />
            ) : (
              <DirectReportsPage
                focusOrigin={origin}
                mode="focus-master"
                searchParams={Promise.resolve({})}
              />
            )}
          </RouteBackedWidgetFocusPane>
        ) : null}
        <RouteBackedWidgetFocusPane kind="detail">
          <WorkforceProfileDetailPage
            focusOrigin={origin}
            leadingControl={leadingControl}
            mode="focus"
            params={Promise.resolve({ workerProfileId })}
            preloadedState={detailState}
            searchParams={Promise.resolve(productParameters)}
          />
        </RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </RouteBackedWidgetOverlay>
  );
}
