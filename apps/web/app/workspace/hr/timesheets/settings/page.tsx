import { randomUUID } from "node:crypto";
import { Settings2 } from "lucide-react";
import { loadTimesheetServiceControl } from "../../../../../lib/hr-timesheet";
import { hasTimesheetAction } from "../../../../../lib/hr-timesheet-core";
import { TimesheetResult } from "../result";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const resultCopy = {
  conflict: "Service control changed. Current persistent values are shown.",
  current: "Current persistent Timesheet service-control values are shown.",
  denied: "Your current role does not permit Timesheet service control.",
  dependency_unavailable: "Workforce Profile or another activation dependency is unavailable.",
  inactive: "Activate Timesheet before changing its settings.",
  not_found: "Timesheet is ready for its first governed activation.",
  operational_error: "The service-control action was not confirmed. Review current values.",
  validation: "Review the registered Timesheet settings and expected versions.",
} as const;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function TimesheetSettingsPage({ searchParams }: Props) {
  const [state, parameters] = await Promise.all([loadTimesheetServiceControl(), searchParams]);
  const result = one(parameters.result);
  const actions = state.authorizedActions;
  const canView = hasTimesheetAction(actions, "view_service_control");
  const canActivate = hasTimesheetAction(actions, "activate_service");
  const canConfigure = hasTimesheetAction(actions, "configure_service");
  const canDeactivate = hasTimesheetAction(actions, "deactivate_service");
  const canInitialize = canActivate && state.status === "error" && state.kind === "not_found";
  const control = canView && state.status === "success" ? state.control : null;
  const failure = state.status === "error" ? state : null;
  const visibleResult =
    result && Object.hasOwn(resultCopy, result) && (result !== "current" || control)
      ? result
      : null;

  return (
    <section
      aria-labelledby="timesheet-settings-heading"
      className="work-surface leave-form-surface"
    >
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Tenant administration</p>
          <h1 id="timesheet-settings-heading">Timesheet settings</h1>
          <p className="surface-summary">
            Control Timesheet availability and exact registered validation settings. This page does
            not grant access to employee Timesheets.
          </p>
        </div>
        {control ? (
          <span className="leave-status">
            {control.activationState === "active" ? "Active" : "Inactive"}
          </span>
        ) : null}
      </header>

      {visibleResult ? (
        <TimesheetResult
          message={resultCopy[visibleResult as keyof typeof resultCopy]}
          success={visibleResult === "current"}
        />
      ) : null}

      {control || canInitialize ? (
        <div className="leave-detail-layout">
          <section aria-labelledby="timesheet-lifecycle-heading" className="leave-detail-section">
            <div className="detail-section-heading">
              <Settings2 aria-hidden="true" size={20} strokeWidth={1.7} />
              <h2 id="timesheet-lifecycle-heading">Service lifecycle</h2>
            </div>
            {control ? (
              <dl className="leave-detail-facts">
                <div>
                  <dt>Activation version</dt>
                  <dd>{control.activationVersion}</dd>
                </div>
                <div>
                  <dt>Settings version</dt>
                  <dd>{control.settingsVersion}</dd>
                </div>
                <div>
                  <dt>Control version</dt>
                  <dd>{control.version}</dd>
                </div>
                <div>
                  <dt>Last updated</dt>
                  <dd>{control.updatedAt}</dd>
                </div>
              </dl>
            ) : (
              <p>No service-control row exists. Activation creates default settings atomically.</p>
            )}
            {canActivate && control?.activationState !== "active" ? (
              <form action="/workspace/hr/timesheets/action" method="post">
                <input name="operation" type="hidden" value="activate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                <input
                  name="expectedVersion"
                  type="hidden"
                  value={control?.activationVersion ?? ""}
                />
                <button className="command-button command-button-primary" type="submit">
                  Activate Timesheet
                </button>
              </form>
            ) : null}
            {canDeactivate && control?.activationState === "active" ? (
              <form action="/workspace/hr/timesheets/action" method="post">
                <input name="operation" type="hidden" value="deactivate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                <input name="expectedVersion" type="hidden" value={control.activationVersion} />
                <button className="command-button command-button-danger" type="submit">
                  Deactivate Timesheet
                </button>
              </form>
            ) : null}
          </section>

          {control ? (
            <section
              aria-labelledby="timesheet-registered-settings"
              className="leave-detail-section"
            >
              <h2 id="timesheet-registered-settings">Registered settings</h2>
              {canConfigure ? (
                <form
                  action="/workspace/hr/timesheets/action"
                  className="leave-request-form"
                  method="post"
                >
                  <input name="operation" type="hidden" value="configure_service" />
                  <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                  <input
                    name="expectedSettingsVersion"
                    type="hidden"
                    value={control.settingsVersion}
                  />
                  <input name="periodCadence" type="hidden" value="weekly" />
                  <div className="form-field">
                    <label htmlFor="timesheet-max-daily-minutes">Maximum daily minutes</label>
                    <input
                      defaultValue={control.settings.maxDailyMinutes}
                      disabled={control.activationState === "inactive"}
                      id="timesheet-max-daily-minutes"
                      max="1440"
                      min="1"
                      name="maxDailyMinutes"
                      required
                      type="number"
                    />
                    <p className="field-hint">
                      Operational validation only; this setting carries no labor-law meaning.
                    </p>
                  </div>
                  <div className="form-field">
                    <label htmlFor="timesheet-rejection-note">Rejection note</label>
                    <select
                      defaultValue={String(control.settings.rejectionNoteRequired)}
                      disabled={control.activationState === "inactive"}
                      id="timesheet-rejection-note"
                      name="rejectionNoteRequired"
                    >
                      <option value="true">Required</option>
                      <option value="false">Optional</option>
                    </select>
                  </div>
                  <dl className="leave-detail-facts">
                    <div>
                      <dt>Period cadence</dt>
                      <dd>Weekly</dd>
                    </div>
                  </dl>
                  <button
                    className="command-button command-button-primary"
                    disabled={control.activationState === "inactive"}
                    type="submit"
                  >
                    Save Timesheet settings
                  </button>
                </form>
              ) : (
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Maximum daily minutes</dt>
                    <dd>{control.settings.maxDailyMinutes}</dd>
                  </div>
                  <div>
                    <dt>Rejection note</dt>
                    <dd>{control.settings.rejectionNoteRequired ? "Required" : "Optional"}</dd>
                  </div>
                  <div>
                    <dt>Period cadence</dt>
                    <dd>Weekly</dd>
                  </div>
                </dl>
              )}
            </section>
          ) : null}
        </div>
      ) : (
        <section className="leave-list-error" role="alert">
          <h2>{failure?.title ?? "Service controls unavailable"}</h2>
          <p>{failure?.message ?? "Timesheet service controls are unavailable."}</p>
        </section>
      )}
    </section>
  );
}
