import { ArrowRight, BadgeCheck, LoaderCircle, UserRoundX } from "lucide-react";
import { Suspense } from "react";
import { loadOwnWorkforceProfile } from "../../../../lib/hr-workforce-profile";
import type { RouteBackedWidgetOrigin } from "../../../../lib/route-backed-widget-navigation-core";
import { RouteBackedWidgetLink } from "../../../../theme/zen-theme/v1/route-backed-widget-link";

async function ProfilePanel({
  focusOrigin,
}: Readonly<{ focusOrigin?: RouteBackedWidgetOrigin | undefined }>) {
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
        <div className="work-queue-actions">
          <RouteBackedWidgetLink
            className="text-command"
            focusOrigin={focusOrigin}
            href={`/workspace/hr/profile/by-id/${encodeURIComponent(state.profile.workerProfileId)}?returnContext=own`}
          >
            View profile history
            <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
          </RouteBackedWidgetLink>
        </div>
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

export default function OwnWorkforceProfilePage({
  focusOrigin,
  mode = "standalone",
}: Readonly<{
  focusOrigin?: RouteBackedWidgetOrigin | undefined;
  mode?: "focus" | "standalone";
}>) {
  return (
    <section
      aria-labelledby="workforce-profile-heading"
      className="work-surface leave-detail-surface"
    >
      {mode === "standalone" ? (
        <a className="text-command detail-back" href="/workspace/hr">
          Back to HR
        </a>
      ) : null}
      <header className="surface-heading">
        <div>
          <p className="surface-label">Own Workforce</p>
          <h1 id="workforce-profile-heading">Workforce profile</h1>
          <p className="surface-summary">Your minimized active workforce record.</p>
        </div>
      </header>
      <Suspense fallback={<ProfileLoading />}>
        <ProfilePanel focusOrigin={focusOrigin} />
      </Suspense>
    </section>
  );
}
