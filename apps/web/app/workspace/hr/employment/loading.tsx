import { BriefcaseBusiness } from "lucide-react";

export default function EmploymentLoading() {
  return (
    <section aria-busy="true" aria-labelledby="employment-loading" className="work-surface">
      <div className="empty-worklist" role="status">
        <span aria-hidden="true" className="empty-worklist-icon">
          <BriefcaseBusiness size={28} strokeWidth={1.6} />
        </span>
        <h1 id="employment-loading">Loading employment facts</h1>
        <p>Checking current role, service availability, and immutable history.</p>
      </div>
    </section>
  );
}
