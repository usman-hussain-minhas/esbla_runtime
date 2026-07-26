"use client";

import type { HrExpenseClaimLine } from "@esbla/contracts/hr-expense-claim-api";
import { useRef, useState } from "react";

type EditableLine = Readonly<
  Pick<
    HrExpenseClaimLine,
    "amountMinor" | "categoryCode" | "description" | "expenseDate" | "expenseLineId" | "version"
  >
> & { readonly key: string };

function blank(key: string): EditableLine {
  return {
    amountMinor: 0,
    categoryCode: "",
    description: "",
    expenseDate: "",
    expenseLineId: "",
    key,
    version: 0,
  };
}

export function ExpenseLineEditor({ lines }: Readonly<{ lines: readonly HrExpenseClaimLine[] }>) {
  const nextKey = useRef(1);
  const [editable, setEditable] = useState<readonly EditableLine[]>(() =>
    lines.length ? lines.map((line) => ({ ...line, key: line.expenseLineId })) : [blank("new-0")],
  );
  return (
    <div>
      <ol aria-label="Expense lines" className="work-queue">
        {editable.map((line, index) => (
          <li className="work-queue-item" key={line.key}>
            <fieldset>
              <legend>Expense line {index + 1}</legend>
              {line.expenseLineId ? (
                <>
                  <input name={`expenseLineId_${index}`} type="hidden" value={line.expenseLineId} />
                  <input name={`lineVersion_${index}`} type="hidden" value={line.version} />
                </>
              ) : null}
              <div className="form-grid-two">
                <div className="form-field">
                  <label htmlFor={`expense-date-${index}`}>Expense date</label>
                  <input
                    defaultValue={line.expenseDate}
                    id={`expense-date-${index}`}
                    name={`expenseDate_${index}`}
                    required
                    type="date"
                  />
                </div>
                <div className="form-field">
                  <label htmlFor={`expense-category-${index}`}>Category code</label>
                  <input
                    defaultValue={line.categoryCode}
                    id={`expense-category-${index}`}
                    maxLength={64}
                    name={`categoryCode_${index}`}
                    pattern="[^\s,]+"
                    required
                    type="text"
                  />
                </div>
              </div>
              <div className="form-grid-two">
                <div className="form-field">
                  <label htmlFor={`expense-amount-${index}`}>Amount in minor units</label>
                  <input
                    defaultValue={line.amountMinor || ""}
                    id={`expense-amount-${index}`}
                    max="2147483647"
                    min="1"
                    name={`amountMinor_${index}`}
                    required
                    type="number"
                  />
                  <p className="field-hint">
                    Recorded claim fact only; no payment or money movement occurs.
                  </p>
                </div>
                <div className="form-field">
                  <label htmlFor={`expense-description-${index}`}>Description</label>
                  <input
                    defaultValue={line.description ?? ""}
                    id={`expense-description-${index}`}
                    maxLength={500}
                    name={`description_${index}`}
                    type="text"
                  />
                </div>
              </div>
              <button
                className="text-command"
                onClick={() =>
                  setEditable((current) => current.filter(({ key }) => key !== line.key))
                }
                type="button"
              >
                Remove line {index + 1}
              </button>
            </fieldset>
          </li>
        ))}
      </ol>
      <button
        className="text-command"
        disabled={editable.length >= 50}
        onClick={() => setEditable((current) => [...current, blank(`new-${nextKey.current++}`)])}
        type="button"
      >
        Add expense line
      </button>
      <p className="field-hint">{editable.length} of 50 permitted lines shown.</p>
    </div>
  );
}
