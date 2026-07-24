import { randomUUID } from "node:crypto";
import { Settings2 } from "lucide-react";
import { cookies } from "next/headers";
import {
  ATTENDANCE_SERVICE_RECEIPT_COOKIE,
  loadAttendanceServiceControl,
  readAttendanceServiceReceipt,
} from "../../../../../lib/hr-attendance";
import {
  hasAttendanceAction,
  isAttendanceServiceActionOnlyFallback,
} from "../../../../../lib/hr-attendance-core";
import { AttendanceResult } from "../result";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
const resultCopy = {
  conflict: "Service control changed. Reloaded values are shown.",
  denied: "Your current role does not permit Attendance service control.",
  dependency_unavailable: "Workforce Profile or another activation dependency is unavailable.",
  inactive: "Activate Attendance before changing its settings.",
  not_found: "Attendance is ready for its first governed activation.",
  operational_error: "The service-control action was not confirmed. Review current values.",
  success: "The service-control action completed. Receipt-bound values are shown.",
  validation: "Review the registered Attendance settings and try again.",
} as const;
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function AttendanceSettingsPage({ searchParams }: Props) {
  const [state, parameters, cookieStore] = await Promise.all([
    loadAttendanceServiceControl(),
    searchParams,
    cookies(),
  ]);
  const result = one(parameters.result);
  const actions = state.authorizedActions;
  const canView = hasAttendanceAction(actions, "view_service_control");
  const canActivate = hasAttendanceAction(actions, "activate_service");
  const canConfigure = hasAttendanceAction(actions, "configure_service");
  const canDeactivate = hasAttendanceAction(actions, "deactivate_service");
  const hasAction = canActivate || canConfigure || canDeactivate;
  const failure = state.status === "error" ? state : null;
  const receipt =
    result === "success"
      ? readAttendanceServiceReceipt(cookieStore.get(ATTENDANCE_SERVICE_RECEIPT_COOKIE)?.value)
      : null;
  const serviceReceipt =
    receipt && hasAttendanceAction(actions, receipt.operation) ? receipt : null;
  const canInitialize = canView && state.status === "error" && state.kind === "not_found";
  const control = canView && state.status === "success" ? state.control : null;
  const canUseManualControl = isAttendanceServiceActionOnlyFallback(failure?.kind, hasAction);
  const effectiveState = control?.activationState ?? serviceReceipt?.activationState;
  const visibleResult =
    control || canInitialize || canUseManualControl
      ? result === "success" && !serviceReceipt
        ? "operational_error"
        : result
      : undefined;

  return (
    <section
      aria-labelledby="attendance-settings-heading"
      className="work-surface leave-form-surface"
    >
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Tenant administration</p>
          <h1 id="attendance-settings-heading">Attendance settings</h1>
          <p className="surface-summary">
            Control service availability and which manual presence facts HR may record. This page
            does not grant access to Attendance records.
          </p>
        </div>
        {control ? (
          <span className="leave-status">
            {control.activationState === "active" ? "Active" : "Inactive"}
          </span>
        ) : null}
      </header>
      {visibleResult && visibleResult in resultCopy ? (
        <AttendanceResult
          message={resultCopy[visibleResult as keyof typeof resultCopy]}
          success={visibleResult === "success"}
        />
      ) : null}
      {control || canInitialize || canUseManualControl ? (
        <div className="leave-detail-layout">
          <section aria-labelledby="attendance-lifecycle-heading" className="leave-detail-section">
            <div className="detail-section-heading">
              <Settings2 aria-hidden="true" size={20} strokeWidth={1.7} />
              <h2 id="attendance-lifecycle-heading">Service lifecycle</h2>
            </div>
            {serviceReceipt ? (
              <div aria-labelledby="attendance-control-receipt-heading" role="status">
                <h3 id="attendance-control-receipt-heading">Last service-control receipt</h3>
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Receipt activation version</dt>
                    <dd>{serviceReceipt.activationVersion}</dd>
                  </div>
                  <div>
                    <dt>Receipt settings version</dt>
                    <dd>{serviceReceipt.settingsVersion}</dd>
                  </div>
                  <div>
                    <dt>Receipt control version</dt>
                    <dd>{serviceReceipt.controlVersion}</dd>
                  </div>
                  <div>
                    <dt>Receipt activation state</dt>
                    <dd>{serviceReceipt.activationState}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
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
            ) : canInitialize ? (
              <p>No service-control row exists. Activation creates default settings atomically.</p>
            ) : (
              <p>Exact versions remain required and every action is rechecked.</p>
            )}
            {canActivate && effectiveState !== "active" ? (
              <form action="/workspace/hr/attendance/action" method="post">
                <input name="operation" type="hidden" value="activate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                {control || canInitialize ? (
                  <input
                    name="expectedVersion"
                    type="hidden"
                    value={control?.activationVersion ?? ""}
                  />
                ) : (
                  <div className="form-field">
                    <label htmlFor="attendance-activate-version">Expected activation version</label>
                    <input
                      defaultValue={serviceReceipt?.activationVersion}
                      id="attendance-activate-version"
                      min="1"
                      name="expectedVersion"
                      type="number"
                    />
                    <p className="field-hint">Leave blank only for the first activation.</p>
                  </div>
                )}
                <button className="command-button command-button-primary" type="submit">
                  Activate service
                </button>
              </form>
            ) : null}
            {canDeactivate && effectiveState !== "inactive" ? (
              <form action="/workspace/hr/attendance/action" method="post">
                <input name="operation" type="hidden" value="deactivate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                {control ? (
                  <input name="expectedVersion" type="hidden" value={control.activationVersion} />
                ) : (
                  <div className="form-field">
                    <label htmlFor="attendance-deactivate-version">
                      Expected activation version
                    </label>
                    <input
                      defaultValue={serviceReceipt?.activationVersion}
                      id="attendance-deactivate-version"
                      min="1"
                      name="expectedVersion"
                      required
                      type="number"
                    />
                  </div>
                )}
                <button className="command-button command-button-danger" type="submit">
                  Deactivate service
                </button>
              </form>
            ) : null}
          </section>
          {canConfigure || control ? (
            <section
              aria-labelledby="attendance-registered-settings"
              className="leave-detail-section"
            >
              <h2 id="attendance-registered-settings">Registered settings</h2>
              {canConfigure ? (
                <form
                  action="/workspace/hr/attendance/action"
                  className="leave-request-form"
                  method="post"
                >
                  <input name="operation" type="hidden" value="configure_service" />
                  <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                  {control ? (
                    <input
                      name="expectedSettingsVersion"
                      type="hidden"
                      value={control.settingsVersion}
                    />
                  ) : (
                    <div className="form-field">
                      <label htmlFor="attendance-settings-version">Expected settings version</label>
                      <input
                        defaultValue={serviceReceipt?.settingsVersion}
                        id="attendance-settings-version"
                        min="1"
                        name="expectedSettingsVersion"
                        required
                        type="number"
                      />
                    </div>
                  )}
                  <input name="correctionNoteRequired" type="hidden" value="true" />
                  <div className="form-field">
                    <label htmlFor="attendance-manual-kinds">Allowed manual observations</label>
                    <select
                      defaultValue={control?.settings.manualObservationKinds}
                      disabled={effectiveState === "inactive"}
                      id="attendance-manual-kinds"
                      name="manualObservationKinds"
                    >
                      <option value="">None</option>
                      <option value="presence_start">Presence start only</option>
                      <option value="presence_end">Presence end only</option>
                      <option value="presence_start,presence_end">Presence start and end</option>
                    </select>
                    <p className="field-hint">
                      Synthetic, provider and device observations remain out of scope.
                    </p>
                  </div>
                  <dl className="leave-detail-facts">
                    <div>
                      <dt>Correction note</dt>
                      <dd>Required by policy floor</dd>
                    </div>
                  </dl>
                  <button
                    className="command-button command-button-primary"
                    disabled={effectiveState === "inactive"}
                    type="submit"
                  >
                    Save Attendance settings
                  </button>
                </form>
              ) : control ? (
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Allowed manual observations</dt>
                    <dd>{control.settings.manualObservationKinds || "None"}</dd>
                  </div>
                  <div>
                    <dt>Correction note</dt>
                    <dd>Required by policy floor</dd>
                  </div>
                </dl>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <section className="leave-list-error" role="alert">
          <h2>{failure?.title ?? "Service controls unavailable"}</h2>
          <p>{failure?.message ?? "Attendance service controls are unavailable."}</p>
        </section>
      )}
    </section>
  );
}
