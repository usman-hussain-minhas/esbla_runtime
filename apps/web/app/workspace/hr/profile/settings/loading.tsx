import { LoaderCircle } from "lucide-react";

export default function WorkforceProfileSettingsLoading() {
  return (
    <section aria-busy="true" aria-labelledby="workforce-settings-loading" className="work-surface">
      <div className="empty-worklist">
        <LoaderCircle aria-hidden="true" className="submit-spinner" size={24} />
        <h1 id="workforce-settings-loading">Loading Workforce Profile settings...</h1>
        <p>Checking current tenant-admin authority and service state.</p>
      </div>
    </section>
  );
}
