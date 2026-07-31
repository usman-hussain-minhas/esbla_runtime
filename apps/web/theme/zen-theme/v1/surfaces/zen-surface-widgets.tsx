import { type ComponentType, Suspense } from "react";
import {
  getResponsivePresentationWidgetPlacement,
  type ResolvedResponsivePresentationSurfaceLayout,
  type ResponsivePresentationWidgetPlacement,
} from "../../../../lib/presentation-layout-core";
import type { SurfaceDefinition } from "../index";
import {
  HrLeaveMyRequestsWidget,
  HrLeaveMyRequestsWidgetLoading,
} from "../widgets/hr-leave-my-requests-widget";
import {
  AttendanceCorrectionQueueWidget,
  AttendanceObservationsWidget,
  AttendanceReportsWidget,
  DirectReportsWidget,
  EmploymentAdminQueueWidget,
  EmploymentFactsWidget,
  EmploymentHistoryWidget,
  ExpenseClaimsWidget,
  MyWorkWidget,
  PublishedShiftsWidget,
  RepresentativeWidgetLoading,
  RosterOverviewWidget,
  RosterPublishQueueWidget,
  TimesheetsWidget,
  WorkforceAdminQueueWidget,
  WorkforceProfileWidget,
  WorkforceStatusReportingWidget,
  WorkspaceTasksWidget,
} from "../widgets/hr-representative-widgets";

interface ZenSurfaceWidgetProps {
  readonly placement: ResponsivePresentationWidgetPlacement;
  readonly surfaceId: SurfaceDefinition["id"];
}

const COMPONENTS = Object.freeze({
  "hr.attendance.correction-queue": AttendanceCorrectionQueueWidget,
  "hr.attendance.my-observations": AttendanceObservationsWidget,
  "hr.attendance.reports": AttendanceReportsWidget,
  "hr.employment.admin-queue": EmploymentAdminQueueWidget,
  "hr.employment.current-facts": EmploymentFactsWidget,
  "hr.employment.history": EmploymentHistoryWidget,
  "hr.expense.mine": ExpenseClaimsWidget,
  "hr.leave.my-requests": HrLeaveMyRequestsWidget,
  "hr.shift.my-published": PublishedShiftsWidget,
  "hr.shift.publish-queue": RosterPublishQueueWidget,
  "hr.shift.roster-overview": RosterOverviewWidget,
  "hr.timesheet.mine": TimesheetsWidget,
  "hr.workforce.admin-queue": WorkforceAdminQueueWidget,
  "hr.workforce.direct-reports": DirectReportsWidget,
  "hr.workforce.my-profile": WorkforceProfileWidget,
  "hr.workforce.status-reporting": WorkforceStatusReportingWidget,
  "platform.my-work.queue": MyWorkWidget,
  "workspace.tasks.mine": WorkspaceTasksWidget,
}) satisfies Readonly<Record<string, ComponentType<ZenSurfaceWidgetProps>>>;

export function ZenSurfaceWidgets({
  layout,
  surfaceId,
}: Readonly<{
  layout: ResolvedResponsivePresentationSurfaceLayout;
  surfaceId: SurfaceDefinition["id"];
}>) {
  return layout.layouts[0].placements.map(({ instanceId, widgetDefinitionId }) => {
    const placement = getResponsivePresentationWidgetPlacement(layout, instanceId);
    const Widget = COMPONENTS[widgetDefinitionId as keyof typeof COMPONENTS];
    if (!placement || !Widget) {
      throw new Error("Eligible Zen surface widget binding is missing");
    }
    const loading =
      widgetDefinitionId === "hr.leave.my-requests" ? (
        <HrLeaveMyRequestsWidgetLoading placement={placement} surfaceId={surfaceId} />
      ) : (
        <RepresentativeWidgetLoading placement={placement} surfaceId={surfaceId} />
      );
    return (
      <Suspense fallback={loading} key={instanceId}>
        <Widget placement={placement} surfaceId={surfaceId} />
      </Suspense>
    );
  });
}
