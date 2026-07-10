export default function HrLeaveDetailLoading() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="leave-detail-loading-heading"
      aria-live="polite"
      className="work-surface leave-detail-surface"
    >
      <header className="surface-heading leave-detail-heading">
        <div>
          <p className="surface-label">HR leave request</p>
          <h1 id="leave-detail-loading-heading">Loading request details...</h1>
        </div>
      </header>
      <div aria-hidden="true" className="leave-detail-skeleton">
        <span />
        <span />
      </div>
    </section>
  );
}
