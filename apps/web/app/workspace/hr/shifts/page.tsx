import { loadOwnShifts } from "../../../../lib/hr-shift-assignment";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function localTime(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default async function OwnShiftsPage({ searchParams }: Props) {
  const parameters = await searchParams;
  const state = await loadOwnShifts(parameters);
  return (
    <section aria-labelledby="own-shifts-heading" className="work-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <h1 id="own-shifts-heading">My shifts</h1>
      </header>
      {one(parameters.result) && one(parameters.result) !== "success" ? (
        <div className="form-error-summary" id="shift-result" role="alert" tabIndex={-1}>
          <p>The requested Shift action is not confirmed. Review current values and try again.</p>
        </div>
      ) : null}
      <form className="leave-request-form" method="get">
        <div className="form-grid-two">
          <div className="form-field">
            <label htmlFor="shift-from">From date</label>
            <input defaultValue={one(parameters.from)} id="shift-from" name="from" type="date" />
          </div>
          <div className="form-field">
            <label htmlFor="shift-to">Through date</label>
            <input defaultValue={one(parameters.to)} id="shift-to" name="to" type="date" />
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
        <div className="empty-worklist">
          <h2>No published shifts in this period</h2>
        </div>
      ) : (
        <ol aria-label="My published shifts" className="work-queue">
          {state.page.items.map((shift) => (
            <li className="work-queue-item" key={shift.shiftAssignmentId}>
              <div className="work-queue-primary">
                <div>
                  <p className="work-queue-kicker">{shift.status}</p>
                  <h2>{localTime(shift.startsAt, shift.ianaTimezone)}</h2>
                  <p className="work-queue-dates">
                    Until {localTime(shift.endsAt, shift.ianaTimezone)}
                  </p>
                </div>
                <span className="leave-status">{shift.ianaTimezone}</span>
              </div>
              <a
                className="text-command"
                href={`/workspace/hr/shifts/by-id/${shift.shiftAssignmentId}?returnTo=own`}
              >
                View persistent history
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
