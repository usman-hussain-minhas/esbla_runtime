import { randomUUID } from "node:crypto";
import { HR_TIMESHEET_DRAFT_WIDGET_DEFINITION } from "@esbla/contracts";
import { loadOwnTimesheets, loadTimesheetDetail } from "../../../../lib/hr-timesheet";
import { hasTimesheetAction } from "../../../../lib/hr-timesheet-core";
import { TimesheetResult } from "./result";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
const resultCopy = {
  conflict: "Timesheet changed. Reloaded values are shown.",
  current: "Current persistent Timesheet state is shown.",
  denied: "Your current role does not permit that Timesheet action.",
  dependency_unavailable: "A required Timesheet dependency is unavailable.",
  inactive: "Timesheet is inactive. Existing history remains preserved.",
  not_found: "The selected Timesheet is not available.",
  operational_error: "The Timesheet action was not confirmed. Review current values.",
  validation: "Review the weekly period, entries, and expected versions.",
} as const;
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function status(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
function minutes(value: number): string {
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return `${hours}h ${remainder}m`;
}

export default async function TimesheetsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const selectedId = one(parameters.edit);
  const listPromise = loadOwnTimesheets(parameters);
  const detailPromise = selectedId ? loadTimesheetDetail(selectedId) : Promise.resolve(null);
  const [state, selected] = await Promise.all([listPromise, detailPromise]);
  const result = one(parameters.result);
  const resultIsTruthful =
    result !== "current" ||
    (state.status === "success" && (!selectedId || selected?.status === "success"));
  const canCreate = hasTimesheetAction(state.authorizedActions, "create");
  const detail = selected?.status === "success" ? selected.detail : null;
  const canEdit =
    detail?.accessScope === "own" &&
    detail.currentVersion.status === "draft" &&
    hasTimesheetAction(selected?.authorizedActions ?? [], "edit_draft");
  const canSubmit =
    detail?.accessScope === "own" &&
    detail.currentVersion.status === "draft" &&
    hasTimesheetAction(selected?.authorizedActions ?? [], "submit");

  return (
    <section aria-labelledby="timesheets-heading" className="work-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Timesheet</p>
          <h1 id="timesheets-heading">My Timesheets</h1>
          <p className="surface-summary">
            Record bounded weekly work-time facts without Project, billing, invoicing, or payroll
            meaning.
          </p>
        </div>
      </header>
      {result && Object.hasOwn(resultCopy, result) && resultIsTruthful ? (
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
        <>
          {canCreate ? (
            <section
              aria-labelledby="timesheet-draft-form-heading"
              data-widget-definition={HR_TIMESHEET_DRAFT_WIDGET_DEFINITION.id}
              data-widget-definition-version={
                HR_TIMESHEET_DRAFT_WIDGET_DEFINITION.definitionVersion
              }
            >
              <form
                action="/workspace/hr/timesheets/action"
                className="leave-request-form"
                method="post"
              >
                <h2 id="timesheet-draft-form-heading">Create a weekly draft</h2>
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                <input name="operation" type="hidden" value="create" />
                <div className="form-grid-two">
                  <div className="form-field">
                    <label htmlFor="timesheet-period-start">Period starts</label>
                    <input id="timesheet-period-start" name="periodStart" required type="date" />
                  </div>
                  <div className="form-field">
                    <label htmlFor="timesheet-period-end">Period ends</label>
                    <input id="timesheet-period-end" name="periodEnd" required type="date" />
                  </div>
                </div>
                <p className="field-hint">
                  The current ratified cadence is weekly: exactly seven inclusive dates. Current
                  tenant daily-minute limits are enforced when entries are saved.
                </p>
                <button className="command-button command-button-primary" type="submit">
                  Create Timesheet draft
                </button>
              </form>
            </section>
          ) : null}

          {selected ? (
            selected.status === "error" ? (
              <div className="form-error-summary" role="alert">
                <h2>{selected.title}</h2>
                <p>{selected.message}</p>
              </div>
            ) : (
              <section aria-labelledby="timesheet-edit-heading" className="leave-detail-section">
                <h2 id="timesheet-edit-heading">Selected weekly Timesheet</h2>
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Period</dt>
                    <dd>
                      {detail?.periodStart} to {detail?.periodEnd}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{status(detail?.currentVersion.status ?? "")}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>{minutes(detail?.currentVersion.totalMinutes ?? 0)}</dd>
                  </div>
                </dl>
                {canEdit && detail ? (
                  <form
                    action="/workspace/hr/timesheets/action"
                    className="leave-request-form"
                    method="post"
                  >
                    <h3>Edit work-time entries</h3>
                    <input name="operation" type="hidden" value="edit_draft" />
                    <input name="timesheetId" type="hidden" value={detail.timesheetId} />
                    <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                    <input name="expectedRootVersion" type="hidden" value={detail.rootVersion} />
                    <input
                      name="expectedTimesheetVersionId"
                      type="hidden"
                      value={detail.currentVersion.timesheetVersionId}
                    />
                    <input
                      name="expectedVersion"
                      type="hidden"
                      value={detail.currentVersion.rowVersion}
                    />
                    {Array.from({
                      length: Math.max(7, detail.currentVersion.entries.length),
                    }).map((_, index) => {
                      const entry = detail.currentVersion.entries[index];
                      return (
                        <fieldset
                          className="leave-request-form"
                          key={entry?.timesheetEntryId ?? index}
                        >
                          <legend>Entry {index + 1}</legend>
                          {entry ? (
                            <>
                              <input
                                name={`entryId_${index}`}
                                type="hidden"
                                value={entry.timesheetEntryId}
                              />
                              <input
                                name={`entryVersion_${index}`}
                                type="hidden"
                                value={entry.version}
                              />
                            </>
                          ) : null}
                          <div className="form-grid-two">
                            <div className="form-field">
                              <label htmlFor={`timesheet-entry-date-${index}`}>Work date</label>
                              <input
                                defaultValue={entry?.entryDate}
                                id={`timesheet-entry-date-${index}`}
                                max={detail.periodEnd}
                                min={detail.periodStart}
                                name={`entryDate_${index}`}
                                type="date"
                              />
                            </div>
                            <div className="form-field">
                              <label htmlFor={`timesheet-entry-minutes-${index}`}>Minutes</label>
                              <input
                                defaultValue={entry?.minutes}
                                id={`timesheet-entry-minutes-${index}`}
                                max="1440"
                                min="1"
                                name={`entryMinutes_${index}`}
                                type="number"
                              />
                            </div>
                          </div>
                          <div className="form-field">
                            <label htmlFor={`timesheet-entry-description-${index}`}>
                              Description
                            </label>
                            <input
                              defaultValue={entry?.description ?? ""}
                              id={`timesheet-entry-description-${index}`}
                              maxLength={500}
                              name={`entryDescription_${index}`}
                              type="text"
                            />
                          </div>
                        </fieldset>
                      );
                    })}
                    <button className="command-button command-button-primary" type="submit">
                      Save Timesheet draft
                    </button>
                  </form>
                ) : null}
                {canSubmit && detail ? (
                  <form action="/workspace/hr/timesheets/action" method="post">
                    <input name="operation" type="hidden" value="submit" />
                    <input name="timesheetId" type="hidden" value={detail.timesheetId} />
                    <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                    <input name="expectedRootVersion" type="hidden" value={detail.rootVersion} />
                    <input
                      name="expectedTimesheetVersionId"
                      type="hidden"
                      value={detail.currentVersion.timesheetVersionId}
                    />
                    <input
                      name="expectedVersion"
                      type="hidden"
                      value={detail.currentVersion.rowVersion}
                    />
                    <button className="command-button command-button-primary" type="submit">
                      Submit Timesheet
                    </button>
                  </form>
                ) : null}
              </section>
            )
          ) : null}

          {state.page.items.length === 0 ? (
            <section className="empty-worklist">
              <h2>No Timesheets yet</h2>
              <p>Your weekly Timesheet periods will appear here.</p>
            </section>
          ) : (
            <ol aria-label="My Timesheets" className="work-queue">
              {state.page.items.map((item) => (
                <li className="work-queue-item" key={item.timesheetId}>
                  <div className="work-queue-primary">
                    <div>
                      <p className="work-queue-kicker">{status(item.status)}</p>
                      <h2>
                        {item.periodStart} to {item.periodEnd}
                      </h2>
                      <p className="work-queue-dates">{minutes(item.totalMinutes)}</p>
                    </div>
                  </div>
                  <div className="work-queue-actions">
                    {item.status === "draft" &&
                    hasTimesheetAction(state.authorizedActions, "edit_draft") ? (
                      <a className="text-command" href={`?edit=${item.timesheetId}`}>
                        Edit draft
                      </a>
                    ) : null}
                    <a
                      className="text-command"
                      href={`/workspace/hr/timesheets/by-id/${item.timesheetId}?returnTo=own`}
                    >
                      View status and history
                    </a>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {state.page.nextCursor ? (
            <a
              className="text-command"
              href={`?${new URLSearchParams({
                cursorPeriodStart: state.page.nextCursor.periodStart,
                cursorTimesheetId: state.page.nextCursor.timesheetId,
              })}`}
            >
              Next Timesheet page
            </a>
          ) : null}
        </>
      )}
    </section>
  );
}
