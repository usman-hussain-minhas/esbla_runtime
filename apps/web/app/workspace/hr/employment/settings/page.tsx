import { randomUUID } from "node:crypto";
import { Settings2 } from "lucide-react";
import { cookies } from "next/headers";
import {
  EMPLOYMENT_MUTATION_RECEIPT_COOKIE,
  type EmploymentMutationReceipt,
  loadEmploymentServiceControl,
  readEmploymentMutationReceipt,
} from "../../../../../lib/hr-employment-record";
import { hasEmploymentAction } from "../../../../../lib/hr-employment-record-core";
import { EmploymentResult } from "../result";

interface EmploymentSettingsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type EmploymentServiceMutationReceipt = Extract<
  EmploymentMutationReceipt,
  { readonly kind: "service_control" }
>;

const resultCopy = {
  conflict: "Service control changed. Reloaded values are shown.",
  denied: "Your current role does not permit Employment Record service control.",
  dependency_unavailable: "A required Workforce Profile or activation dependency is unavailable.",
  inactive: "Activate Employment Record before changing its settings.",
  not_found: "Employment Record is ready for its first governed activation.",
  operational_error: "The service-control action could not be completed. Try again.",
  success: "The service-control action completed. Continuity values are shown below.",
  validation: "Review the registered Employment Record settings and try again.",
} as const;

function Result({ value }: Readonly<{ value: string | undefined }>) {
  if (!(value && value in resultCopy)) return null;
  const success = value === "success";
  return (
    <EmploymentResult message={resultCopy[value as keyof typeof resultCopy]} success={success} />
  );
}

export default async function EmploymentSettingsPage({
  searchParams,
}: EmploymentSettingsPageProps) {
  const [state, parameters, cookieStore] = await Promise.all([
    loadEmploymentServiceControl(),
    searchParams,
    cookies(),
  ]);
  const result = Array.isArray(parameters.result) ? undefined : parameters.result;
  const canView = hasEmploymentAction(state.authorizedActions, "view_service_control");
  const canActivate = hasEmploymentAction(state.authorizedActions, "activate_service");
  const canConfigure = hasEmploymentAction(state.authorizedActions, "configure_service");
  const canDeactivate = hasEmploymentAction(state.authorizedActions, "deactivate_service");
  const hasAction = canActivate || canConfigure || canDeactivate;
  const mutationReceipt =
    result === "success"
      ? readEmploymentMutationReceipt(
          cookieStore.get(EMPLOYMENT_MUTATION_RECEIPT_COOKIE)?.value,
          "settings",
        )
      : null;
  const serviceReceipt: EmploymentServiceMutationReceipt | null =
    mutationReceipt?.kind === "service_control" &&
    hasEmploymentAction(state.authorizedActions, mutationReceipt.operation)
      ? mutationReceipt
      : null;
  const canInitialize = canView && state.status === "error" && state.kind === "not_found";
  const control = canView && state.status === "success" ? state.control : null;
  const employmentSettings =
    control && "employmentTypeCodes" in control.settings ? control.settings : null;
  const failure = state.status === "error" ? state : null;
  const effectiveActivationState = control?.activationState ?? serviceReceipt?.activationState;
  const receiptBoundResult = result === "success" && !serviceReceipt ? "operational_error" : result;
  const visibleResult = control || canInitialize || hasAction ? receiptBoundResult : undefined;

  return (
    <section
      aria-labelledby="employment-settings-heading"
      className="work-surface leave-form-surface"
    >
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Tenant administration</p>
          <h1 id="employment-settings-heading">Employment Record settings</h1>
          <p className="surface-summary">
            Control exact service availability and opaque employment codes. This page never grants
            access to employment records.
          </p>
        </div>
        {control ? (
          <span className="leave-status">
            {control.activationState === "active" ? "Active" : "Inactive"}
          </span>
        ) : null}
      </header>
      <Result value={visibleResult} />
      {canView || hasAction ? (
        <div className="leave-detail-layout">
          <section aria-labelledby="employment-lifecycle-heading" className="leave-detail-section">
            <div className="detail-section-heading">
              <Settings2 aria-hidden="true" size={20} strokeWidth={1.7} />
              <h2 id="employment-lifecycle-heading">Service lifecycle</h2>
            </div>
            {serviceReceipt ? (
              <div aria-labelledby="employment-control-receipt-heading" role="status">
                <h3 id="employment-control-receipt-heading">Last mutation receipt</h3>
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
              <p>No service-control row exists. Activation will create it atomically.</p>
            ) : (
              <p>
                Service-control facts are not available through this authority snapshot. Exact
                versions are still required and every action is rechecked.
              </p>
            )}
            {canActivate && effectiveActivationState !== "active" ? (
              <form action="/workspace/hr/employment/action" method="post">
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
                    <label htmlFor="employment-activate-version">Expected activation version</label>
                    <input
                      defaultValue={serviceReceipt?.activationVersion}
                      id="employment-activate-version"
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
              <form action="/workspace/hr/employment/action" method="post">
                <input name="operation" type="hidden" value="deactivate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                {control ? (
                  <input name="expectedVersion" type="hidden" value={control.activationVersion} />
                ) : (
                  <div className="form-field">
                    <label htmlFor="employment-deactivate-version">
                      Expected activation version
                    </label>
                    <input
                      defaultValue={serviceReceipt?.activationVersion}
                      id="employment-deactivate-version"
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
            <section aria-labelledby="employment-code-heading" className="leave-detail-section">
              <h2 id="employment-code-heading">Registered settings</h2>
              {canConfigure ? (
                <form
                  action="/workspace/hr/employment/action"
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
                      <label htmlFor="employment-settings-version">Expected settings version</label>
                      <input
                        defaultValue={serviceReceipt?.settingsVersion}
                        id="employment-settings-version"
                        min="1"
                        name="expectedSettingsVersion"
                        required
                        type="number"
                      />
                    </div>
                  )}
                  <input name="effectiveRangeOverlapAllowed" type="hidden" value="false" />
                  <div className="form-field">
                    <label htmlFor="employment-type-codes">Employment type codes</label>
                    <input
                      defaultValue={employmentSettings?.employmentTypeCodes ?? ""}
                      id="employment-type-codes"
                      name="employmentTypeCodes"
                      required
                      type="text"
                    />
                    <p className="field-hint">
                      Comma-separated opaque identifiers only, for example standard,temporary. Codes
                      have no legal interpretation.
                    </p>
                  </div>
                  <dl className="leave-detail-facts">
                    <div>
                      <dt>Effective range overlap</dt>
                      <dd>Blocked by policy floor</dd>
                    </div>
                  </dl>
                  <button
                    className="command-button command-button-primary"
                    disabled={effectiveActivationState === "inactive"}
                    type="submit"
                  >
                    Save Employment settings
                  </button>
                </form>
              ) : control ? (
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Employment type codes</dt>
                    <dd>{employmentSettings?.employmentTypeCodes ?? "Settings unavailable"}</dd>
                  </div>
                  <div>
                    <dt>Effective range overlap</dt>
                    <dd>Blocked by policy floor</dd>
                  </div>
                </dl>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <section
          aria-labelledby="employment-settings-unavailable"
          className="leave-list-error"
          role="alert"
        >
          <h2 id="employment-settings-unavailable">
            {failure?.title ?? "Service controls unavailable"}
          </h2>
          <p>{failure?.message ?? "Employment Record service controls are unavailable."}</p>
        </section>
      )}
    </section>
  );
}
