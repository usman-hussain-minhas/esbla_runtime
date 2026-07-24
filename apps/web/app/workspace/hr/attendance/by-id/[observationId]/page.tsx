import { randomUUID } from "node:crypto";
import { loadAttendanceDetail } from "../../../../../../lib/hr-attendance";
import { hasAttendanceAction } from "../../../../../../lib/hr-attendance-core";

interface Props {
  readonly params: Promise<{ observationId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function displayInstant(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "long" }).format(
    new Date(value),
  );
}

export default async function AttendanceDetailPage({ params, searchParams }: Props) {
  const [{ observationId }, parameters] = await Promise.all([params, searchParams]);
  const state = await loadAttendanceDetail(observationId, parameters);
  const back =
    one(parameters.returnTo) === "reports"
      ? "/workspace/hr/attendance/reports"
      : "/workspace/hr/attendance";
  const currentHistoryPage =
    one(parameters.cursorAttendanceCorrectionId) === undefined &&
    one(parameters.cursorCorrectionVersion) === undefined;
  return (
    <section aria-labelledby="attendance-detail-heading" className="work-surface">
      <a className="text-command detail-back" href={back}>
        Back to attendance
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Attendance</p>
          <h1 id="attendance-detail-heading">Attendance detail</h1>
          <p className="surface-summary">
            The original fact remains immutable. Corrections are appended as persistent history.
          </p>
        </div>
      </header>
      {one(parameters.result) ? (
        <div className="form-error-summary" id="attendance-result" role="alert" tabIndex={-1}>
          <p>The correction was not confirmed. Review current history and try again.</p>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="form-error-summary" role="alert">
          <h2>{state.title}</h2>
          <p>{state.message}</p>
        </div>
      ) : (
        <>
          <dl className="detail-facts">
            <div>
              <dt>Worker profile</dt>
              <dd>{state.detail.workerProfileId}</dd>
            </div>
            <div>
              <dt>Original observation</dt>
              <dd>{state.detail.observationKind}</dd>
            </div>
            <div>
              <dt>Original instant</dt>
              <dd>{displayInstant(state.detail.observedAt)}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{state.detail.sourceKind}</dd>
            </div>
          </dl>
          {currentHistoryPage && hasAttendanceAction(state.authorizedActions, "correct") ? (
            <form
              action="/workspace/hr/attendance/action"
              className="leave-request-form"
              method="post"
            >
              <h2>Append a correction</h2>
              <input name="idempotencyKey" type="hidden" value={randomUUID()} />
              <input
                name="observationId"
                type="hidden"
                value={state.detail.attendanceObservationId}
              />
              <input name="operation" type="hidden" value="correct" />
              <input
                name="expectedCurrentCorrectionId"
                type="hidden"
                value={state.detail.corrections.items.at(0)?.attendanceCorrectionId ?? ""}
              />
              <input
                name="expectedCurrentCorrectionVersion"
                type="hidden"
                value={state.detail.corrections.items.at(0)?.version ?? ""}
              />
              <div className="form-field">
                <label htmlFor="attendance-correction-kind">Corrected observation</label>
                <select
                  defaultValue={state.detail.observationKind}
                  id="attendance-correction-kind"
                  name="correctedObservationKind"
                >
                  <option value="presence_start">Presence start</option>
                  <option value="presence_end">Presence end</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="attendance-corrected-at">Corrected instant</label>
                <input
                  id="attendance-corrected-at"
                  name="correctedObservedAt"
                  placeholder="2026-07-24T09:00:00.000Z"
                  required
                  type="text"
                />
              </div>
              <div className="form-field">
                <label htmlFor="attendance-correction-reason">Reason</label>
                <textarea
                  id="attendance-correction-reason"
                  maxLength={2000}
                  name="reason"
                  required
                />
              </div>
              <button className="command-button command-button-primary" type="submit">
                Append correction
              </button>
            </form>
          ) : null}
          <section aria-labelledby="attendance-corrections-heading">
            <h2 id="attendance-corrections-heading">Correction history</h2>
            {state.detail.corrections.items.length === 0 ? (
              <div className="empty-worklist">
                <p>No corrections have been appended.</p>
              </div>
            ) : (
              <ol className="work-queue">
                {state.detail.corrections.items.map((correction) => (
                  <li className="work-queue-item" key={correction.attendanceCorrectionId}>
                    <div>
                      <p className="work-queue-kicker">Version {correction.version}</p>
                      <h3>{correction.correctedObservationKind}</h3>
                      <p>{displayInstant(correction.correctedObservedAt)}</p>
                      <p>{correction.reason}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {state.detail.corrections.nextCursor ? (
              <a
                className="text-command"
                href={`?${new URLSearchParams({
                  ...(one(parameters.returnTo)
                    ? { returnTo: one(parameters.returnTo) as string }
                    : {}),
                  cursorAttendanceCorrectionId:
                    state.detail.corrections.nextCursor.attendanceCorrectionId,
                  cursorCorrectionVersion: String(state.detail.corrections.nextCursor.version),
                })}`}
              >
                Older corrections
              </a>
            ) : null}
          </section>
        </>
      )}
    </section>
  );
}
