import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import { getWorkforceOnboardingStorageKey } from "../../../../../lib/hr-workforce-profile";
import {
  AuthorizedWorkforceList,
  AuthorizedWorkforceListLoading,
} from "../authorized-workforce-list";
import { WorkforceProfileOnboarding } from "./workforce-profile-onboarding";

interface WorkforceProfileAdminPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function WorkforceProfileAdminPage({
  searchParams,
}: WorkforceProfileAdminPageProps) {
  const parameters = await searchParams;
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
      <section aria-labelledby="workforce-directory-heading" className="leave-detail-section">
        <header className="surface-heading">
          <div>
            <p className="surface-label">Authorized Workforce</p>
            <h2 id="workforce-directory-heading">Workforce directory</h2>
            <p className="surface-summary">
              Status-filtered profiles available through your current HR role.
            </p>
          </div>
        </header>
        <Suspense fallback={<AuthorizedWorkforceListLoading view="workforce" />}>
          <AuthorizedWorkforceList searchParams={parameters} view="workforce" />
        </Suspense>
      </section>
    </section>
  );
}
