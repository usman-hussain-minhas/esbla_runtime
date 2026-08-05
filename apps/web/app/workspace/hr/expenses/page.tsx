import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { loadExpenseClaimDetail, loadOwnExpenseClaims } from "../../../../lib/hr-expense-claim";
import { hasExpenseAction, parseOwnExpenseCursor } from "../../../../lib/hr-expense-claim-core";
import {
  type RouteBackedWidgetOrigin,
  withoutRouteBackedWidgetOrigin,
} from "../../../../lib/route-backed-widget-navigation-core";
import { RouteBackedWidgetLink } from "../../../../theme/zen-theme/v1/route-backed-widget-link";
import { RouteBackedWidgetPostForm } from "../../../../theme/zen-theme/v1/route-backed-widget-overlay";
import { ExpenseLineEditor } from "./expense-line-editor";
import { ExpenseResult } from "./result";

interface Props {
  readonly focusOrigin?: RouteBackedWidgetOrigin | undefined;
  readonly mode?: "focus-master" | "standalone" | undefined;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
const resultCopy = {
  conflict: "Expense Claim changed. Reloaded persistent values are shown.",
  current: "Current persistent Expense Claim state is shown.",
  denied: "Your current role does not permit that Expense Claim action.",
  dependency_unavailable: "A required Expense Claim dependency is unavailable.",
  inactive: "Expense Claim is inactive. Existing history remains preserved.",
  not_found: "The selected Expense Claim is not available.",
  operational_error: "The Expense Claim action was not confirmed. Review current values.",
  validation: "Review the currency, line facts, dates, categories, and expected versions.",
} as const;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function label(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
function minor(value: number, currency: string): string {
  return `${new Intl.NumberFormat("en").format(value)} ${currency} minor units`;
}

function ExpenseActionForm({
  children,
  className,
  focusOrigin,
}: Readonly<{
  children: ReactNode;
  className?: string | undefined;
  focusOrigin?: RouteBackedWidgetOrigin | undefined;
}>) {
  if (!focusOrigin) {
    return (
      <form action="/workspace/hr/expenses/action" className={className} method="post">
        {children}
      </form>
    );
  }
  return (
    <RouteBackedWidgetPostForm
      action="/workspace/hr/expenses/action"
      resultFocusId="expense-result"
      focusOrigin={focusOrigin}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </RouteBackedWidgetPostForm>
  );
}

export default async function ExpensesPage({
  focusOrigin,
  mode = "standalone",
  searchParams,
}: Props) {
  const parameters = await searchParams;
  const selectedId = one(parameters.edit);
  const productParameters = withoutRouteBackedWidgetOrigin(parameters);
  const listCursor = parseOwnExpenseCursor(productParameters);
  const ownCursorParameters = listCursor
    ? {
        cursorCreatedAt: listCursor.createdAt,
        cursorExpenseClaimId: listCursor.expenseClaimId,
      }
    : {};
  const listPromise = loadOwnExpenseClaims(productParameters);
  const detailPromise = selectedId ? loadExpenseClaimDetail(selectedId) : Promise.resolve(null);
  const [state, selected] = await Promise.all([listPromise, detailPromise]);
  const result = one(parameters.result);
  const resultIsTruthful =
    result !== "current" ||
    (state.status === "success" && (!selectedId || selected?.status === "success"));
  const detail = selected?.status === "success" ? selected.detail : null;
  const canCreate = hasExpenseAction(state.authorizedActions, "create");
  const canEdit =
    detail?.accessScope === "own" &&
    detail.currentVersion.status === "draft" &&
    hasExpenseAction(selected?.authorizedActions ?? [], "edit_draft");
  const canSubmit =
    detail?.accessScope === "own" &&
    detail.currentVersion.status === "draft" &&
    hasExpenseAction(selected?.authorizedActions ?? [], "submit");

  return (
    <section aria-labelledby="expenses-heading" className="work-surface">
      {mode === "standalone" ? (
        <a className="text-command detail-back" href="/workspace/hr">
          Back to HR
        </a>
      ) : null}
      <header className="surface-heading">
        <div>
          <p className="surface-label">Expense Claim Boundary</p>
          <h1 id="expenses-heading">My Expense Claims</h1>
          <p className="surface-summary">
            Record bounded claim facts without receipts, Finance handoff, reimbursement, payment, or
            money movement.
          </p>
        </div>
      </header>
      {result && Object.hasOwn(resultCopy, result) && resultIsTruthful ? (
        <ExpenseResult
          message={resultCopy[result as keyof typeof resultCopy]}
          success={result === "current"}
        />
      ) : null}
      {state.status === "error" ? (
        <div className="form-error-summary" role="alert">
          <h2>{state.title}</h2>
          <p>{state.message}</p>
        </div>
      ) : (
        <>
          {canCreate ? (
            <ExpenseActionForm className="leave-request-form" focusOrigin={focusOrigin}>
              <h2>Create a claim draft</h2>
              <input name="idempotencyKey" type="hidden" value={randomUUID()} />
              <input name="operation" type="hidden" value="create" />
              {Object.entries(ownCursorParameters).map(([name, value]) => (
                <input key={name} name={name} type="hidden" value={value} />
              ))}
              <div className="form-field">
                <label htmlFor="expense-currency">ISO currency code</label>
                <input
                  autoCapitalize="characters"
                  id="expense-currency"
                  maxLength={3}
                  minLength={3}
                  name="currencyCode"
                  pattern="[A-Z]{3}"
                  required
                  type="text"
                />
                <p className="field-hint">
                  Currency identifies the recorded claim facts only. No financial transaction is
                  created.
                </p>
              </div>
              <button className="command-button command-button-primary" type="submit">
                Create Expense Claim draft
              </button>
            </ExpenseActionForm>
          ) : null}

          {selected ? (
            selected.status === "error" ? (
              <div className="form-error-summary" role="alert">
                <h2>{selected.title}</h2>
                <p>{selected.message}</p>
              </div>
            ) : (
              <section aria-labelledby="expense-edit-heading" className="leave-detail-section">
                <h2 id="expense-edit-heading">Selected claim draft</h2>
                <dl className="leave-detail-facts">
                  <div>
                    <dt>Status</dt>
                    <dd>{label(selected.detail.currentVersion.status)}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>
                      {minor(
                        selected.detail.currentVersion.totalAmountMinor,
                        selected.detail.currentVersion.currencyCode,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{selected.detail.currentVersion.version}</dd>
                  </div>
                </dl>
                {canEdit ? (
                  <ExpenseActionForm className="leave-request-form" focusOrigin={focusOrigin}>
                    <h3>Edit claim lines</h3>
                    <input name="operation" type="hidden" value="edit_draft" />
                    {Object.entries(ownCursorParameters).map(([name, value]) => (
                      <input key={name} name={name} type="hidden" value={value} />
                    ))}
                    <input
                      name="expenseClaimId"
                      type="hidden"
                      value={selected.detail.expenseClaimId}
                    />
                    <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                    <input
                      name="expectedRootVersion"
                      type="hidden"
                      value={selected.detail.rootVersion}
                    />
                    <input
                      name="expectedExpenseClaimVersionId"
                      type="hidden"
                      value={selected.detail.currentVersion.expenseClaimVersionId}
                    />
                    <input
                      name="expectedVersion"
                      type="hidden"
                      value={selected.detail.currentVersion.rowVersion}
                    />
                    <ExpenseLineEditor
                      key={`${selected.detail.currentVersion.expenseClaimVersionId}:${selected.detail.currentVersion.rowVersion}`}
                      lines={selected.detail.currentVersion.lines}
                    />
                    <button className="command-button command-button-primary" type="submit">
                      Save Expense Claim draft
                    </button>
                  </ExpenseActionForm>
                ) : null}
                {canSubmit ? (
                  <ExpenseActionForm focusOrigin={focusOrigin}>
                    <input name="operation" type="hidden" value="submit" />
                    {Object.entries(ownCursorParameters).map(([name, value]) => (
                      <input key={name} name={name} type="hidden" value={value} />
                    ))}
                    <input
                      name="expenseClaimId"
                      type="hidden"
                      value={selected.detail.expenseClaimId}
                    />
                    <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                    <input
                      name="expectedRootVersion"
                      type="hidden"
                      value={selected.detail.rootVersion}
                    />
                    <input
                      name="expectedExpenseClaimVersionId"
                      type="hidden"
                      value={selected.detail.currentVersion.expenseClaimVersionId}
                    />
                    <input
                      name="expectedVersion"
                      type="hidden"
                      value={selected.detail.currentVersion.rowVersion}
                    />
                    <button className="command-button command-button-primary" type="submit">
                      Submit Expense Claim
                    </button>
                  </ExpenseActionForm>
                ) : null}
              </section>
            )
          ) : null}

          {state.page.items.length === 0 ? (
            <section className="empty-worklist">
              <h2>No Expense Claims yet</h2>
              <p>Your bounded claim drafts and persistent statuses will appear here.</p>
            </section>
          ) : (
            <ol aria-label="My Expense Claims" className="work-queue">
              {state.page.items.map((item) => (
                <li className="work-queue-item" key={item.expenseClaimId}>
                  <div className="work-queue-primary">
                    <div>
                      <p className="work-queue-kicker">{label(item.status)}</p>
                      <h2>{minor(item.totalAmountMinor, item.currencyCode)}</h2>
                      <p className="work-queue-dates">Version {item.version}</p>
                    </div>
                  </div>
                  <div className="work-queue-actions">
                    {item.status === "draft" &&
                    hasExpenseAction(state.authorizedActions, "edit_draft") ? (
                      <RouteBackedWidgetLink
                        className="text-command"
                        focusHref={`/workspace/hr/expenses?${new URLSearchParams({
                          edit: item.expenseClaimId,
                          ...ownCursorParameters,
                        })}`}
                        focusOrigin={focusOrigin}
                        href={`?${new URLSearchParams({
                          edit: item.expenseClaimId,
                          ...ownCursorParameters,
                        })}`}
                      >
                        Edit draft
                      </RouteBackedWidgetLink>
                    ) : null}
                    <RouteBackedWidgetLink
                      className="text-command"
                      focusOrigin={focusOrigin}
                      href={`/workspace/hr/expenses/by-id/${item.expenseClaimId}?${new URLSearchParams(
                        {
                          returnTo: "own",
                          ...(listCursor
                            ? {
                                cursorCreatedAt: listCursor.createdAt,
                                cursorExpenseClaimId: listCursor.expenseClaimId,
                              }
                            : {}),
                        },
                      )}`}
                    >
                      View status and history
                    </RouteBackedWidgetLink>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {state.page.nextCursor ? (
            <RouteBackedWidgetLink
              className="text-command"
              focusHref={`/workspace/hr/expenses?${new URLSearchParams({
                cursorCreatedAt: state.page.nextCursor.createdAt,
                cursorExpenseClaimId: state.page.nextCursor.expenseClaimId,
              })}`}
              focusOrigin={focusOrigin}
              href={`?${new URLSearchParams({
                cursorCreatedAt: state.page.nextCursor.createdAt,
                cursorExpenseClaimId: state.page.nextCursor.expenseClaimId,
              })}`}
            >
              Next Expense Claim page
            </RouteBackedWidgetLink>
          ) : null}
        </>
      )}
    </section>
  );
}
