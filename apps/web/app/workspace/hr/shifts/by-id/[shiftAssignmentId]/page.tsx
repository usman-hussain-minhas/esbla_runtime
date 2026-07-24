import { loadShiftDetail } from "../../../../../../lib/hr-shift-assignment";

interface Props {
  readonly params: Promise<{ shiftAssignmentId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export default async function ShiftDetailPage({ params, searchParams }: Props) {
  const [{ shiftAssignmentId }, query] = await Promise.all([params, searchParams]);
  const state = await loadShiftDetail(shiftAssignmentId);
  const back =
    one(query.returnTo) === "own"
      ? "/workspace/hr/shifts"
      : one(query.returnTo) === "reports" && one(query.rosterVersionId)
        ? `/workspace/hr/shifts/reports?rosterVersionId=${encodeURIComponent(one(query.rosterVersionId) as string)}&status=active`
        : "/workspace/hr";
  return (
    <section aria-labelledby="shift-detail-heading" className="work-surface leave-form-surface">
      <a className="text-command detail-back" href={back}>
        Back to shifts
      </a>
      <header className="surface-heading">
        <h1 id="shift-detail-heading">Shift assignment</h1>
      </header>
      {one(query.result) && one(query.result) !== "success" ? (
        <div className="form-error-summary" id="shift-result" role="alert" tabIndex={-1}>
          <p>The requested Shift action is not confirmed. Review current values and try again.</p>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="form-error-summary" role="alert">
          <h2>{state.title}</h2>
          <p>{state.message}</p>
        </div>
      ) : (
        <div className="leave-detail-layout">
          <section className="leave-detail-section">
            <h2>Current assignment</h2>
            <dl className="leave-detail-facts">
              {Object.entries({
                Ends: state.detail.assignment.endsAt,
                "IANA timezone": state.detail.assignment.ianaTimezone,
                Starts: state.detail.assignment.startsAt,
                Status: state.detail.assignment.status,
                "Worker Profile ID": state.detail.assignment.workerProfileId,
              }).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="shift-history-heading" className="leave-detail-section">
            <h2 id="shift-history-heading">Evidence history</h2>
            <ol className="history-list">
              {state.detail.history.map((event) => (
                <li key={`${event.eventType}-${event.occurredAt}`}>
                  <strong>{event.newState}</strong>
                  <span>{event.occurredAt}</span>
                  <p>{event.eventType}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </section>
  );
}
