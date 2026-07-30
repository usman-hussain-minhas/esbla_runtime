export default function UniversalSettingsLoading() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading Universal Settings"
      className="work-surface universal-settings-surface"
    >
      <p className="surface-label">Universal Settings</p>
      <div className="universal-settings-loading">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}
