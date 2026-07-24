import { loadOwnAttendance } from "../../../../lib/hr-attendance";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function displayInstant(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export default async function OwnAttendancePage({ searchParams }: Props) {
  const parameters = await searchParams;
  const state = await loadOwnAttendance(parameters);
  return (
    <section aria-labelledby="attendance-heading" className="work-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Attendance</p>
          <h1 id="attendance-heading">My attendance</h1>
          <p className="surface-summary">
            Review recorded presence facts and their persistent correction history.
          </p>
        </div>
      </header>
      <form className="leave-request-form" method="get">
        <div className="form-grid-two">
          <div className="form-field">
            <label htmlFor="attendance-from">From date</label>
            <input
              defaultValue={one(parameters.from)}
              id="attendance-from"
              name="from"
              type="date"
            />
          </div>
          <div className="form-field">
            <label htmlFor="attendance-to">Through date</label>
            <input defaultValue={one(parameters.to)} id="attendance-to" name="to" type="date" />
          </div>
        </div>
        <button className="command-button command-button-primary" type="submit">
          Apply period
        </button>
      </form>
      {state.status === "error" ? (
        <div className="form-error-summary" role="alert">
          <h2>{state.title}</h2>
          <p>{state.message}</p>
        </div>
      ) : state.page.items.length === 0 ? (
        <section aria-labelledby="attendance-empty" className="empty-worklist">
          <h2 id="attendance-empty">No attendance facts in this period</h2>
          <p>Recorded presence facts will appear here.</p>
        </section>
      ) : (
        <>
          <ol aria-label="My attendance facts" className="work-queue">
            {state.page.items.map((observation) => (
              <li className="work-queue-item" key={observation.attendanceObservationId}>
                <div className="work-queue-primary">
                  <div>
                    <p className="work-queue-kicker">{observation.sourceKind}</p>
                    <h2>{displayInstant(observation.observedAt)}</h2>
                    <p className="work-queue-dates">{observation.observationKind}</p>
                  </div>
                </div>
                <a
                  className="text-command"
                  href={`/workspace/hr/attendance/by-id/${observation.attendanceObservationId}?returnTo=own`}
                >
                  View correction history
                </a>
              </li>
            ))}
          </ol>
          {state.page.nextCursor ? (
            <a
              className="text-command"
              href={`?${new URLSearchParams({
                ...(one(parameters.from) ? { from: one(parameters.from) as string } : {}),
                ...(one(parameters.to) ? { to: one(parameters.to) as string } : {}),
                cursorAttendanceObservationId: state.page.nextCursor.attendanceObservationId,
                cursorObservedAt: state.page.nextCursor.observedAt,
              })}`}
            >
              Next attendance page
            </a>
          ) : null}
        </>
      )}
    </section>
  );
}
