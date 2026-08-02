import { randomUUID } from "node:crypto";
import Link from "next/link";
import { loadReportAttendance } from "../../../../../lib/hr-attendance";
import { canRenderAttendanceAction } from "../../../../../lib/hr-attendance-core";
import {
  buildNestedRouteBackedWidgetHref,
  getRouteBackedWidgetOriginParameters,
  type RouteBackedWidgetOrigin,
} from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetGetForm,
  RouteBackedWidgetPostForm,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";

interface Props {
  readonly focusOrigin?: RouteBackedWidgetOrigin;
  readonly mode?: "focus-master" | "standalone";
  readonly preloadedState?: Awaited<ReturnType<typeof loadReportAttendance>>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function attendanceDetailHref(
  attendanceObservationId: string,
  parameters: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams({ returnTo: "reports" });
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

export default async function ReportAttendancePage({
  focusOrigin,
  mode = "standalone",
  preloadedState,
  searchParams,
}: Props) {
  const parameters = await searchParams;
  const state = preloadedState ?? (await loadReportAttendance(parameters));
  const encodedOrigin = focusOrigin ? getRouteBackedWidgetOriginParameters(focusOrigin) : undefined;
  const canRecord = canRenderAttendanceAction(
    state.authorizedActions,
    state.status,
    "record_manual",
  );
  return (
    <section aria-labelledby="attendance-reports-heading" className="work-surface">
      {mode === "standalone" ? (
        <a className="text-command detail-back" href="/workspace/hr">
          Back to HR
        </a>
      ) : null}
      <header className="surface-heading">
        <div>
          <p className="surface-label">Attendance</p>
          <h1 id="attendance-reports-heading">Report attendance</h1>
          <p className="surface-summary">
            Managers see current reports. HR operators see authorized tenant Attendance facts.
          </p>
        </div>
      </header>
      {one(parameters.result) ? (
        <div className="form-error-summary" id="attendance-result" role="alert" tabIndex={-1}>
          <p>The Attendance action was not confirmed. Review current values and try again.</p>
        </div>
      ) : null}
      {canRecord ? (
        <RouteBackedWidgetPostForm
          action="/workspace/hr/attendance/action"
          className="leave-request-form"
        >
          <h2>Record a manual attendance fact</h2>
          {encodedOrigin ? (
            <>
              <input name="originFocusId" type="hidden" value={encodedOrigin.originFocusId} />
              <input name="returnSurface" type="hidden" value={encodedOrigin.returnSurface} />
              <input name="returnTo" type="hidden" value="reports" />
              {one(parameters.from) ? (
                <input name="from" type="hidden" value={one(parameters.from)} />
              ) : null}
              {one(parameters.to) ? (
                <input name="to" type="hidden" value={one(parameters.to)} />
              ) : null}
            </>
          ) : null}
          <input name="idempotencyKey" type="hidden" value={randomUUID()} />
          <input name="operation" type="hidden" value="record_manual" />
          <div className="form-field">
            <label htmlFor="attendance-worker">Worker profile ID</label>
            <input id="attendance-worker" name="workerProfileId" required type="text" />
          </div>
          <div className="form-field">
            <label htmlFor="attendance-kind">Observation</label>
            <select defaultValue="presence_start" id="attendance-kind" name="observationKind">
              <option value="presence_start">Presence start</option>
              <option value="presence_end">Presence end</option>
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="attendance-observed-at">Observed instant</label>
            <input
              aria-describedby="attendance-instant-help"
              id="attendance-observed-at"
              name="observedAt"
              placeholder="2026-07-24T08:30:00.000Z"
              required
              type="text"
            />
            <p className="field-help" id="attendance-instant-help">
              Enter an ISO 8601 instant with timezone.
            </p>
          </div>
          <button className="command-button command-button-primary" type="submit">
            Record attendance
          </button>
        </RouteBackedWidgetPostForm>
      ) : null}
      <RouteBackedWidgetGetForm
        action="/workspace/hr/attendance/reports"
        className="leave-request-form"
      >
        {encodedOrigin ? (
          <>
            <input name="originFocusId" type="hidden" value={encodedOrigin.originFocusId} />
            <input name="returnSurface" type="hidden" value={encodedOrigin.returnSurface} />
          </>
        ) : null}
        <div className="form-grid-two">
          <div className="form-field">
            <label htmlFor="attendance-report-from">From date</label>
            <input
              defaultValue={one(parameters.from)}
              id="attendance-report-from"
              name="from"
              type="date"
            />
          </div>
          <div className="form-field">
            <label htmlFor="attendance-report-to">Through date</label>
            <input
              defaultValue={one(parameters.to)}
              id="attendance-report-to"
              name="to"
              type="date"
            />
          </div>
        </div>
        <button className="command-button" type="submit">
          Apply period
        </button>
      </RouteBackedWidgetGetForm>
      {state.status === "error" ? (
        <div className="form-error-summary" role="alert">
          <h2>{state.title}</h2>
          <p>{state.message}</p>
        </div>
      ) : state.page.items.length === 0 ? (
        <section aria-labelledby="attendance-reports-empty" className="empty-worklist">
          <h2 id="attendance-reports-empty">No report attendance in this period</h2>
          <p>Only Attendance facts in your current authorized scope appear here.</p>
        </section>
      ) : (
        <>
          <ol aria-label="Authorized report attendance" className="work-queue">
            {state.page.items.map((observation) => (
              <li className="work-queue-item" key={observation.attendanceObservationId}>
                <div className="work-queue-primary">
                  <div>
                    <p className="work-queue-kicker">{observation.observationKind}</p>
                    <h2>{displayInstant(observation.observedAt)}</h2>
                    <p className="work-queue-dates">{observation.workerProfileId}</p>
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
                const href = `/workspace/hr/attendance/reports?${new URLSearchParams({
                  ...(one(parameters.from) ? { from: one(parameters.from) as string } : {}),
                  ...(one(parameters.to) ? { to: one(parameters.to) as string } : {}),
                  cursorAttendanceObservationId: state.page.nextCursor.attendanceObservationId,
                  cursorObservedAt: state.page.nextCursor.observedAt,
                })}`;
                return focusOrigin ? buildNestedRouteBackedWidgetHref(href, focusOrigin) : href;
              })()}
            >
              Next report page
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}
