import { randomUUID } from "node:crypto";
import { loadWorkforceProfileServiceControl } from "../../../../../lib/hr-workforce-profile-service-control";
import { WorkforceProfileSettingsControl } from "./workforce-profile-settings-control";

export default async function WorkforceProfileSettingsPage() {
  const loaded = await loadWorkforceProfileServiceControl();
  const canInitialize = loaded.status === "error" && loaded.kind === "not_found";
  return (
    <section
      aria-labelledby="workforce-settings-heading"
      className="work-surface leave-form-surface"
    >
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Tenant administration</p>
          <h1 id="workforce-settings-heading">Workforce Profile settings</h1>
          <p className="surface-summary">
            Control service availability and its exact tenant settings. This page does not grant
            access to workforce records.
          </p>
        </div>
      </header>
      {loaded.status === "success" || canInitialize ? (
        <WorkforceProfileSettingsControl
          idempotencyKeys={{
            activate: randomUUID(),
            configure: randomUUID(),
            deactivate: randomUUID(),
          }}
          initialControl={loaded.status === "success" ? loaded.control : null}
        />
      ) : (
        <section aria-labelledby="workforce-settings-unavailable" className="empty-worklist">
          <h2 id="workforce-settings-unavailable">Service controls unavailable</h2>
          <p>{loaded.message}</p>
        </section>
      )}
    </section>
  );
}
