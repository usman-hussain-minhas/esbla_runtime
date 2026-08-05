import Link from "next/link";
import { loadOwnAttendance } from "../../../../lib/hr-attendance";
import {
  buildNestedRouteBackedWidgetHref,
  type RouteBackedWidgetOrigin,
} from "../../../../lib/route-backed-widget-navigation-core";
import { RouteBackedWidgetGetForm } from "../../../../theme/zen-theme/v1/route-backed-widget-overlay";

interface Props {
  readonly focusOrigin?: RouteBackedWidgetOrigin;
  readonly mode?: "focus-master" | "standalone";
  readonly preloadedState?: Awaited<ReturnType<typeof loadOwnAttendance>>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function attendanceDetailHref(
  attendanceObservationId: string,
  parameters: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams({ returnTo: "own" });
  const from = one(parameters.from);
  const to = one(parameters.to);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  return `/workspace/hr/attendance/by-id/${attendanceObservationId}?${query}`;
}
function displayInstant(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export default async function OwnAttendancePage({
  focusOrigin,
  mode = "standalone",
  preloadedState,
  searchParams,
}: Props) {
  const parameters = await searchParams;
  const state = preloadedState ?? (await loadOwnAttendance(parameters));
  return (
    <section aria-labelledby="attendance-heading" className="work-surface">
      {mode === "standalone" ? (
        <a className="text-command detail-back" href="/workspace/hr">
          Back to HR
        </a>
      ) : null}
      <header className="surface-heading">
        <div>
          <p className="surface-label">Attendance</p>
          <h1 id="attendance-heading">My attendance</h1>
          <p className="surface-summary">
            Review recorded presence facts and their persistent correction history.
          </p>
        </div>
      </header>
      <RouteBackedWidgetGetForm
        action="/workspace/hr/attendance"
        className="leave-request-form"
        focusOrigin={focusOrigin}
      >
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
      </RouteBackedWidgetGetForm>
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
                <Link
                  className="text-command"
                  href={
                    focusOrigin
                      ? buildNestedRouteBackedWidgetHref(
                          attendanceDetailHref(observation.attendanceObservationId, parameters),
                          focusOrigin,
                        )
                      : attendanceDetailHref(observation.attendanceObservationId, parameters)
                  }
                >
                  View correction history
                </Link>
              </li>
            ))}
          </ol>
          {state.page.nextCursor ? (
            <Link
              className="text-command"
              href={(() => {
                const href = `/workspace/hr/attendance?${new URLSearchParams({
                  ...(one(parameters.from) ? { from: one(parameters.from) as string } : {}),
                  ...(one(parameters.to) ? { to: one(parameters.to) as string } : {}),
                  cursorAttendanceObservationId: state.page.nextCursor.attendanceObservationId,
                  cursorObservedAt: state.page.nextCursor.observedAt,
                })}`;
                return focusOrigin ? buildNestedRouteBackedWidgetHref(href, focusOrigin) : href;
              })()}
            >
              Next attendance page
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}
