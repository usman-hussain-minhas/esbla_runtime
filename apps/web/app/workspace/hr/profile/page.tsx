import { ContactRound, ShieldOff } from "lucide-react";
import { getOwnWorkforceProfileState } from "../../../../lib/hr-workforce-profile";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

export default async function HrWorkforceProfilePage() {
  const state = await getOwnWorkforceProfileState();

  return (
    <section aria-labelledby="workforce-profile-heading" className="work-surface profile-surface">
      <header className="surface-heading profile-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="workforce-profile-heading">Workforce profile</h1>
          <p className="surface-summary">Your privacy-minimized workforce identity.</p>
        </div>
        <a className="text-command" href="/workspace/hr">
          Back to HR
        </a>
      </header>

      {state.status === "ready" ? (
        <div className="profile-facts">
          <div className="profile-identity-icon" aria-hidden="true">
            <ContactRound size={28} strokeWidth={1.6} />
          </div>
          <dl>
            <div className="profile-fact">
              <dt>Employee number</dt>
              <dd>{state.profile.employeeNumber ?? "Not assigned"}</dd>
            </div>
            <div className="profile-fact">
              <dt>Status</dt>
              <dd>
                <span className="leave-status leave-status-approved">
                  {state.profile.workforceStatus}
                </span>
              </dd>
            </div>
            <div className="profile-fact">
              <dt>Last updated</dt>
              <dd>
                <time dateTime={state.profile.updatedAt}>
                  {formatDateTime(state.profile.updatedAt)}
                </time>
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="empty-worklist profile-unavailable" role="status">
          <span aria-hidden="true" className="empty-worklist-icon">
            <ShieldOff size={27} strokeWidth={1.6} />
          </span>
          <h2>
            {state.status === "inactive"
              ? "Workforce profiles are inactive"
              : "No active linked profile"}
          </h2>
          <p>
            {state.status === "inactive"
              ? "Your tenant administrator must activate this HR service."
              : "Your HR operator can create and link your workforce profile."}
          </p>
        </div>
      )}
    </section>
  );
}
