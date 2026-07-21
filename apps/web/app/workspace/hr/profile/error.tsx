"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";

export default function HrWorkforceProfileError() {
  return (
    <section
      aria-labelledby="workforce-profile-error-heading"
      className="work-surface profile-surface"
    >
      <header className="surface-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="workforce-profile-error-heading">Workforce profile</h1>
        </div>
      </header>
      <div className="leave-list-error" role="alert">
        <span aria-hidden="true" className="empty-worklist-icon">
          <TriangleAlert size={27} strokeWidth={1.6} />
        </span>
        <h2>Profile could not be loaded</h2>
        <p>Try again when the local session and API are available.</p>
        <button className="command-button" onClick={() => window.location.reload()} type="button">
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
          Try again
        </button>
      </div>
    </section>
  );
}
