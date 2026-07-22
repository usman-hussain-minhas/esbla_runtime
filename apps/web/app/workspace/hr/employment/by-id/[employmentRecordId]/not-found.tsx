import { FileQuestion } from "lucide-react";

export default function EmploymentNotFound() {
  return (
    <section aria-labelledby="employment-not-found" className="work-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <div className="empty-worklist">
        <span aria-hidden="true" className="empty-worklist-icon">
          <FileQuestion size={28} strokeWidth={1.6} />
        </span>
        <h1 id="employment-not-found">Employment record not found</h1>
        <p>The requested record is not available through your current authorized view.</p>
      </div>
    </section>
  );
}
