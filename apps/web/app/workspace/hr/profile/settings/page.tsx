import { randomUUID } from "node:crypto";
import { getWorkforceControlState } from "../../../../../lib/hr-workforce-profile-manage";
import { WorkforceProfileServiceControl } from "./workforce-profile-service-control";

export default async function WorkforceProfileSettingsPage() {
  const state = await getWorkforceControlState();
  return (
    <section
      aria-labelledby="workforce-settings-heading"
      className="work-surface profile-manage-surface"
    >
      <header className="surface-heading profile-heading">
        <div>
          <p className="surface-label">Tenant administration</p>
          <h1 id="workforce-settings-heading">Workforce service control</h1>
          <p className="surface-summary">Activate or deactivate this exact HR service.</p>
        </div>
        <a className="text-command" href="/workspace/hr">
          Back to HR
        </a>
      </header>

      <WorkforceProfileServiceControl
        idempotencyKeys={{ activate: randomUUID(), deactivate: randomUUID() }}
        initialControl={state.status === "ready" ? state.control : null}
      />
    </section>
  );
}
