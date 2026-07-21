import { randomUUID } from "node:crypto";
import { getWorkforceOnboardingStorageKey } from "../../../../../lib/hr-workforce-profile";
import { WorkforceProfileOnboarding } from "./workforce-profile-onboarding";

export default function WorkforceProfileAdminPage() {
  return (
    <section aria-labelledby="workforce-admin-heading" className="work-surface leave-form-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Workforce Admin</p>
          <h1 id="workforce-admin-heading">Onboard a worker</h1>
          <p className="surface-summary">
            Create a draft, link an active canonical principal, then activate the profile. Each step
            is checked independently.
          </p>
        </div>
      </header>
      <WorkforceProfileOnboarding
        idempotencyKeys={{ activate: randomUUID(), create: randomUUID(), link: randomUUID() }}
        storageKey={getWorkforceOnboardingStorageKey()}
      />
    </section>
  );
}
