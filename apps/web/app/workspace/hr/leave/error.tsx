"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";

export default function HrLeaveListError() {
  function retry() {
    // Re-enter the server-only signing boundary after an upstream recovery.
    window.location.reload();
  }

  return (
    <section aria-labelledby="leave-error-heading" className="work-surface leave-list-surface">
      <header className="surface-heading leave-list-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="leave-error-heading">My Leave Requests</h1>
        </div>
      </header>
      <div className="leave-list-error" role="alert">
        <span aria-hidden="true" className="empty-worklist-icon">
          <TriangleAlert size={27} strokeWidth={1.6} />
        </span>
        <h2>Requests could not be loaded</h2>
        <p>Try again when the local session and API are available.</p>
        <button className="command-button" onClick={retry} type="button">
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
          Try again
        </button>
      </div>
    </section>
  );
}
