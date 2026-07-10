export default function MyWorkLoading() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="my-work-loading-heading"
      aria-live="polite"
      className="work-surface my-work-surface"
    >
      <header className="surface-heading my-work-heading">
        <div>
          <p className="surface-label">My Work</p>
          <h1 id="my-work-loading-heading">Assigned approvals</h1>
          <p className="surface-summary">Loading your queue...</p>
        </div>
      </header>
      <div aria-hidden="true" className="work-queue-skeleton">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}
