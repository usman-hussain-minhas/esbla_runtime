export default function WorkforceProfileDetailLoading() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="workforce-detail-loading-heading"
      aria-live="polite"
      className="work-surface leave-detail-surface"
    >
      <header className="surface-heading leave-detail-heading">
        <div>
          <p className="surface-label">Workforce Profile</p>
          <h1 id="workforce-detail-loading-heading">Loading workforce profile...</h1>
        </div>
      </header>
      <div aria-hidden="true" className="leave-detail-skeleton">
        <span />
        <span />
      </div>
    </section>
  );
}
