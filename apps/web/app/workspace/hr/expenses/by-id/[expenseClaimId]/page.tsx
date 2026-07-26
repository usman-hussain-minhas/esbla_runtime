import { loadExpenseClaimDetail } from "../../../../../../lib/hr-expense-claim";
import { ExpenseResult } from "../../result";

interface Props {
  readonly params: Promise<{ expenseClaimId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}
const resultCopy = {
  conflict: "Expense Claim changed. Current persistent values are shown.",
  current: "Current persistent Expense Claim status and history are shown.",
  denied: "Your current role does not permit that Expense Claim action.",
  dependency_unavailable: "A required Expense Claim dependency is unavailable.",
  inactive: "Expense Claim is inactive. Existing history remains preserved.",
  not_found: "This Expense Claim is not available.",
  operational_error: "The Expense Claim action was not confirmed. Review current values.",
  validation: "Currency, lines, dates, categories, or submitted values are invalid.",
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

export default async function ExpenseClaimDetailPage({ params, searchParams }: Props) {
  const [{ expenseClaimId }, parameters] = await Promise.all([params, searchParams]);
  const state = await loadExpenseClaimDetail(expenseClaimId, parameters);
  const returnTo = one(parameters.returnTo);
  const fromMyWork = returnTo === "my-work";
  const back = fromMyWork ? "/workspace/my-work" : "/workspace/hr/expenses";
  const result = one(parameters.result);
  const detail = state.status === "success" ? state.detail : null;
  return (
    <section aria-labelledby="expense-detail-heading" className="work-surface">
      <a className="text-command detail-back" href={back}>
        {fromMyWork ? "Back to My Work" : "Back to Expense Claims"}
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">Expense Claim Boundary</p>
          <h1 id="expense-detail-heading">Expense Claim detail</h1>
          <p className="surface-summary">
            Review bounded claim facts and evidence-backed persistent version history. This surface
            performs no reimbursement, payment, or money movement.
          </p>
        </div>
        {detail ? (
          <span className="leave-status">{label(detail.currentVersion.status)}</span>
        ) : null}
      </header>
      {result &&
      Object.hasOwn(resultCopy, result) &&
      (result !== "current" || state.status === "success") ? (
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
        <div className="leave-detail-layout">
          <section aria-labelledby="expense-current-heading" className="leave-detail-section">
            <h2 id="expense-current-heading">Current claim facts</h2>
            <dl className="leave-detail-facts">
              <div>
                <dt>Currency</dt>
                <dd>{state.detail.currentVersion.currencyCode}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>
                  {minor(
                    state.detail.currentVersion.totalAmountMinor,
                    state.detail.currentVersion.currencyCode,
                  )}
                </dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{state.detail.currentVersion.version}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{state.detail.currentVersion.submittedAt ?? "Not submitted"}</dd>
              </div>
            </dl>
            {state.detail.currentVersion.lines.length === 0 ? (
              <div className="empty-worklist">
                <p>No claim lines are recorded in this version.</p>
              </div>
            ) : (
              <ol aria-label="Expense Claim lines" className="work-queue">
                {state.detail.currentVersion.lines.map((line) => (
                  <li className="work-queue-item" key={line.expenseLineId}>
                    <strong>{line.categoryCode}</strong>
                    <span>{minor(line.amountMinor, state.detail.currentVersion.currencyCode)}</span>
                    <time dateTime={line.expenseDate}>{line.expenseDate}</time>
                    {line.description ? <p>{line.description}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-labelledby="expense-history-heading" className="leave-detail-section">
            <h2 id="expense-history-heading">Version history</h2>
            <ol className="history-list">
              {state.detail.history?.items.map((item) => (
                <li key={item.expenseClaimVersionId}>
                  <strong>
                    Version {item.version}: {label(item.status)}
                  </strong>
                  <span>{minor(item.totalAmountMinor, item.currencyCode)}</span>
                  {item.decisionNote ? <p>{item.decisionNote}</p> : null}
                </li>
              ))}
            </ol>
            {state.detail.history?.nextCursor ? (
              <a
                className="text-command"
                href={`?${new URLSearchParams({
                  ...(fromMyWork ? { returnTo: "my-work" } : { returnTo: "own" }),
                  cursorExpenseClaimVersionId:
                    state.detail.history.nextCursor.expenseClaimVersionId,
                  cursorVersion: String(state.detail.history.nextCursor.version),
                })}`}
              >
                Older Expense Claim versions
              </a>
            ) : null}
          </section>
        </div>
      )}
    </section>
  );
}
