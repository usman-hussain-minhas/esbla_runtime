export default function HrLeaveListLoading() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="leave-loading-heading"
      aria-live="polite"
      className="work-surface leave-list-surface"
    >
      <header className="surface-heading leave-list-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="leave-loading-heading">My Leave Requests</h1>
          <p className="surface-summary">Loading your requests...</p>
        </div>
      </header>
      <div aria-hidden="true" className="leave-list-skeleton">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}
