import { ArrowLeft, BriefcaseBusiness, Clock3, FileClock, TriangleAlert } from "lucide-react";
import { notFound } from "next/navigation";
import { loadEmploymentDetail } from "../../../../../../lib/hr-employment-record";
import { hasEmploymentAction } from "../../../../../../lib/hr-employment-record-core";

interface EmploymentDetailPageProps {
  readonly params: Promise<{ employmentRecordId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const statusLabel = { active: "Active", draft: "Draft", ended: "Ended" } as const;

export default async function EmploymentDetailPage({
  params,
  searchParams,
}: EmploymentDetailPageProps) {
  const [{ employmentRecordId }, parameters] = await Promise.all([params, searchParams]);
  const state = await loadEmploymentDetail(employmentRecordId, parameters);
  const canList = hasEmploymentAction(state.authorizedActions, "list_authorized");
  const canAdminister = (["create_record", "create_version", "end_record"] as const).some(
    (action) => hasEmploymentAction(state.authorizedActions, action),
  );
  const backHref = canList ? "/workspace/hr/employment" : "/workspace/hr";
  const backLabel = canList ? "Back to employment records" : "Back to HR";
  if (state.status === "error" && state.kind === "not_found") notFound();
  if (state.status !== "success") {
    return (
      <section aria-labelledby="employment-detail-failure" className="work-surface">
        <a className="text-command detail-back" href={backHref}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
          {backLabel}
        </a>
        <div className="leave-list-error" role="alert">
          <span aria-hidden="true" className="empty-worklist-icon">
            <TriangleAlert size={27} strokeWidth={1.6} />
          </span>
          <h1 id="employment-detail-failure">{state.title}</h1>
          <p>{state.message}</p>
        </div>
      </section>
    );
  }

  const { record } = state;
  return (
    <section
      aria-labelledby="employment-detail-heading"
      className="work-surface leave-detail-surface"
    >
      <a className="text-command detail-back" href={backHref}>
        <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
        {backLabel}
      </a>
      <header className="surface-heading leave-detail-heading">
        <div>
          <p className="surface-label">Employment Record</p>
          <h1 id="employment-detail-heading">Effective employment facts</h1>
          <p className="surface-summary">
            Immutable factual versions only; no compensation, document, payroll, or legal meaning.
          </p>
        </div>
        <span className="leave-status">{statusLabel[record.status]}</span>
      </header>
      {canAdminister ? (
        <div className="work-queue-actions">
          <a
            className="command-button command-button-primary"
            href="/workspace/hr/employment/admin"
          >
            Manage employment records
          </a>
        </div>
      ) : null}

      <div className="leave-detail-layout">
        <section aria-labelledby="employment-current-heading" className="leave-detail-section">
          <div className="detail-section-heading">
            <BriefcaseBusiness aria-hidden="true" size={20} strokeWidth={1.7} />
            <h2 id="employment-current-heading">Current facts</h2>
          </div>
          <dl className="leave-detail-facts">
            <div>
              <dt>Worker profile</dt>
              <dd>{record.workerProfileId}</dd>
            </div>
            <div>
              <dt>Root version</dt>
              <dd>{record.version}</dd>
            </div>
            <div>
              <dt>Current effective version</dt>
              <dd>{record.currentVersion?.version ?? "Not established"}</dd>
            </div>
            <div>
              <dt>Employment type code</dt>
              <dd>{record.currentVersion?.employmentTypeCode ?? "Not specified"}</dd>
            </div>
            <div>
              <dt>Effective from</dt>
              <dd>{record.currentVersion?.effectiveFrom ?? "Not established"}</dd>
            </div>
            <div>
              <dt>Effective to</dt>
              <dd>
                {record.currentVersion
                  ? (record.currentVersion.effectiveTo ?? "Open ended")
                  : "Not established"}
              </dd>
            </div>
            <div>
              <dt>Organization reference</dt>
              <dd>{record.currentVersion?.organizationReference ?? "Not specified"}</dd>
            </div>
            <div>
              <dt>Position reference</dt>
              <dd>{record.currentVersion?.positionReference ?? "Not specified"}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="employment-history-heading" className="leave-detail-section">
          <div className="detail-section-heading">
            <FileClock aria-hidden="true" size={20} strokeWidth={1.7} />
            <h2 id="employment-history-heading">Immutable version history</h2>
          </div>
          {record.history.items.length === 0 ? (
            <div className="leave-detail-copy">
              <p>No effective version has been established.</p>
            </div>
          ) : (
            <ol aria-labelledby="employment-history-heading" className="leave-history">
              {record.history.items.map((item) => (
                <li className="leave-history-item" key={item.employmentRecordVersionId}>
                  <span aria-hidden="true" className="leave-history-marker">
                    <Clock3 size={14} strokeWidth={1.8} />
                  </span>
                  <div>
                    <strong>
                      {item.kind === "end"
                        ? "Employment ended"
                        : `Effective version ${item.version}`}
                    </strong>
                    <p>
                      {item.effectiveFrom} to {item.effectiveTo ?? "open ended"}
                      {item.employmentTypeCode ? ` · ${item.employmentTypeCode}` : ""}
                    </p>
                    <p>
                      Organization {item.organizationReference ?? "not specified"}; position{" "}
                      {item.positionReference ?? "not specified"}.
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {record.history.nextCursor ? (
            <nav aria-label="Employment history pages" className="work-queue-actions">
              <a
                className="text-command"
                href={`/workspace/hr/employment/by-id/${encodeURIComponent(
                  record.employmentRecordId,
                )}?cursorVersion=${record.history.nextCursor.version}&cursorEmploymentRecordVersionId=${encodeURIComponent(
                  record.history.nextCursor.employmentRecordVersionId,
                )}`}
              >
                Next history
              </a>
            </nav>
          ) : null}
        </section>
      </div>
    </section>
  );
}
