import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  Settings2,
  UserRound,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import { loadEmploymentList } from "../../../lib/hr-employment-record";
import { hasEmploymentAction } from "../../../lib/hr-employment-record-core";
import {
  loadOwnShifts,
  loadRosterShifts,
  loadShiftServiceControl,
} from "../../../lib/hr-shift-assignment";
import { hasShiftAction } from "../../../lib/hr-shift-assignment-core";
import { loadAuthorizedWorkforceList } from "../../../lib/hr-workforce-profile-list";
import { loadWorkforceProfileServiceControl } from "../../../lib/hr-workforce-profile-service-control";

export default async function HrHubPage() {
  const [
    directReports,
    workforceAdministration,
    workforceServiceControl,
    employmentRecords,
    shifts,
    shiftReports,
    shiftServiceControl,
  ] = await Promise.all([
    loadAuthorizedWorkforceList({}, "direct_reports"),
    loadAuthorizedWorkforceList({}, "workforce"),
    loadWorkforceProfileServiceControl(),
    loadEmploymentList(),
    loadOwnShifts(),
    loadRosterShifts({
      rosterVersionId: "00000000-0000-4000-8000-000000000000",
      status: "active",
    }),
    loadShiftServiceControl(),
  ]);
  const canDiscoverWorkforceSettings =
    workforceServiceControl.status === "success" ||
    (workforceServiceControl.status === "error" && workforceServiceControl.kind === "not_found");
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
  return (
    <section aria-labelledby="hr-hub-heading" className="work-surface">
      <header className="surface-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="hr-hub-heading">People and work</h1>
          <p className="surface-summary">
            Open your workforce profile or continue to a focused HR service.
          </p>
        </div>
      </header>

      <ol aria-label="HR services" className="work-queue">
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
            <a className="text-command" href="/workspace/hr/profile">
              My workforce profile
              <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
            </a>
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
      </ol>
    </section>
  );
}
