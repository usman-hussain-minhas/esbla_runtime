import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import Link from "next/link";
import {
  loadRosterShifts,
  readShiftMutationReceipt,
  SHIFT_MUTATION_RECEIPT_COOKIE,
} from "../../../../../lib/hr-shift-assignment";
import { hasShiftAction } from "../../../../../lib/hr-shift-assignment-core";
import {
  buildNestedRouteBackedWidgetHref,
  type RouteBackedWidgetOrigin,
} from "../../../../../lib/route-backed-widget-navigation-core";
import {
  RouteBackedWidgetGetForm,
  RouteBackedWidgetPostForm,
} from "../../../../../theme/zen-theme/v1/route-backed-widget-overlay";

interface Props {
  readonly focusOrigin?: RouteBackedWidgetOrigin;
  readonly mode?: "focus-master" | "standalone";
  readonly preloadedState?: Awaited<ReturnType<typeof loadRosterShifts>>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
const discoveryRoster = "00000000-0000-4000-8000-000000000000";
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function reportShiftDetailHref(
  shiftAssignmentId: string,
  rosterVersionId: string,
  status: string,
): string {
  return `/workspace/hr/shifts/by-id/${shiftAssignmentId}?${new URLSearchParams({
    returnTo: "reports",
    rosterVersionId,
    status,
  })}`;
}

export default async function ReportShiftsPage({
  focusOrigin,
  mode = "standalone",
  preloadedState,
  searchParams,
}: Props) {
  const [parameters, cookieStore] = await Promise.all([searchParams, cookies()]);
  const rosterVersionId = one(parameters.rosterVersionId);
  const state =
    preloadedState ??
    (await loadRosterShifts({
      rosterVersionId: rosterVersionId ?? discoveryRoster,
      status: one(parameters.status) ?? "active",
    }));
  const actions = state.authorizedActions;
  const actionable =
    state.status === "success" || state.kind === "denied" || state.kind === "not_found";
  const canCreate = actionable && hasShiftAction(actions, "create_roster");
  const canAssign = actionable && hasShiftAction(actions, "assign");
  const canPublish = actionable && hasShiftAction(actions, "publish");
  const canCancel = actionable && hasShiftAction(actions, "cancel");
  const rosterVersion = one(parameters.rosterVersion);
  const receipt =
    one(parameters.result) === "success"
      ? readShiftMutationReceipt(cookieStore.get(SHIFT_MUTATION_RECEIPT_COOKIE)?.value)
      : null;
  const confirmed = receipt && hasShiftAction(actions, receipt.operation) ? receipt : null;
  const unconfirmed =
    one(parameters.result) && (one(parameters.result) !== "success" || !confirmed);
  return (
    <section aria-labelledby="report-shifts-heading" className="work-surface">
      {mode === "standalone" ? (
        <a className="text-command detail-back" href="/workspace/hr">
          Back to HR
        </a>
      ) : null}
      <header className="surface-heading">
        <h1 id="report-shifts-heading">Report shifts</h1>
      </header>
      {confirmed ? (
        <div className="success-banner" id="shift-result" role="status" tabIndex={-1}>
          <h2>Last Shift action receipt</h2>
          <p>
            {confirmed.operation} confirmed {confirmed.status} at version {confirmed.version}.
          </p>
          <p>Roster {confirmed.rosterVersionId}</p>
          {confirmed.recordId === confirmed.rosterVersionId ? null : (
            <p>Assignment {confirmed.recordId}</p>
          )}
        </div>
      ) : unconfirmed ? (
        <div className="form-error-summary" id="shift-result" role="alert" tabIndex={-1}>
          <p>The requested Shift action is not confirmed. Review current values and try again.</p>
        </div>
      ) : null}
      <RouteBackedWidgetGetForm
        action="/workspace/hr/shifts/reports"
        className="leave-request-form"
        focusOrigin={focusOrigin}
      >
        <div className="form-grid-two">
          <div className="form-field">
            <label htmlFor="roster-id">Roster Version ID</label>
            <input defaultValue={rosterVersionId} id="roster-id" name="rosterVersionId" required />
          </div>
          <div className="form-field">
            <label htmlFor="roster-status">Assignment status</label>
            <select
              defaultValue={one(parameters.status) ?? "active"}
              id="roster-status"
              name="status"
            >
              <option value="active">Active</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
        <button className="command-button command-button-primary" type="submit">
          Load authorized roster
        </button>
      </RouteBackedWidgetGetForm>
      {canCreate ? (
        <details className="leave-detail-section">
          <summary>Create an exact roster period</summary>
          <RouteBackedWidgetPostForm
            action="/workspace/hr/shifts/action"
            className="leave-request-form"
            focusOrigin={focusOrigin}
          >
            <input name="operation" type="hidden" value="create_roster" />
            <input name="idempotencyKey" type="hidden" value={randomUUID()} />
            <div className="form-grid-two">
              <div className="form-field">
                <label htmlFor="period-start">Period start</label>
                <input id="period-start" name="periodStart" required type="date" />
              </div>
              <div className="form-field">
                <label htmlFor="period-end">Period end</label>
                <input id="period-end" name="periodEnd" required type="date" />
              </div>
            </div>
            <button className="command-button command-button-primary" type="submit">
              Create draft roster
            </button>
          </RouteBackedWidgetPostForm>
        </details>
      ) : null}
      {rosterVersionId && canAssign ? (
        <details className="leave-detail-section">
          <summary>Assign a worker</summary>
          <RouteBackedWidgetPostForm
            action="/workspace/hr/shifts/action"
            className="leave-request-form"
            focusOrigin={focusOrigin}
          >
            <input name="operation" type="hidden" value="assign" />
            <input name="idempotencyKey" type="hidden" value={randomUUID()} />
            <input name="rosterVersionId" type="hidden" value={rosterVersionId} />
            <div className="form-grid-two">
              <div className="form-field">
                <label htmlFor="shift-worker">Worker Profile ID</label>
                <input id="shift-worker" name="workerProfileId" required />
              </div>
              <div className="form-field">
                <label htmlFor="shift-zone">IANA timezone</label>
                <input defaultValue="Asia/Karachi" id="shift-zone" name="ianaTimezone" required />
              </div>
              <div className="form-field">
                <label htmlFor="shift-start">Start instant</label>
                <input
                  id="shift-start"
                  name="startsAt"
                  placeholder="2028-08-03T04:00:00Z"
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="shift-end">End instant</label>
                <input id="shift-end" name="endsAt" placeholder="2028-08-03T12:00:00Z" required />
              </div>
            </div>
            <button className="command-button command-button-primary" type="submit">
              Assign shift
            </button>
          </RouteBackedWidgetPostForm>
        </details>
      ) : null}
      {rosterVersionId && canPublish ? (
        <RouteBackedWidgetPostForm
          action="/workspace/hr/shifts/action"
          className="leave-request-form"
          focusOrigin={focusOrigin}
        >
          <input name="operation" type="hidden" value="publish" />
          <input name="idempotencyKey" type="hidden" value={randomUUID()} />
          <input name="rosterVersionId" type="hidden" value={rosterVersionId} />
          <div className="form-field">
            <label htmlFor="roster-version">Expected roster version</label>
            <input
              defaultValue={rosterVersion}
              id="roster-version"
              min="1"
              name="expectedVersion"
              required
              type="number"
            />
          </div>
          <button className="command-button command-button-primary" type="submit">
            Publish exact roster
          </button>
        </RouteBackedWidgetPostForm>
      ) : null}
      {canCancel && state.status === "error" ? (
        <RouteBackedWidgetPostForm
          action="/workspace/hr/shifts/action"
          className="leave-request-form"
          focusOrigin={focusOrigin}
        >
          <input name="operation" type="hidden" value="cancel" />
          <input name="idempotencyKey" type="hidden" value={randomUUID()} />
          <div className="form-field">
            <label htmlFor="cancel-shift-id">Shift Assignment ID</label>
            <input id="cancel-shift-id" name="shiftAssignmentId" required />
          </div>
          <div className="form-field">
            <label htmlFor="cancel-shift-version">Expected assignment version</label>
            <input
              id="cancel-shift-version"
              min="1"
              name="expectedVersion"
              required
              type="number"
            />
          </div>
          <button className="command-button command-button-danger" type="submit">
            Cancel assignment
          </button>
        </RouteBackedWidgetPostForm>
      ) : null}
      {!rosterVersionId ? (
        <div className="empty-worklist">
          <h2>Enter a roster to begin</h2>
        </div>
      ) : state.status === "error" ? (
        <div className="form-error-summary" role="alert">
          <h2>{state.title}</h2>
          <p>{state.message}</p>
        </div>
      ) : state.page.items.length === 0 ? (
        <div className="empty-worklist">
          <h2>No authorized assignments</h2>
        </div>
      ) : (
        <ol aria-label="Authorized report shifts" className="work-queue">
          {state.page.items.map((shift) => (
            <li className="work-queue-item" key={shift.shiftAssignmentId}>
              <div className="work-queue-primary">
                <div>
                  <p className="work-queue-kicker">{shift.status}</p>
                  <h2>{shift.startsAt}</h2>
                  <p className="work-queue-dates">Worker {shift.workerProfileId}</p>
                </div>
                <span className="leave-status">{shift.ianaTimezone}</span>
              </div>
              <Link
                className="text-command"
                href={
                  focusOrigin
                    ? buildNestedRouteBackedWidgetHref(
                        reportShiftDetailHref(
                          shift.shiftAssignmentId,
                          rosterVersionId,
                          one(parameters.status) ?? "active",
                        ),
                        focusOrigin,
                      )
                    : reportShiftDetailHref(
                        shift.shiftAssignmentId,
                        rosterVersionId,
                        one(parameters.status) ?? "active",
                      )
                }
              >
                View persistent history
              </Link>
              {canCancel && shift.status === "active" ? (
                <RouteBackedWidgetPostForm
                  action="/workspace/hr/shifts/action"
                  focusOrigin={focusOrigin}
                >
                  <input name="operation" type="hidden" value="cancel" />
                  <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                  <input name="shiftAssignmentId" type="hidden" value={shift.shiftAssignmentId} />
                  <input name="expectedVersion" type="hidden" value={shift.version} />
                  <button className="command-button command-button-danger" type="submit">
                    Cancel assignment
                  </button>
                </RouteBackedWidgetPostForm>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
