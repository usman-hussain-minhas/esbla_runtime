"use client";

import { Check, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  completeFormStateForError,
  INITIAL_WORKSPACE_TASK_COMPLETE_STATE,
  parseWorkspaceTaskCompleteTransport,
} from "../../../lib/workspace-task-complete-core";

interface TaskCompleteActionProps {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly taskId: string;
}

export function TaskCompleteAction({
  expectedVersion,
  idempotencyKey,
  taskId,
}: TaskCompleteActionProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [completionNote, setCompletionNote] = useState("");
  const [pending, setPending] = useState(false);
  const [state, setState] = useState(INITIAL_WORKSPACE_TASK_COMPLETE_STATE);
  const errorSummary = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const noteError = state.fieldErrors.completionNote;

  useEffect(() => {
    if (state.status === "error") {
      if (noteError) noteField.current?.focus();
      else errorSummary.current?.focus();
    } else if (confirming) {
      noteField.current?.focus();
    }
  }, [confirming, noteError, state.status]);

  function beginConfirmation() {
    setState(INITIAL_WORKSPACE_TASK_COMPLETE_STATE);
    setConfirming(true);
  }

  function cancelConfirmation() {
    if (pending) return;
    setState(INITIAL_WORKSPACE_TASK_COMPLETE_STATE);
    setCompletionNote("");
    setConfirming(false);
  }

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const response = await fetch(
        `/workspace/my-work/tasks/${encodeURIComponent(taskId)}/complete`,
        {
          body: JSON.stringify({ completionNote, expectedVersion, idempotencyKey }),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
        },
      );
      const result = parseWorkspaceTaskCompleteTransport(await response.json());
      if (!result.ok) {
        setState(result.state);
        return;
      }
      router.push("/workspace/my-work?taskCompleted=1");
      router.refresh();
    } catch {
      setState(completeFormStateForError(new Error("unavailable")));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="approval-action task-complete-action">
      {state.status === "error" ? (
        <div className="approval-error" ref={errorSummary} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={17} strokeWidth={1.8} />
          <p>{state.message}</p>
        </div>
      ) : null}

      {confirming ? (
        <form
          action={`/workspace/my-work/tasks/${taskId}/complete`}
          className="approval-confirmation"
          method="post"
          onSubmit={complete}
        >
          <p id={`task-completion-confirmation-${taskId}`}>
            Complete this task? This closes the work item and records completion evidence.
          </p>
          <div className="form-field rejection-field">
            <div className="form-label-row">
              <label htmlFor={`task-completion-note-${taskId}`}>Completion note</label>
              <span>{completionNote.length} / 2,000</span>
            </div>
            <textarea
              aria-describedby={noteError ? `task-completion-note-error-${taskId}` : undefined}
              aria-invalid={noteError ? "true" : undefined}
              disabled={pending}
              id={`task-completion-note-${taskId}`}
              maxLength={2000}
              name="completionNote"
              onChange={(event) => setCompletionNote(event.target.value)}
              ref={noteField}
              value={completionNote}
            />
            {noteError ? (
              <p className="field-error" id={`task-completion-note-error-${taskId}`}>
                {noteError}
              </p>
            ) : null}
          </div>
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
              aria-describedby={`task-completion-confirmation-${taskId}`}
              className="command-button command-button-primary"
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
                <Check aria-hidden="true" size={17} strokeWidth={1.8} />
              )}
              {pending ? "Completing..." : "Complete task"}
            </button>
          </div>
        </form>
      ) : (
        <button
          aria-label="Complete workspace task"
          className="command-button command-button-primary"
          onClick={beginConfirmation}
          type="button"
        >
          <Check aria-hidden="true" size={17} strokeWidth={1.8} />
          Complete task
        </button>
      )}
    </div>
  );
}
