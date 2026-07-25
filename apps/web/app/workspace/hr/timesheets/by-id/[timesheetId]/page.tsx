import { randomUUID } from "node:crypto";
import { loadTimesheetDetail } from "../../../../../../lib/hr-timesheet";
import {
  hasTimesheetAction,
  TIMESHEET_CORRECTIONS_SURFACE_PATH,
} from "../../../../../../lib/hr-timesheet-core";
import { TimesheetResult } from "../../result";

interface Props {
  readonly params: Promise<{ timesheetId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
const resultCopy = {
  conflict: "Timesheet changed. Current persistent values are shown.",
  current: "Current persistent Timesheet status and history are shown.",
  denied: "Your current role does not permit that Timesheet action.",
  dependency_unavailable: "A required Timesheet dependency is unavailable.",
  inactive: "Timesheet is inactive. Existing history remains preserved.",
  not_found: "This Timesheet is not available.",
  operational_error: "The Timesheet action was not confirmed. Review current values.",
  validation: "Dates, entries, or submitted values are invalid.",
} as const;
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function label(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
function minutes(value: number): string {
  return `${Math.floor(value / 60)}h ${value % 60}m`;
}
export default async function TimesheetDetailPage({ params, searchParams }: Props) {
  const [{ timesheetId }, parameters] = await Promise.all([params, searchParams]);
  const state = await loadTimesheetDetail(timesheetId, parameters);
  const returnTo = one(parameters.returnTo);
  const returnContext = one(parameters.returnContext);
  const fromMyWork = returnTo === "my-work" || returnContext === "my-work";
  const fromCorrections = returnTo === "corrections";
  const back =
    returnTo === "own"
      ? "/workspace/hr/timesheets"
      : fromCorrections
        ? TIMESHEET_CORRECTIONS_SURFACE_PATH
        : fromMyWork
          ? "/workspace/my-work"
          : "/workspace/hr";
  const result = one(parameters.result);
  const detail = state.status === "success" ? state.detail : null;
  const canApprove =
    detail?.accessScope === "assigned" &&
    detail.currentVersion.status === "submitted" &&
    hasTimesheetAction(state.authorizedActions, "approve");
  const canReject =
    detail?.accessScope === "assigned" &&
    detail.currentVersion.status === "submitted" &&
    hasTimesheetAction(state.authorizedActions, "reject");
  const canCreateCorrection =
    detail?.accessScope === "tenant" &&
    (detail.currentVersion.status === "approved" || detail.currentVersion.status === "rejected") &&
    hasTimesheetAction(state.authorizedActions, "create_correction");
  return (
    <section aria-labelledby="timesheet-detail-heading" className="work-surface">
      <a className="text-command detail-back" href={back}>
        {fromMyWork
          ? "Back to My Work"
          : fromCorrections
            ? "Back to Timesheet corrections"
            : "Back to Timesheets"}
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Timesheet</p>
          <h1 id="timesheet-detail-heading">Timesheet detail</h1>
          <p className="surface-summary">
            Review current entries and evidence-backed persistent version history.
          </p>
        </div>
        {detail ? (
          <span className="leave-status">{label(detail.currentVersion.status)}</span>
        ) : null}
      </header>
      {result &&
      Object.hasOwn(resultCopy, result) &&
      (result !== "current" || state.status === "success") ? (
        <TimesheetResult
          message={resultCopy[result as keyof typeof resultCopy]}
          success={result === "current"}
        />
      ) : null}
      {state.status === "error" ? (
        <div className="form-error-summary" role="alert">
          <h2>{state.title}</h2>
          <p>{state.message}</p>
        </div>
      ) : (
        <div className="leave-detail-layout">
          <section aria-labelledby="timesheet-current-heading" className="leave-detail-section">
            <h2 id="timesheet-current-heading">Current Timesheet</h2>
            <dl className="leave-detail-facts">
              <div>
                <dt>Period</dt>
                <dd>
                  {state.detail.periodStart} to {state.detail.periodEnd}
                </dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{minutes(state.detail.currentVersion.totalMinutes)}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{state.detail.currentVersion.version}</dd>
              </div>
              <div>
                <dt>Worker profile</dt>
                <dd>{state.detail.workerProfileId}</dd>
              </div>
            </dl>
            {state.detail.currentVersion.entries.length === 0 ? (
              <div className="empty-worklist">
                <p>No entries are recorded in this version.</p>
              </div>
            ) : (
              <ol aria-label="Timesheet entries" className="work-queue">
                {state.detail.currentVersion.entries.map((entry) => (
                  <li className="work-queue-item" key={entry.timesheetEntryId}>
                    <strong>{entry.entryDate}</strong>
                    <span>{minutes(entry.minutes)}</span>
                    {entry.description ? <p>{entry.description}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-labelledby="timesheet-history-heading" className="leave-detail-section">
            <h2 id="timesheet-history-heading">Version history</h2>
            <ol className="history-list">
              {state.detail.history?.items.map((item) => (
                <li key={item.timesheetVersionId}>
                  <strong>
                    Version {item.version}: {label(item.status)}
                  </strong>
                  <span>{minutes(item.totalMinutes)}</span>
                  {item.decisionNote ? <p>{item.decisionNote}</p> : null}
                </li>
              ))}
            </ol>
            {state.detail.history?.nextCursor ? (
              <a
                className="text-command"
                href={`?${new URLSearchParams({
                  ...(fromMyWork ? { returnContext: "my-work" } : returnTo ? { returnTo } : {}),
                  cursorTimesheetVersionId: state.detail.history.nextCursor.timesheetVersionId,
                  cursorVersion: String(state.detail.history.nextCursor.version),
                })}`}
              >
                Older Timesheet versions
              </a>
            ) : null}
          </section>
          {canCreateCorrection ? (
            <section
              aria-labelledby="timesheet-correction-heading"
              className="leave-detail-section"
            >
              <h2 id="timesheet-correction-heading">Create a correction version</h2>
              <p className="field-hint">
                This preserves the terminal version and creates one empty successor draft for the
                employee to complete and submit.
              </p>
              <form
                action="/workspace/hr/timesheets/action"
                className="leave-request-form"
                method="post"
              >
                <input name="operation" type="hidden" value="create_correction" />
                <input name="timesheetId" type="hidden" value={state.detail.timesheetId} />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                <input name="expectedRootVersion" type="hidden" value={state.detail.rootVersion} />
                <input
                  name="expectedTimesheetVersionId"
                  type="hidden"
                  value={state.detail.currentVersion.timesheetVersionId}
                />
                <input
                  name="expectedVersion"
                  type="hidden"
                  value={state.detail.currentVersion.rowVersion}
                />
                <input name="returnTo" type="hidden" value="corrections" />
                <button className="command-button command-button-primary" type="submit">
                  Create correction draft
                </button>
              </form>
            </section>
          ) : null}
          {canApprove || canReject ? (
            <section aria-labelledby="timesheet-decision-heading" className="leave-detail-section">
              <h2 id="timesheet-decision-heading">Manager decision</h2>
              <p className="field-hint">
                Your current manager role and assigned authority are rechecked when the decision is
                recorded.
              </p>
              {canApprove ? (
                <form
                  action="/workspace/hr/timesheets/action"
                  className="leave-request-form"
                  method="post"
                >
                  <input name="operation" type="hidden" value="approve" />
                  <input name="timesheetId" type="hidden" value={state.detail.timesheetId} />
                  <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                  <input
                    name="expectedRootVersion"
                    type="hidden"
                    value={state.detail.rootVersion}
                  />
                  <input
                    name="expectedTimesheetVersionId"
                    type="hidden"
                    value={state.detail.currentVersion.timesheetVersionId}
                  />
                  <input
                    name="expectedVersion"
                    type="hidden"
                    value={state.detail.currentVersion.rowVersion}
                  />
                  <input name="returnTo" type="hidden" value={fromMyWork ? "my-work" : "detail"} />
                  <div className="form-field">
                    <label htmlFor="timesheet-approval-note">Approval note</label>
                    <textarea id="timesheet-approval-note" maxLength={2000} name="decisionNote" />
                  </div>
                  <button className="command-button command-button-primary" type="submit">
                    Approve Timesheet
                  </button>
                </form>
              ) : null}
              {canReject ? (
                <form
                  action="/workspace/hr/timesheets/action"
                  className="leave-request-form"
                  method="post"
                >
                  <input name="operation" type="hidden" value="reject" />
                  <input name="timesheetId" type="hidden" value={state.detail.timesheetId} />
                  <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                  <input
                    name="expectedRootVersion"
                    type="hidden"
                    value={state.detail.rootVersion}
                  />
                  <input
                    name="expectedTimesheetVersionId"
                    type="hidden"
                    value={state.detail.currentVersion.timesheetVersionId}
                  />
                  <input
                    name="expectedVersion"
                    type="hidden"
                    value={state.detail.currentVersion.rowVersion}
                  />
                  <input name="returnTo" type="hidden" value={fromMyWork ? "my-work" : "detail"} />
                  <div className="form-field">
                    <label htmlFor="timesheet-rejection-note">Rejection note</label>
                    <textarea
                      aria-describedby="timesheet-rejection-note-hint"
                      id="timesheet-rejection-note"
                      maxLength={2000}
                      name="decisionNote"
                    />
                    <p className="field-hint" id="timesheet-rejection-note-hint">
                      Required only when the tenant setting is enabled.
                    </p>
                  </div>
                  <button className="command-button command-button-danger" type="submit">
                    Reject Timesheet
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}
