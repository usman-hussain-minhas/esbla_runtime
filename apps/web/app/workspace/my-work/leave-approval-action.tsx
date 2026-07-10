"use client";

import { Check, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  approveFormStateForError,
  INITIAL_HR_LEAVE_APPROVE_STATE,
  parseHrLeaveApproveTransport,
} from "../../../lib/hr-leave-approve-core";

interface LeaveApprovalActionProps {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly leaveRequestId: string;
}

export function LeaveApprovalAction({
  expectedVersion,
  idempotencyKey,
  leaveRequestId,
}: LeaveApprovalActionProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState(INITIAL_HR_LEAVE_APPROVE_STATE);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (state.status === "error") errorSummary.current?.focus();
    else if (confirming) confirmButton.current?.focus();
  }, [confirming, state]);

  function beginConfirmation() {
    setState(INITIAL_HR_LEAVE_APPROVE_STATE);
    setConfirming(true);
  }

  function cancelConfirmation() {
    if (pending) return;
    setState(INITIAL_HR_LEAVE_APPROVE_STATE);
    setConfirming(false);
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const response = await fetch(
        `/workspace/my-work/leave/${encodeURIComponent(leaveRequestId)}/approve`,
        {
          body: JSON.stringify({ expectedVersion, idempotencyKey }),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
        },
      );
      const result = parseHrLeaveApproveTransport(await response.json());
      if (!result.ok) {
        setState(result.state);
        return;
      }
      router.push(`/workspace/hr/leave/${result.leaveRequestId}?approved=1`);
      router.refresh();
    } catch {
      setState(approveFormStateForError(new Error("unavailable")));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="approval-action">
      {state.status === "error" ? (
        <div className="approval-error" ref={errorSummary} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={17} strokeWidth={1.8} />
          <p>{state.message}</p>
        </div>
      ) : null}

      {confirming ? (
        <form
          action={`/workspace/my-work/leave/${leaveRequestId}/approve`}
          className="approval-confirmation"
          method="post"
          onSubmit={approve}
        >
          <p id={`approval-confirmation-${leaveRequestId}`}>
            Approve this request? This completes the assigned work and records approval evidence.
          </p>
          <div className="approval-confirmation-actions">
            <button
              className="command-button"
              disabled={pending}
              onClick={cancelConfirmation}
              type="button"
            >
              <X aria-hidden="true" size={16} strokeWidth={1.8} />
              Cancel
            </button>
            <button
              aria-describedby={`approval-confirmation-${leaveRequestId}`}
              className="command-button command-button-primary"
              disabled={pending}
              ref={confirmButton}
              type="submit"
            >
              {pending ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="submit-spinner"
                  size={17}
                  strokeWidth={1.8}
                />
              ) : (
                <Check aria-hidden="true" size={17} strokeWidth={1.8} />
              )}
              {pending ? "Approving..." : "Confirm approval"}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="command-button command-button-primary"
          onClick={beginConfirmation}
          type="button"
        >
          <Check aria-hidden="true" size={17} strokeWidth={1.8} />
          Approve request
        </button>
      )}
    </div>
  );
}
