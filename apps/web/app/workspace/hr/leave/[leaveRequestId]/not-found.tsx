import { ArrowLeft, FileQuestion } from "lucide-react";
import type { ReactNode } from "react";

interface HrLeaveDetailNotFoundProps {
  readonly leadingControl?: ReactNode;
  readonly mode?: "overlay" | "standalone";
}

export default function HrLeaveDetailNotFound({
  leadingControl,
  mode = "standalone",
}: HrLeaveDetailNotFoundProps = {}) {
  return (
    <section
      aria-labelledby="leave-detail-missing-heading"
      className={`work-surface leave-detail-surface ${
        mode === "overlay" ? "leave-detail-overlay-face" : ""
      }`}
    >
      <div className="leave-detail-leading-control">
        {leadingControl ?? (
          <a className="text-command detail-back" href="/workspace/hr/leave">
            <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
            Back to My Leave Requests
          </a>
        )}
      </div>
      <div className="empty-worklist leave-detail-missing">
        <span aria-hidden="true" className="empty-worklist-icon">
          <FileQuestion size={27} strokeWidth={1.6} />
        </span>
        <h1 id="leave-detail-missing-heading">Leave request not found</h1>
        <p>It may not exist or may no longer be available to this account.</p>
      </div>
    </section>
  );
}
