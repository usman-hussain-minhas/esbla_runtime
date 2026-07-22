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
import { loadAuthorizedWorkforceList } from "../../../lib/hr-workforce-profile-list";
import { loadWorkforceProfileServiceControl } from "../../../lib/hr-workforce-profile-service-control";

export default async function HrHubPage() {
  const [directReports, workforceAdministration, workforceServiceControl, employmentRecords] =
    await Promise.all([
      loadAuthorizedWorkforceList({}, "direct_reports"),
      loadAuthorizedWorkforceList({}, "workforce"),
      loadWorkforceProfileServiceControl(),
      loadEmploymentList(),
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
