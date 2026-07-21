export default function HrWorkforceProfileLoading() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="workforce-profile-loading-heading"
      aria-live="polite"
      className="work-surface profile-surface"
    >
      <header className="surface-heading">
        <div>
          <p className="surface-label">HR</p>
          <h1 id="workforce-profile-loading-heading">Workforce profile</h1>
          <p className="surface-summary">Loading your profile...</p>
        </div>
      </header>
      <div aria-hidden="true" className="leave-list-skeleton">
        <span />
        <span />
      </div>
    </section>
  );
}
