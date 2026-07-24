import { randomUUID } from "node:crypto";
import { Settings2 } from "lucide-react";
import { cookies } from "next/headers";
import {
  loadShiftServiceControl,
  readShiftServiceReceipt,
  SHIFT_MUTATION_RECEIPT_COOKIE,
} from "../../../../../lib/hr-shift-assignment";
import {
  hasShiftAction,
  isShiftServiceActionOnlyFallback,
} from "../../../../../lib/hr-shift-assignment-core";
import { ShiftResult } from "../result";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
const resultCopy = {
  conflict: "Service control changed. Reloaded values are shown.",
  denied: "Your current role does not permit Shift Assignment service control.",
  dependency_unavailable: "A required Workforce Profile or activation dependency is unavailable.",
  inactive: "Activate Shift Assignment before changing its settings.",
  not_found: "Shift Assignment is ready for its first governed activation.",
  operational_error: "The service-control action is not confirmed. Review current values.",
  success: "The service-control action completed. Receipt-bound continuity values are shown.",
  validation: "Review the registered Shift Assignment settings and try again.",
} as const;
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function Result({ value }: Readonly<{ value: string | undefined }>) {
  if (!(value && value in resultCopy)) return null;
  return (
    <ShiftResult
      message={resultCopy[value as keyof typeof resultCopy]}
      success={value === "success"}
    />
  );
}

export default async function ShiftSettingsPage({ searchParams }: Props) {
  const [state, parameters, cookieStore] = await Promise.all([
    loadShiftServiceControl(),
    searchParams,
    cookies(),
  ]);
  const result = one(parameters.result);
  const actions = state.authorizedActions;
  const canView = hasShiftAction(actions, "view_service_control");
  const canActivate = hasShiftAction(actions, "activate_service");
  const canConfigure = hasShiftAction(actions, "configure_service");
  const canDeactivate = hasShiftAction(actions, "deactivate_service");
  const hasAction = canActivate || canConfigure || canDeactivate;
  const failure = state.status === "error" ? state : null;
  const control = canView && state.status === "success" ? state.control : null;
  const canInitialize = canView && state.status === "error" && state.kind === "not_found";
  const canUseManualControl = isShiftServiceActionOnlyFallback(failure?.kind, hasAction);
  const receipt =
    result === "success"
      ? readShiftServiceReceipt(cookieStore.get(SHIFT_MUTATION_RECEIPT_COOKIE)?.value)
      : null;
  const confirmed = receipt && hasShiftAction(actions, receipt.operation) ? receipt : null;
  const effectiveActivationState = control?.activationState ?? confirmed?.activationState;
  const visibleResult =
    control || canInitialize || canUseManualControl
      ? result === "success" && !confirmed
        ? "operational_error"
        : result
      : undefined;

  return (
    <section aria-labelledby="shift-settings-heading" className="work-surface leave-form-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Tenant administration</p>
          <h1 id="shift-settings-heading">Shift Assignment settings</h1>
          <p className="surface-summary">
            Control only Shift Assignment availability and its exact registered settings. This page
            never grants roster or assignment readership.
          </p>
        </div>
        {control ? (
          <span className="leave-status">
            {control.activationState === "active" ? "Active" : "Inactive"}
          </span>
        ) : null}
      </header>
      <Result value={visibleResult} />
      {control || canInitialize || canUseManualControl ? (
        <div className="leave-detail-layout">
          <section aria-labelledby="shift-lifecycle-heading" className="leave-detail-section">
            <div className="detail-section-heading">
              <Settings2 aria-hidden="true" size={20} strokeWidth={1.7} />
              <h2 id="shift-lifecycle-heading">Service lifecycle</h2>
            </div>
            {confirmed ? (
              <div aria-labelledby="shift-control-receipt-heading" role="status">
                <h3 id="shift-control-receipt-heading">Last service-control receipt</h3>
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Receipt activation version</dt>
                    <dd>{confirmed.activationVersion}</dd>
                  </div>
                  <div>
                    <dt>Receipt settings version</dt>
                    <dd>{confirmed.settingsVersion}</dd>
                  </div>
                  <div>
                    <dt>Receipt control version</dt>
                    <dd>{confirmed.controlVersion}</dd>
                  </div>
                  <div>
                    <dt>Receipt activation state</dt>
                    <dd>{confirmed.activationState}</dd>
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
              <p>No service-control row exists. Activation will create it atomically.</p>
            ) : (
              <p>Exact versions remain required and every action is rechecked.</p>
            )}
            {canActivate && effectiveActivationState !== "active" ? (
              <form action="/workspace/hr/shifts/action" method="post">
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
                    <label htmlFor="shift-activate-version">Expected activation version</label>
                    <input
                      defaultValue={confirmed?.activationVersion}
                      id="shift-activate-version"
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
            {canDeactivate && effectiveActivationState !== "inactive" ? (
              <form action="/workspace/hr/shifts/action" method="post">
                <input name="operation" type="hidden" value="deactivate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                {control ? (
                  <input name="expectedVersion" type="hidden" value={control.activationVersion} />
                ) : (
                  <div className="form-field">
                    <label htmlFor="shift-deactivate-version">Expected activation version</label>
                    <input
                      defaultValue={confirmed?.activationVersion}
                      id="shift-deactivate-version"
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
            <section aria-labelledby="shift-registered-settings" className="leave-detail-section">
              <h2 id="shift-registered-settings">Registered settings</h2>
              {canConfigure ? (
                <form
                  action="/workspace/hr/shifts/action"
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
                      <label htmlFor="shift-settings-version">Expected settings version</label>
                      <input
                        defaultValue={confirmed?.settingsVersion}
                        id="shift-settings-version"
                        min="1"
                        name="expectedSettingsVersion"
                        required
                        type="number"
                      />
                    </div>
                  )}
                  <input name="overlapAllowed" type="hidden" value="false" />
                  <div className="form-field">
                    <label htmlFor="shift-roster-horizon">Maximum inclusive roster days</label>
                    <input
                      defaultValue={control?.settings.rosterHorizonDays}
                      id="shift-roster-horizon"
                      max="31"
                      min="1"
                      name="rosterHorizonDays"
                      required
                      type="number"
                    />
                    <p className="field-hint">
                      Limits one roster period only; it does not impose a today-relative window.
                    </p>
                  </div>
                  <dl className="leave-detail-facts">
                    <div>
                      <dt>Overlapping active assignments</dt>
                      <dd>Blocked by policy floor</dd>
                    </div>
                  </dl>
                  <button
                    className="command-button command-button-primary"
                    disabled={effectiveActivationState === "inactive"}
                    type="submit"
                  >
                    Save Shift settings
                  </button>
                </form>
              ) : control ? (
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Maximum inclusive roster days</dt>
                    <dd>{control.settings.rosterHorizonDays}</dd>
                  </div>
                  <div>
                    <dt>Overlapping active assignments</dt>
                    <dd>Blocked by policy floor</dd>
                  </div>
                </dl>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <section className="leave-list-error" role="alert">
          <h2>{failure?.title ?? "Service controls unavailable"}</h2>
          <p>{failure?.message ?? "Shift Assignment service controls are unavailable."}</p>
        </section>
      )}
    </section>
  );
}
