import { ArrowRight, BriefcaseBusiness, FileClock, TriangleAlert } from "lucide-react";
import { loadEmploymentList } from "../../../../lib/hr-employment-record";
import { hasEmploymentAction } from "../../../../lib/hr-employment-record-core";

interface EmploymentPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const statusLabel = { active: "Active", draft: "Draft", ended: "Ended" } as const;

export default async function EmploymentPage({ searchParams }: EmploymentPageProps) {
  const state = await loadEmploymentList(await searchParams);
  const canAdminister = (["create_record", "create_version", "end_record"] as const).some(
    (action) => hasEmploymentAction(state.authorizedActions, action),
  );
  const canViewDetail = hasEmploymentAction(state.authorizedActions, "view_detail");
  return (
    <section aria-labelledby="employment-heading" className="work-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Employment Record</p>
          <h1 id="employment-heading">Employment facts</h1>
          <p className="surface-summary">
            Current effective facts and immutable history. These records do not represent a signed
            contract, compensation, benefits, or legal advice.
          </p>
        </div>
      </header>

      {state.status !== "success" ? (
        <>
          <section
            aria-labelledby="employment-unavailable"
            className="leave-list-error"
            role="alert"
          >
            <span aria-hidden="true" className="empty-worklist-icon">
              <TriangleAlert size={27} strokeWidth={1.6} />
            </span>
            <h2 id="employment-unavailable">{state.title}</h2>
            <p>{state.message}</p>
          </section>
          {canAdminister ? (
            <div className="work-queue-actions">
              <a
                className="command-button command-button-primary"
                href="/workspace/hr/employment/admin"
              >
                Employment administration
              </a>
            </div>
          ) : null}
        </>
      ) : state.page.items.length === 0 ? (
        <section aria-labelledby="employment-empty" className="empty-worklist">
          <span aria-hidden="true" className="empty-worklist-icon">
            <BriefcaseBusiness size={28} strokeWidth={1.6} />
          </span>
          <h2 id="employment-empty">No employment records</h2>
          <p>No employment facts are available through your current authorized view.</p>
          {canAdminister ? (
            <a
              className="command-button command-button-primary"
              href="/workspace/hr/employment/admin"
            >
              Open employment administration
            </a>
          ) : null}
        </section>
      ) : (
        <>
          <div className="work-queue-actions">
            {canAdminister ? (
              <a
                className="command-button command-button-primary"
                href="/workspace/hr/employment/admin"
              >
                Employment administration
              </a>
            ) : null}
          </div>
          <ol aria-label="Authorized employment records" className="work-queue">
            {state.page.items.map((record) => (
              <li className="work-queue-item" key={record.employmentRecordId}>
                <div className="work-queue-primary">
                  <div>
                    <p className="work-queue-kicker">Worker profile</p>
                    <h2>{record.workerProfileId}</h2>
                    <p className="work-queue-dates">
                      {record.currentVersion
                        ? `Effective ${record.currentVersion.effectiveFrom} to ${
                            record.currentVersion.effectiveTo ?? "open ended"
                          }`
                        : "Draft with no effective version"}
                    </p>
                  </div>
                  <span className="leave-status">{statusLabel[record.status]}</span>
                </div>
                {canViewDetail ? (
                  <div className="work-queue-actions">
                    <a
                      className="text-command"
                      href={`/workspace/hr/employment/by-id/${encodeURIComponent(
                        record.employmentRecordId,
                      )}`}
                    >
                      <FileClock aria-hidden="true" size={15} strokeWidth={1.8} />
                      View facts and history
                      <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                    </a>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          {state.page.nextCursor ? (
            <nav aria-label="Employment record pages" className="work-queue-actions">
              <a
                className="text-command"
                href={`/workspace/hr/employment?cursorCreatedAt=${encodeURIComponent(
                  state.page.nextCursor.createdAt,
                )}&cursorEmploymentRecordId=${encodeURIComponent(
                  state.page.nextCursor.employmentRecordId,
                )}`}
              >
                Next records
              </a>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
