import { Suspense } from "react";
import {
  AuthorizedWorkforceList,
  AuthorizedWorkforceListLoading,
} from "../authorized-workforce-list";

interface DirectReportsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DirectReportsPage({ searchParams }: DirectReportsPageProps) {
  const parameters = await searchParams;
  return (
    <section aria-labelledby="direct-reports-heading" className="work-surface leave-list-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading leave-list-heading">
        <div>
          <p className="surface-label">Workforce Profile</p>
          <h1 id="direct-reports-heading">Direct reports</h1>
          <p className="surface-summary">
            Current effective reports available through your current manager role.
          </p>
        </div>
      </header>
      <Suspense fallback={<AuthorizedWorkforceListLoading view="direct_reports" />}>
        <AuthorizedWorkforceList searchParams={parameters} view="direct_reports" />
      </Suspense>
    </section>
  );
}
