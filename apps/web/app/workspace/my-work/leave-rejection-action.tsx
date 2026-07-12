"use client";

import { CircleX, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { buildHrLeaveDetailHref } from "../../../lib/hr-leave-navigation-core";
import {
  INITIAL_HR_LEAVE_REJECT_STATE,
  parseHrLeaveRejectTransport,
  rejectFormStateForError,
} from "../../../lib/hr-leave-reject-core";

interface LeaveRejectionActionProps {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly leaveRequestId: string;
}

export function LeaveRejectionAction({
  expectedVersion,
  idempotencyKey,
  leaveRequestId,
}: LeaveRejectionActionProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const [pending, setPending] = useState(false);
  const [state, setState] = useState(INITIAL_HR_LEAVE_REJECT_STATE);
  const errorSummary = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const noteError = state.fieldErrors.decisionNote;
  const noteErrorId = `rejection-note-error-${leaveRequestId}`;
  const noteHintId = `rejection-note-hint-${leaveRequestId}`;

  useEffect(() => {
    if (state.status === "error") {
      if (noteError) noteField.current?.focus();
      else errorSummary.current?.focus();
    } else if (confirming) {
      noteField.current?.focus();
    }
  }, [confirming, noteError, state.status]);

  function beginConfirmation() {
    setState(INITIAL_HR_LEAVE_REJECT_STATE);
    setConfirming(true);
  }

  function cancelConfirmation() {
    if (pending) return;
    setState(INITIAL_HR_LEAVE_REJECT_STATE);
    setDecisionNote("");
    setConfirming(false);
  }

  async function reject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const response = await fetch(
        `/workspace/my-work/leave/${encodeURIComponent(leaveRequestId)}/reject`,
        {
          body: JSON.stringify({ decisionNote, expectedVersion, idempotencyKey }),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
        },
      );
      const result = parseHrLeaveRejectTransport(await response.json());
      if (!result.ok) {
        setState(result.state);
        return;
      }
      router.push(buildHrLeaveDetailHref(result.leaveRequestId, "my-work"));
      router.refresh();
    } catch {
      setState(rejectFormStateForError(new Error("unavailable")));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="rejection-action">
      {state.status === "error" ? (
        <div className="rejection-error" ref={errorSummary} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={17} strokeWidth={1.8} />
          <p>{state.message}</p>
        </div>
      ) : null}

      {confirming ? (
        <form
          action={`/workspace/my-work/leave/${leaveRequestId}/reject`}
          className="rejection-confirmation"
          method="post"
          onSubmit={reject}
        >
          <p id={`rejection-confirmation-${leaveRequestId}`}>
            Reject this request? This completes the assigned work and records rejection evidence.
          </p>
          <div className="form-field rejection-field">
            <div className="form-label-row">
              <label htmlFor={`rejection-note-${leaveRequestId}`}>Decision note</label>
              <span>{decisionNote.length} / 2,000</span>
            </div>
            <textarea
              aria-describedby={[noteHintId, noteError ? noteErrorId : null]
                .filter(Boolean)
                .join(" ")}
              aria-invalid={noteError ? "true" : undefined}
              disabled={pending}
              id={`rejection-note-${leaveRequestId}`}
              maxLength={2000}
              name="decisionNote"
              onChange={(event) => setDecisionNote(event.target.value)}
              ref={noteField}
              value={decisionNote}
            />
            <p className="field-hint" id={noteHintId}>
              Tenant policy may require a note.
            </p>
            {noteError ? (
              <p className="field-error" id={noteErrorId}>
                {noteError}
              </p>
            ) : null}
          </div>
          <div className="rejection-confirmation-actions">
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
              aria-describedby={`rejection-confirmation-${leaveRequestId}`}
              className="command-button command-button-danger"
              disabled={pending}
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
                <CircleX aria-hidden="true" size={17} strokeWidth={1.8} />
              )}
              {pending ? "Rejecting..." : "Confirm rejection"}
            </button>
          </div>
        </form>
      ) : (
        <button
          aria-label="Reject leave request"
          className="command-button command-button-danger"
          onClick={beginConfirmation}
          type="button"
        >
          <CircleX aria-hidden="true" size={17} strokeWidth={1.8} />
          Reject request
        </button>
      )}
    </div>
  );
}
