import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  Clock3,
  ReceiptText,
  Settings2,
  UserRound,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import { Suspense } from "react";
import {
  loadAttendanceServiceControl,
  loadOwnAttendance,
  loadReportAttendance,
} from "../../../lib/hr-attendance";
import { hasAttendanceAction } from "../../../lib/hr-attendance-core";
import { loadEmploymentList } from "../../../lib/hr-employment-record";
import { hasEmploymentAction } from "../../../lib/hr-employment-record-core";
import { loadOwnExpenseClaims } from "../../../lib/hr-expense-claim";
import { hasExpenseAction } from "../../../lib/hr-expense-claim-core";
import {
  loadOwnShifts,
  loadRosterShifts,
  loadShiftServiceControl,
} from "../../../lib/hr-shift-assignment";
import { hasShiftAction } from "../../../lib/hr-shift-assignment-core";
import { loadOwnTimesheets, loadTimesheetServiceControl } from "../../../lib/hr-timesheet";
import {
  hasTimesheetAction,
  TIMESHEET_CORRECTIONS_SURFACE_PATH,
} from "../../../lib/hr-timesheet-core";
import { loadOwnWorkforceProfile } from "../../../lib/hr-workforce-profile";
import { loadAuthorizedWorkforceList } from "../../../lib/hr-workforce-profile-list";
import { loadWorkforceProfileServiceControl } from "../../../lib/hr-workforce-profile-service-control";
import { getResponsivePresentationWidgetPlacement } from "../../../lib/presentation-layout-core";
import { loadOwnResponsivePresentationSurfaceLayout } from "../../../lib/presentation-surfaces";
import { getEligibleZenSurfaceSections } from "../../../lib/zen-section-rail-core";
import { getSurfaceDefinition } from "../../../theme/zen-theme/v1";
import { ZenSectionRail } from "../../../theme/zen-theme/v1/surfaces/zen-section-rail";
import {
  HrLeaveMyRequestsWidget,
  HrLeaveMyRequestsWidgetLoading,
} from "../../../theme/zen-theme/v1/widgets/hr-leave-my-requests-widget";

export default async function HrHubPage() {
  const [
    directReports,
    workforceAdministration,
    workforceServiceControl,
    ownWorkforceProfile,
    employmentRecords,
    shifts,
    shiftReports,
    shiftServiceControl,
    ownAttendance,
    reportAttendance,
    attendanceServiceControl,
    ownTimesheets,
    timesheetServiceControl,
    ownExpenses,
    surfaceLayout,
  ] = await Promise.all([
    loadAuthorizedWorkforceList({}, "direct_reports"),
    loadAuthorizedWorkforceList({}, "workforce"),
    loadWorkforceProfileServiceControl(),
    loadOwnWorkforceProfile(),
    loadEmploymentList(),
    loadOwnShifts(),
    loadRosterShifts({
      rosterVersionId: "00000000-0000-4000-8000-000000000000",
      status: "active",
    }),
    loadShiftServiceControl(),
    loadOwnAttendance(),
    loadReportAttendance(),
    loadAttendanceServiceControl(),
    loadOwnTimesheets(),
    loadTimesheetServiceControl(),
    loadOwnExpenseClaims(),
    loadOwnResponsivePresentationSurfaceLayout("surface.hr.mission-control").catch(() => undefined),
  ]);
  const leavePlacement = surfaceLayout
    ? getResponsivePresentationWidgetPlacement(surfaceLayout, "hr-mission-control.my-leave")
    : undefined;
  const canDiscoverWorkforceSettings =
    workforceServiceControl.status === "success" ||
    (workforceServiceControl.status === "error" && workforceServiceControl.kind === "not_found");
  const canViewOwnWorkforce =
    ownWorkforceProfile.status === "success" || ownWorkforceProfile.status === "empty";
  const canDiscoverWorkforce =
    canViewOwnWorkforce ||
    workforceAdministration.status === "success" ||
    directReports.status === "success" ||
    canDiscoverWorkforceSettings;
  const employmentActions = employmentRecords.authorizedActions;
  const canListEmployment = hasEmploymentAction(employmentActions, "list_authorized");
  const canAdministerEmployment = (["create_record", "create_version", "end_record"] as const).some(
    (action) => hasEmploymentAction(employmentActions, action),
  );
  const canControlEmployment = (
    ["activate_service", "configure_service", "deactivate_service", "view_service_control"] as const
  ).some((action) => hasEmploymentAction(employmentActions, action));
  const canDiscoverEmployment = employmentActions.length > 0;
  const shiftActions = shifts.authorizedActions;
  const canViewOwnShifts =
    hasShiftAction(shiftActions, "list_roster") && shifts.status === "success";
  const reportActions = shiftReports.authorizedActions;
  const canMutateRoster = (["assign", "cancel", "create_roster", "publish"] as const).some(
    (action) => hasShiftAction(reportActions, action),
  );
  const canViewReportShifts =
    shiftReports.status === "error" &&
    ((shiftReports.kind === "denied" && canMutateRoster) ||
      (shiftReports.kind === "not_found" &&
        (canMutateRoster || hasShiftAction(reportActions, "list_roster"))));
  const shiftLinks = [
    [canViewOwnShifts, "/workspace/hr/shifts", "My shifts"],
    [canViewReportShifts, "/workspace/hr/shifts/reports", "Report shifts"],
  ].filter(([visible]) => visible);
  const canControlShifts = (
    ["activate_service", "configure_service", "deactivate_service", "view_service_control"] as const
  ).some((action) => hasShiftAction(shiftServiceControl.authorizedActions, action));
  const attendanceActions = [
    ...new Set([
      ...ownAttendance.authorizedActions,
      ...reportAttendance.authorizedActions,
      ...attendanceServiceControl.authorizedActions,
    ]),
  ];
  const canViewOwnAttendance = hasAttendanceAction(attendanceActions, "list_own");
  const canViewReportAttendance = hasAttendanceAction(attendanceActions, "list_reports");
  const canControlAttendance = (
    ["activate_service", "configure_service", "deactivate_service", "view_service_control"] as const
  ).some((action) => hasAttendanceAction(attendanceActions, action));
  const timesheetActions = [
    ...new Set([...ownTimesheets.authorizedActions, ...timesheetServiceControl.authorizedActions]),
  ];
  const canViewOwnTimesheets = hasTimesheetAction(timesheetActions, "list_own");
  const canCreateTimesheetCorrection = hasTimesheetAction(timesheetActions, "create_correction");
  const canControlTimesheets = (
    ["activate_service", "configure_service", "deactivate_service", "view_service_control"] as const
  ).some((action) => hasTimesheetAction(timesheetActions, action));
  const expenseActions = ownExpenses.authorizedActions;
  const canViewOwnExpenses = hasExpenseAction(expenseActions, "list_own");
  const canControlExpenses = (
    ["activate_service", "configure_service", "deactivate_service", "view_service_control"] as const
  ).some((action) => hasExpenseAction(expenseActions, action));
  const hasAuthorizedHrServiceContent =
    canDiscoverWorkforce ||
    canDiscoverEmployment ||
    shiftActions.length > 0 ||
    shiftServiceControl.authorizedActions.length > 0 ||
    attendanceActions.length > 0 ||
    canViewOwnTimesheets ||
    canCreateTimesheetCorrection ||
    canControlTimesheets ||
    canViewOwnExpenses ||
    canControlExpenses ||
    Boolean(leavePlacement);
  const eligibleSections = getEligibleZenSurfaceSections(
    getSurfaceDefinition("surface.hr.mission-control"),
    {
      authorizedContentAnchorIds: hasAuthorizedHrServiceContent ? ["hr-services"] : [],
      eligibleWidgetInstanceIds: leavePlacement ? ["hr-mission-control.my-leave"] : [],
    },
  );
  return (
    <section
      aria-labelledby="hr-hub-heading"
      className="mission-control-surface"
      data-zen-section-id="overview"
    >
      <ZenSectionRail sections={eligibleSections} />
      <header className="mission-control-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 data-zen-section-heading="overview" id="hr-hub-heading">
            People and work
          </h1>
          <p className="surface-summary">Continue to an eligible HR service or widget.</p>
        </div>
      </header>

      <div className="widget-grid">
        {surfaceLayout && leavePlacement ? (
          <Suspense
            fallback={
              <HrLeaveMyRequestsWidgetLoading
                placement={leavePlacement}
                surfaceId="surface.hr.mission-control"
              />
            }
          >
            <HrLeaveMyRequestsWidget
              placement={leavePlacement}
              surfaceId="surface.hr.mission-control"
            />
          </Suspense>
        ) : surfaceLayout ? (
          <div className="zen-surface-empty">
            <strong>No eligible HR widgets</strong>
            <p>Active HR services available to your account will appear here.</p>
          </div>
        ) : (
          <div className="zen-surface-unavailable" role="alert">
            <strong>HR layout is unavailable</strong>
            <p>Your saved layout could not be loaded. No private error detail is shown.</p>
          </div>
        )}
      </div>

      <ol aria-label="HR services" className="work-queue" data-zen-content-anchor="hr-services">
        {canDiscoverWorkforce ? (
          <li className="work-queue-item">
            <div className="work-queue-primary">
              <div>
                <p className="work-queue-kicker">Workforce Profile</p>
                <h2>Profile and onboarding</h2>
                <p className="work-queue-dates">
                  Eligible employees can view their active profile. Workforce administration checks
                  current permission and service availability on every action.
                </p>
              </div>
              <span aria-hidden="true" className="empty-worklist-icon">
                <UserRound size={25} strokeWidth={1.7} />
              </span>
            </div>
            <div className="work-queue-actions">
              {canViewOwnWorkforce ? (
                <a className="text-command" href="/workspace/hr/profile">
                  My workforce profile
                  <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                </a>
              ) : null}
              {workforceAdministration.status === "success" ? (
                <a className="text-command" href="/workspace/hr/profile/admin">
                  <UserRoundPlus aria-hidden="true" size={15} strokeWidth={1.8} />
                  Workforce administration
                </a>
              ) : null}
              {directReports.status === "success" ? (
                <a className="text-command" href="/workspace/hr/profile/direct-reports">
                  <UsersRound aria-hidden="true" size={15} strokeWidth={1.8} />
                  Direct reports
                </a>
              ) : null}
              {canDiscoverWorkforceSettings ? (
                <a className="text-command" href="/workspace/hr/profile/settings">
                  <Settings2 aria-hidden="true" size={15} strokeWidth={1.8} />
                  Workforce settings
                </a>
              ) : null}
            </div>
          </li>
        ) : null}
        {canDiscoverEmployment ? (
          <li className="work-queue-item">
            <div className="work-queue-primary">
              <div>
                <p className="work-queue-kicker">Employment Record</p>
                <h2>Effective employment facts</h2>
                <p className="work-queue-dates">
                  Review current opaque facts and immutable effective history without compensation,
                  document, payroll, or legal meaning.
                </p>
              </div>
              <span aria-hidden="true" className="empty-worklist-icon">
                <BriefcaseBusiness size={25} strokeWidth={1.7} />
              </span>
            </div>
            <div className="work-queue-actions">
              {canListEmployment ? (
                <a className="text-command" href="/workspace/hr/employment">
                  Open employment facts
                  <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                </a>
              ) : null}
              {canAdministerEmployment ? (
                <a className="text-command" href="/workspace/hr/employment/admin">
                  Employment administration
                </a>
              ) : null}
              {canControlEmployment ? (
                <a className="text-command" href="/workspace/hr/employment/settings">
                  <Settings2 aria-hidden="true" size={15} strokeWidth={1.8} />
                  Employment settings
                </a>
              ) : null}
            </div>
          </li>
        ) : null}
        {shiftActions.length > 0 || shiftServiceControl.authorizedActions.length > 0 ? (
          <li className="work-queue-item">
            <div className="work-queue-primary">
              <div>
                <p className="work-queue-kicker">Shift Assignment</p>
                <h2>Published work rosters</h2>
              </div>
            </div>
            <div className="work-queue-actions">
              {shiftLinks.map(([, href, label]) => (
                <a className="text-command" href={String(href)} key={String(href)}>
                  {label}
                </a>
              ))}
              {canControlShifts ? (
                <a className="text-command" href="/workspace/hr/shifts/settings">
                  <Settings2 aria-hidden="true" size={15} strokeWidth={1.8} />
                  Shift settings
                </a>
              ) : null}
            </div>
          </li>
        ) : null}
        {attendanceActions.length > 0 ? (
          <li className="work-queue-item">
            <div className="work-queue-primary">
              <div>
                <p className="work-queue-kicker">Attendance</p>
                <h2>Recorded presence facts</h2>
                <p className="work-queue-dates">
                  Review authorized Attendance observations and their immutable correction history.
                </p>
              </div>
              <span aria-hidden="true" className="empty-worklist-icon">
                <Clock3 size={25} strokeWidth={1.7} />
              </span>
            </div>
            <div className="work-queue-actions">
              {canViewOwnAttendance ? (
                <a className="text-command" href="/workspace/hr/attendance">
                  My attendance
                  <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                </a>
              ) : null}
              {canViewReportAttendance ? (
                <a className="text-command" href="/workspace/hr/attendance/reports">
                  Report attendance
                </a>
              ) : null}
              {canControlAttendance ? (
                <a className="text-command" href="/workspace/hr/attendance/settings">
                  <Settings2 aria-hidden="true" size={15} strokeWidth={1.8} />
                  Attendance settings
                </a>
              ) : null}
            </div>
          </li>
        ) : null}
        {canViewOwnTimesheets || canCreateTimesheetCorrection || canControlTimesheets ? (
          <li className="work-queue-item">
            <div className="work-queue-primary">
              <div>
                <p className="work-queue-kicker">Timesheet</p>
                <h2>Weekly work-time facts</h2>
                <p className="work-queue-dates">
                  Record and review bounded weekly minutes without Project, billing, invoicing, or
                  payroll meaning.
                </p>
              </div>
              <span aria-hidden="true" className="empty-worklist-icon">
                <Clock3 size={25} strokeWidth={1.7} />
              </span>
            </div>
            <div className="work-queue-actions">
              {canViewOwnTimesheets ? (
                <a className="text-command" href="/workspace/hr/timesheets">
                  My Timesheets
                  <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                </a>
              ) : null}
              {canCreateTimesheetCorrection ? (
                <a className="text-command" href={TIMESHEET_CORRECTIONS_SURFACE_PATH}>
                  Timesheet corrections
                </a>
              ) : null}
              {canControlTimesheets ? (
                <a className="text-command" href="/workspace/hr/timesheets/settings">
                  <Settings2 aria-hidden="true" size={15} strokeWidth={1.8} />
                  Timesheet settings
                </a>
              ) : null}
            </div>
          </li>
        ) : null}
        {canViewOwnExpenses || canControlExpenses ? (
          <li className="work-queue-item">
            <div className="work-queue-primary">
              <div>
                <p className="work-queue-kicker">Expense Claim Boundary</p>
                <h2>Bounded claim facts</h2>
                <p className="work-queue-dates">
                  Record claim lines without receipts, Finance handoff, reimbursement, payment, or
                  money movement.
                </p>
              </div>
              <span aria-hidden="true" className="empty-worklist-icon">
                <ReceiptText size={25} strokeWidth={1.7} />
              </span>
            </div>
            <div className="work-queue-actions">
              {canViewOwnExpenses ? (
                <a className="text-command" href="/workspace/hr/expenses">
                  My Expense Claims
                  <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                </a>
              ) : null}
              {canControlExpenses ? (
                <a className="text-command" href="/workspace/hr/expenses/settings">
                  <Settings2 aria-hidden="true" size={15} strokeWidth={1.8} />
                  Expense Claim settings
                </a>
              ) : null}
            </div>
          </li>
        ) : null}
        {leavePlacement ? (
          <li className="work-queue-item">
            <div className="work-queue-primary">
              <div>
                <p className="work-queue-kicker">Leave Request</p>
                <h2>Whole-day leave</h2>
                <p className="work-queue-dates">
                  Submit a request and review its current status and evidence history.
                </p>
              </div>
              <span aria-hidden="true" className="empty-worklist-icon">
                <CalendarDays size={25} strokeWidth={1.7} />
              </span>
            </div>
            <div className="work-queue-actions">
              <a className="text-command" href="/workspace/hr/leave">
                Open leave requests
                <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
              </a>
            </div>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
