import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { loadOwnTimesheets } from "../../../../../../lib/hr-timesheet";
import {
  buildTimesheetCorrectionDetailHref,
  hasTimesheetAction,
  TimesheetUiError,
  timesheetStateForError,
} from "../../../../../../lib/hr-timesheet-core";
import {
  buildNestedRouteBackedWidgetHref,
  getRouteBackedWidgetOriginParameters,
  type RouteBackedWidgetOrigin,
} from "../../../../../../lib/route-backed-widget-navigation-core";
import { RouteBackedWidgetGetForm } from "../../../../../../theme/zen-theme/v1/route-backed-widget-overlay";

interface TimesheetCorrectionsPageProps {
  readonly focusOrigin?: RouteBackedWidgetOrigin | undefined;
  readonly mode?: "focus" | "standalone" | undefined;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function CorrectionLookupForm({
  children,
  focusOrigin,
}: Readonly<{ children: ReactNode; focusOrigin?: RouteBackedWidgetOrigin | undefined }>) {
  if (!focusOrigin)
    return (
      <form className="leave-request-form" method="get">
        {children}
      </form>
    );
  const origin = getRouteBackedWidgetOriginParameters(focusOrigin);
  return (
    <RouteBackedWidgetGetForm
      action="/workspace/hr/timesheets/admin/corrections"
      className="leave-request-form"
    >
      <input name="originFocusId" type="hidden" value={origin.originFocusId} />
      <input name="returnSurface" type="hidden" value={origin.returnSurface} />
      {children}
    </RouteBackedWidgetGetForm>
  );
}

export default async function TimesheetCorrectionsPage({
  focusOrigin,
  mode = "standalone",
  searchParams,
}: TimesheetCorrectionsPageProps) {
  const [parameters, state] = await Promise.all([searchParams, loadOwnTimesheets()]);
  const serviceAvailable =
    state.status === "success" || (state.status === "error" && state.kind === "denied");
  const canCreateCorrection =
    serviceAvailable && hasTimesheetAction(state.authorizedActions, "create_correction");
  let correctionHref: string | null = null;
  let lookupInvalid = false;
  if (Object.hasOwn(parameters, "timesheetId") && canCreateCorrection) {
    try {
      correctionHref = buildTimesheetCorrectionDetailHref(parameters.timesheetId);
    } catch {
      lookupInvalid = true;
    }
  }
  if (correctionHref)
    redirect(
      focusOrigin ? buildNestedRouteBackedWidgetHref(correctionHref, focusOrigin) : correctionHref,
    );
  const unavailable =
    state.status === "error" && state.kind !== "denied"
      ? state
      : timesheetStateForError(new TimesheetUiError("denied", 403));

  return (
    <section aria-labelledby="timesheet-corrections-heading" className="work-surface">
      {mode === "standalone" ? (
        <a className="text-command detail-back" href="/workspace/hr">
          Back to HR
        </a>
      ) : null}
      <header className="surface-heading">
        <div>
          <p className="surface-label">Timesheet</p>
          <h1 id="timesheet-corrections-heading">Timesheet corrections</h1>
          <p className="surface-summary">
            Authorized HR operators can open one exact Timesheet and create its sole correction
            successor after approval or rejection.
          </p>
        </div>
      </header>
      {lookupInvalid ? (
        <div className="form-error-summary" id="timesheet-lookup-result" role="alert" tabIndex={-1}>
          <h2>Review Timesheet ID</h2>
          <p>Enter one complete Timesheet ID in UUID format.</p>
        </div>
      ) : null}
      {canCreateCorrection ? (
        <CorrectionLookupForm focusOrigin={focusOrigin}>
          <div className="form-field">
            <label htmlFor="timesheet-correction-id">Timesheet ID</label>
            <input
              aria-describedby="timesheet-correction-id-help"
              autoComplete="off"
              id="timesheet-correction-id"
              maxLength={36}
              minLength={36}
              name="timesheetId"
              pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
              required
              spellCheck={false}
              type="text"
            />
            <p className="field-hint" id="timesheet-correction-id-help">
              The exact identifier is required; this surface does not expose a tenant-wide Timesheet
              list.
            </p>
          </div>
          <button className="command-button command-button-primary" type="submit">
            Open Timesheet
          </button>
        </CorrectionLookupForm>
      ) : (
        <div className="form-error-summary" role="alert">
          <h2>{unavailable.title}</h2>
          <p>{unavailable.message}</p>
        </div>
      )}
    </section>
  );
}
