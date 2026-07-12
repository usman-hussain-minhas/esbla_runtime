"use client";

import { LoaderCircle, Send, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { buildHrLeaveDetailHref } from "../../../../../lib/hr-leave-navigation-core";
import {
  decodeHrLeaveSubmitTransport,
  INITIAL_HR_LEAVE_SUBMIT_STATE,
  submitFormStateForError,
} from "../../../../../lib/hr-leave-submit-core";

interface LeaveRequestFormProps {
  readonly idempotencyKey: string;
}

function SubmitButton({ pending }: { readonly pending: boolean }) {
  return (
    <button
      aria-disabled={pending}
      className="command-button command-button-primary"
      disabled={pending}
      type="submit"
    >
      {pending ? (
        <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} strokeWidth={1.8} />
      ) : (
        <Send aria-hidden="true" size={17} strokeWidth={1.8} />
      )}
      {pending ? "Submitting..." : "Submit request"}
    </button>
  );
}

export function LeaveRequestForm({ idempotencyKey }: LeaveRequestFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState(INITIAL_HR_LEAVE_SUBMIT_STATE);
  const errorSummary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === "error") errorSummary.current?.focus();
  }, [state]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const formData = new FormData(event.currentTarget);
      const result = await decodeHrLeaveSubmitTransport(
        fetch("/workspace/hr/leave/new/submit", {
          body: JSON.stringify({
            categoryCode: formData.get("categoryCode"),
            endDate: formData.get("endDate"),
            idempotencyKey: formData.get("idempotencyKey"),
            reason: formData.get("reason"),
            startDate: formData.get("startDate"),
          }),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
        }),
      );
      if (!result.ok) {
        setState(result.state);
        return;
      }
      router.replace(buildHrLeaveDetailHref(result.leaveRequestId, "leave-list"));
    } catch {
      setState(submitFormStateForError(new Error("unavailable")));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      action="/workspace/hr/leave/new/submit"
      className="leave-request-form"
      method="post"
      noValidate
      onSubmit={submit}
    >
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />

      {state.status === "error" ? (
        <div className="form-error-summary" ref={errorSummary} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={19} strokeWidth={1.8} />
          <p>{state.message}</p>
        </div>
      ) : null}

      <div className="form-field">
        <label htmlFor="leave-category">Leave type</label>
        <select
          aria-describedby={state.fieldErrors.categoryCode ? "leave-category-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.categoryCode)}
          defaultValue=""
          id="leave-category"
          name="categoryCode"
          required
        >
          <option disabled value="">
            Select a type
          </option>
          <option value="annual">Annual</option>
          <option value="sick">Sick</option>
          <option value="unpaid">Unpaid</option>
          <option value="other">Other</option>
        </select>
        {state.fieldErrors.categoryCode ? (
          <p className="field-error" id="leave-category-error">
            {state.fieldErrors.categoryCode}
          </p>
        ) : null}
      </div>

      <div className="form-grid-two">
        <div className="form-field">
          <label htmlFor="leave-start-date">Start date</label>
          <input
            aria-describedby={state.fieldErrors.startDate ? "leave-start-date-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.startDate)}
            id="leave-start-date"
            name="startDate"
            required
            type="date"
          />
          {state.fieldErrors.startDate ? (
            <p className="field-error" id="leave-start-date-error">
              {state.fieldErrors.startDate}
            </p>
          ) : null}
        </div>

        <div className="form-field">
          <label htmlFor="leave-end-date">End date</label>
          <input
            aria-describedby={state.fieldErrors.endDate ? "leave-end-date-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.endDate)}
            id="leave-end-date"
            name="endDate"
            required
            type="date"
          />
          {state.fieldErrors.endDate ? (
            <p className="field-error" id="leave-end-date-error">
              {state.fieldErrors.endDate}
            </p>
          ) : null}
        </div>
      </div>

      <div className="form-field">
        <div className="form-label-row">
          <label htmlFor="leave-reason">Reason</label>
          <span>Optional</span>
        </div>
        <textarea
          aria-describedby={state.fieldErrors.reason ? "leave-reason-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.reason)}
          id="leave-reason"
          maxLength={2000}
          name="reason"
          rows={5}
        />
        {state.fieldErrors.reason ? (
          <p className="field-error" id="leave-reason-error">
            {state.fieldErrors.reason}
          </p>
        ) : null}
      </div>

      <div className="form-actions">
        <a className="text-command" href="/workspace/hr/leave">
          Cancel
        </a>
        <SubmitButton pending={pending} />
      </div>
    </form>
  );
}
