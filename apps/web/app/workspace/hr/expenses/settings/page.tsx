import { randomUUID } from "node:crypto";
import { Settings2 } from "lucide-react";
import { loadExpenseClaimServiceControl } from "../../../../../lib/hr-expense-claim";
import { hasExpenseAction } from "../../../../../lib/hr-expense-claim-core";
import { ExpenseResult } from "../result";

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const resultCopy = {
  conflict: "Service control changed. Current persistent values are shown.",
  current: "Current persistent Expense Claim service-control values are shown.",
  denied: "Your current role does not permit Expense Claim service control.",
  dependency_unavailable: "Workforce Profile or another activation dependency is unavailable.",
  inactive: "Activate Expense Claim before changing its settings.",
  not_found: "Expense Claim is ready for its first governed activation.",
  operational_error: "The service-control action was not confirmed. Review current values.",
  validation: "Review the registered Expense Claim settings and expected versions.",
} as const;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function ExpenseSettingsPage({ searchParams }: Props) {
  const [state, parameters] = await Promise.all([loadExpenseClaimServiceControl(), searchParams]);
  const result = one(parameters.result);
  const actions = state.authorizedActions;
  const canView = hasExpenseAction(actions, "view_service_control");
  const canActivate = hasExpenseAction(actions, "activate_service");
  const canConfigure = hasExpenseAction(actions, "configure_service");
  const canDeactivate = hasExpenseAction(actions, "deactivate_service");
  const canInitialize = canActivate && state.status === "error" && state.kind === "not_found";
  const control = canView && state.status === "success" ? state.control : null;
  const failure = state.status === "error" ? state : null;
  const visibleResult =
    result && Object.hasOwn(resultCopy, result) && (result !== "current" || control)
      ? result
      : null;

  return (
    <section aria-labelledby="expense-settings-heading" className="work-surface leave-form-surface">
      <a className="text-command detail-back" href="/workspace/hr">
        Back to HR
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Tenant administration</p>
          <h1 id="expense-settings-heading">Expense Claim settings</h1>
          <p className="surface-summary">
            Control Expense Claim availability and exact registered categories. This page neither
            grants employee-claim readership nor performs a financial transaction.
          </p>
        </div>
        {control ? (
          <span className="leave-status">
            {control.activationState === "active" ? "Active" : "Inactive"}
          </span>
        ) : null}
      </header>

      {visibleResult ? (
        <ExpenseResult
          message={resultCopy[visibleResult as keyof typeof resultCopy]}
          success={visibleResult === "current"}
        />
      ) : null}

      {control || canInitialize ? (
        <div className="leave-detail-layout">
          <section aria-labelledby="expense-lifecycle-heading" className="leave-detail-section">
            <div className="detail-section-heading">
              <Settings2 aria-hidden="true" size={20} strokeWidth={1.7} />
              <h2 id="expense-lifecycle-heading">Service lifecycle</h2>
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
              <form action="/workspace/hr/expenses/action" method="post">
                <input name="operation" type="hidden" value="activate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                <input
                  name="expectedVersion"
                  type="hidden"
                  value={control?.activationVersion ?? ""}
                />
                <button className="command-button command-button-primary" type="submit">
                  Activate Expense Claim
                </button>
              </form>
            ) : null}
            {canDeactivate && control?.activationState === "active" ? (
              <form action="/workspace/hr/expenses/action" method="post">
                <input name="operation" type="hidden" value="deactivate_service" />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                <input name="expectedVersion" type="hidden" value={control.activationVersion} />
                <button className="command-button command-button-danger" type="submit">
                  Deactivate Expense Claim
                </button>
              </form>
            ) : null}
          </section>

          {control ? (
            <section aria-labelledby="expense-registered-settings" className="leave-detail-section">
              <h2 id="expense-registered-settings">Registered settings</h2>
              {canConfigure ? (
                <form
                  action="/workspace/hr/expenses/action"
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
                  <div className="form-field">
                    <label htmlFor="expense-category-codes">Category codes</label>
                    <input
                      defaultValue={control.settings.categoryCodes}
                      disabled={control.activationState === "inactive"}
                      id="expense-category-codes"
                      name="categoryCodes"
                      pattern="[^\s,]+(?:,[^\s,]+)*"
                      required
                      type="text"
                    />
                    <p className="field-hint">
                      Enter unique opaque codes separated only by commas, for example travel,other.
                    </p>
                  </div>
                  <div className="form-field">
                    <label htmlFor="expense-rejection-note-required">Rejection note</label>
                    <select
                      defaultValue={String(control.settings.rejectionNoteRequired)}
                      disabled={control.activationState === "inactive"}
                      id="expense-rejection-note-required"
                      name="rejectionNoteRequired"
                    >
                      <option value="true">Required</option>
                      <option value="false">Optional</option>
                    </select>
                  </div>
                  <button
                    className="command-button command-button-primary"
                    disabled={control.activationState === "inactive"}
                    type="submit"
                  >
                    Save Expense Claim settings
                  </button>
                </form>
              ) : (
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Category codes</dt>
                    <dd>{control.settings.categoryCodes}</dd>
                  </div>
                  <div>
                    <dt>Rejection note</dt>
                    <dd>{control.settings.rejectionNoteRequired ? "Required" : "Optional"}</dd>
                  </div>
                </dl>
              )}
            </section>
          ) : null}
        </div>
      ) : (
        <section className="leave-list-error" role="alert">
          <h2>{failure?.title ?? "Service controls unavailable"}</h2>
          <p>{failure?.message ?? "Expense Claim service controls are unavailable."}</p>
        </section>
      )}
    </section>
  );
}
