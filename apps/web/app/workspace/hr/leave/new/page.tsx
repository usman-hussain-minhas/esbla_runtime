import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import {
  buildHrLeaveListHref,
  type HrLeaveFocusNavigation,
} from "../../../../../lib/hr-leave-navigation-core";
import { RouteBackedWidgetNestedBackLink } from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import { LeaveRequestForm } from "./leave-request-form";

export const dynamic = "force-dynamic";

export default function NewLeaveRequestPage({
  focusNavigation,
  mode = "standalone",
}: {
  readonly focusNavigation?: HrLeaveFocusNavigation;
  readonly mode?: "focus" | "standalone";
} = {}) {
  const masterHref = buildHrLeaveListHref(focusNavigation);
  return (
    <section
      aria-labelledby="new-leave-heading"
      className="work-surface leave-form-surface"
      data-leave-new-face={mode}
    >
      <header className="surface-heading leave-form-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="new-leave-heading">New leave request</h1>
          <p className="surface-summary">Request whole days away from work.</p>
        </div>
        {focusNavigation ? (
          <RouteBackedWidgetNestedBackLink href={masterHref}>
            <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
            Back to requests
          </RouteBackedWidgetNestedBackLink>
        ) : (
          <a className="text-command" href={masterHref}>
            <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
            Back to requests
          </a>
        )}
      </header>

      <LeaveRequestForm
        {...(focusNavigation ? { focusNavigation } : {})}
        idempotencyKey={randomUUID()}
      />
    </section>
  );
}
