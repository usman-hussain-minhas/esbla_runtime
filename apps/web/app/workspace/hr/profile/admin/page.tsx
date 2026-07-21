import { randomUUID } from "node:crypto";
import { WorkforceProfileManager } from "./workforce-profile-manager";

export default function WorkforceProfileManagePage() {
  return (
    <section
      aria-labelledby="workforce-manage-heading"
      className="work-surface profile-manage-surface"
    >
      <header className="surface-heading profile-heading">
        <div>
          <p className="surface-label">HR operator</p>
          <h1 id="workforce-manage-heading">Create workforce profile</h1>
          <p className="surface-summary">Create, link, and activate one worker identity.</p>
        </div>
        <a className="text-command" href="/workspace/hr">
          Back to HR
        </a>
      </header>

      <WorkforceProfileManager
        idempotencyKeys={{
          activate: randomUUID(),
          create: randomUUID(),
          link: randomUUID(),
        }}
      />
    </section>
  );
}
