import { BadgeCheck, LoaderCircle, UserRoundX } from "lucide-react";
import { Suspense } from "react";
import { loadOwnWorkforceProfile } from "../../../../lib/hr-workforce-profile";

async function ProfilePanel() {
  const state = await loadOwnWorkforceProfile();
  if (state.status !== "success") {
    return (
      <div className="empty-worklist">
        <span aria-hidden="true" className="empty-worklist-icon">
          <UserRoundX size={27} strokeWidth={1.6} />
        </span>
        <h2>{state.title}</h2>
        <p>{state.message}</p>
      </div>
    );
  }
  return (
    <div className="leave-detail-layout">
      <section className="leave-detail-section" aria-labelledby="profile-facts-heading">
        <div className="detail-section-heading">
          <BadgeCheck aria-hidden="true" size={19} strokeWidth={1.8} />
          <h2 id="profile-facts-heading">Current profile</h2>
        </div>
        <dl className="leave-detail-facts">
          <div>
            <dt>Workforce status</dt>
            <dd>
              <span className="leave-status">Active</span>
            </dd>
          </div>
          <div>
            <dt>Employee number</dt>
            <dd>{state.profile.employeeNumber ?? "Not assigned"}</dd>
          </div>
          <div>
            <dt>Principal link</dt>
            <dd>Connected</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function ProfileLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="empty-worklist" role="status">
      <span aria-hidden="true" className="empty-worklist-icon">
        <LoaderCircle className="submit-spinner" size={27} strokeWidth={1.6} />
      </span>
      <h2>Loading profile</h2>
      <p>Checking your current workforce profile.</p>
    </div>
  );
}

export default function OwnWorkforceProfilePage() {
  return (
    <section
      aria-labelledby="workforce-profile-heading"
      className="work-surface leave-detail-surface"
    >
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Own Workforce</p>
          <h1 id="workforce-profile-heading">Workforce profile</h1>
          <p className="surface-summary">Your minimized active workforce record.</p>
        </div>
      </header>
      <Suspense fallback={<ProfileLoading />}>
        <ProfilePanel />
      </Suspense>
    </section>
  );
}
