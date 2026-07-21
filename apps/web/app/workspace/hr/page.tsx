import { ArrowRight, CalendarDays, UserRound, UserRoundPlus } from "lucide-react";

export default function HrHubPage() {
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
            <a className="text-command" href="/workspace/hr/profile/admin">
              <UserRoundPlus aria-hidden="true" size={15} strokeWidth={1.8} />
              Workforce administration
            </a>
          </div>
        </li>
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
