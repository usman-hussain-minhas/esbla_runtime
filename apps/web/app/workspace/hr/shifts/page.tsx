import Link from "next/link";
import { loadOwnShifts } from "../../../../lib/hr-shift-assignment";
import {
  buildNestedRouteBackedWidgetHref,
  getRouteBackedWidgetOriginParameters,
  type RouteBackedWidgetOrigin,
} from "../../../../lib/route-backed-widget-navigation-core";
import { RouteBackedWidgetGetForm } from "../../../../theme/zen-theme/v1/route-backed-widget-overlay";

interface Props {
  readonly focusOrigin?: RouteBackedWidgetOrigin;
  readonly mode?: "focus-master" | "standalone";
  readonly preloadedState?: Awaited<ReturnType<typeof loadOwnShifts>>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function shiftDetailHref(
  shiftAssignmentId: string,
  parameters: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams({ returnTo: "own" });
  const from = one(parameters.from);
  const to = one(parameters.to);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  return `/workspace/hr/shifts/by-id/${shiftAssignmentId}?${query}`;
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

export default async function OwnShiftsPage({
  focusOrigin,
  mode = "standalone",
  preloadedState,
  searchParams,
}: Props) {
  const parameters = await searchParams;
  const state = preloadedState ?? (await loadOwnShifts(parameters));
  const encodedOrigin = focusOrigin ? getRouteBackedWidgetOriginParameters(focusOrigin) : undefined;
  return (
    <section aria-labelledby="own-shifts-heading" className="work-surface">
      {mode === "standalone" ? (
        <a className="text-command detail-back" href="/workspace/hr">
          Back to HR
        </a>
      ) : null}
      <header className="surface-heading">
        <h1 id="own-shifts-heading">My shifts</h1>
      </header>
      {one(parameters.result) && one(parameters.result) !== "success" ? (
        <div className="form-error-summary" id="shift-result" role="alert" tabIndex={-1}>
          <p>The requested Shift action is not confirmed. Review current values and try again.</p>
        </div>
      ) : null}
      <RouteBackedWidgetGetForm action="/workspace/hr/shifts" className="leave-request-form">
        {encodedOrigin ? (
          <>
            <input name="originFocusId" type="hidden" value={encodedOrigin.originFocusId} />
            <input name="returnSurface" type="hidden" value={encodedOrigin.returnSurface} />
          </>
        ) : null}
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
      </RouteBackedWidgetGetForm>
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
              <Link
                className="text-command"
                href={
                  focusOrigin
                    ? buildNestedRouteBackedWidgetHref(
                        shiftDetailHref(shift.shiftAssignmentId, parameters),
                        focusOrigin,
                      )
                    : shiftDetailHref(shift.shiftAssignmentId, parameters)
                }
              >
                View persistent history
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
