"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";

export default function MyWorkError() {
  function retry() {
    // Re-enter the server-only signing boundary after an upstream recovery.
    window.location.reload();
  }

  return (
    <section aria-labelledby="my-work-error-heading" className="work-surface my-work-surface">
      <header className="surface-heading my-work-heading">
        <div>
          <p className="surface-label">My Work</p>
          <h1 id="my-work-error-heading">Assigned approvals</h1>
        </div>
      </header>
      <div className="leave-list-error" role="alert">
        <span aria-hidden="true" className="empty-worklist-icon">
          <TriangleAlert size={27} strokeWidth={1.6} />
        </span>
        <h2>Your queue could not be loaded</h2>
        <p>Try again in a moment.</p>
        <button className="command-button" onClick={retry} type="button">
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
          Try again
        </button>
      </div>
    </section>
  );
}
