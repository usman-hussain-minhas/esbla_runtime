"use client";

import { TriangleAlert } from "lucide-react";

export default function EmploymentError({ reset }: Readonly<{ reset: () => void }>) {
  return (
    <section aria-labelledby="employment-error" className="work-surface">
      <div className="leave-list-error" role="alert">
        <span aria-hidden="true" className="empty-worklist-icon">
          <TriangleAlert size={27} strokeWidth={1.6} />
        </span>
        <h1 id="employment-error">Employment records unavailable</h1>
        <p>The rendered page could not be completed. No employment history was changed.</p>
        <button className="command-button command-button-primary" onClick={reset} type="button">
          Try again
        </button>
      </div>
    </section>
  );
}
