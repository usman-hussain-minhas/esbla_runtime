import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import { LeaveRequestForm } from "./leave-request-form";

export const dynamic = "force-dynamic";

export default function NewLeaveRequestPage() {
  return (
    <section aria-labelledby="new-leave-heading" className="work-surface leave-form-surface">
      <header className="surface-heading leave-form-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="new-leave-heading">New leave request</h1>
          <p className="surface-summary">Request whole days away from work.</p>
        </div>
        <a className="text-command" href="/workspace/hr/leave">
          <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
          Back to requests
        </a>
      </header>

      <LeaveRequestForm idempotencyKey={randomUUID()} />
    </section>
  );
}
