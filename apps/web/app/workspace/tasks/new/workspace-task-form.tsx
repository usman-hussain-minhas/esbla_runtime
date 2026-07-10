"use client";

import { LoaderCircle, Send, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  createFormStateForError,
  INITIAL_WORKSPACE_TASK_CREATE_STATE,
  parseWorkspaceTaskCreateTransport,
} from "../../../../lib/workspace-task-create-core";

interface WorkspaceTaskFormProps {
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
      {pending ? "Creating..." : "Create task"}
    </button>
  );
}

export function WorkspaceTaskForm({ idempotencyKey }: WorkspaceTaskFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState(INITIAL_WORKSPACE_TASK_CREATE_STATE);
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
      const response = await fetch("/workspace/tasks/new/submit", {
        body: JSON.stringify({
          assigneePrincipalId: formData.get("assigneePrincipalId"),
          description: formData.get("description"),
          dueOn: formData.get("dueOn"),
          idempotencyKey: formData.get("idempotencyKey"),
          title: formData.get("title"),
        }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const result = parseWorkspaceTaskCreateTransport(await response.json());
      if (!result.ok) {
        setState(result.state);
        return;
      }
      router.push("/workspace/tasks?created=1");
    } catch {
      setState(createFormStateForError(new Error("unavailable")));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      action="/workspace/tasks/new/submit"
      className="leave-request-form task-request-form"
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
        <label htmlFor="task-title">Title</label>
        <input
          aria-describedby={state.fieldErrors.title ? "task-title-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.title)}
          id="task-title"
          maxLength={160}
          name="title"
          required
          type="text"
        />
        {state.fieldErrors.title ? (
          <p className="field-error" id="task-title-error">
            {state.fieldErrors.title}
          </p>
        ) : null}
      </div>

      <div className="form-field">
        <label htmlFor="task-assignee">Assignee principal ID</label>
        <input
          aria-describedby={
            state.fieldErrors.assigneePrincipalId ? "task-assignee-error" : "task-assignee-hint"
          }
          aria-invalid={Boolean(state.fieldErrors.assigneePrincipalId)}
          id="task-assignee"
          name="assigneePrincipalId"
          required
          type="text"
        />
        <p className="field-hint" id="task-assignee-hint">
          Development-only principal picker until directory search is implemented.
        </p>
        {state.fieldErrors.assigneePrincipalId ? (
          <p className="field-error" id="task-assignee-error">
            {state.fieldErrors.assigneePrincipalId}
          </p>
        ) : null}
      </div>

      <div className="form-field">
        <div className="form-label-row">
          <label htmlFor="task-due-on">Due date</label>
          <span>Optional</span>
        </div>
        <input
          aria-describedby={state.fieldErrors.dueOn ? "task-due-on-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.dueOn)}
          id="task-due-on"
          name="dueOn"
          type="date"
        />
        {state.fieldErrors.dueOn ? (
          <p className="field-error" id="task-due-on-error">
            {state.fieldErrors.dueOn}
          </p>
        ) : null}
      </div>

      <div className="form-field">
        <div className="form-label-row">
          <label htmlFor="task-description">Description</label>
          <span>Optional</span>
        </div>
        <textarea
          aria-describedby={state.fieldErrors.description ? "task-description-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.description)}
          id="task-description"
          maxLength={2000}
          name="description"
          rows={5}
        />
        {state.fieldErrors.description ? (
          <p className="field-error" id="task-description-error">
            {state.fieldErrors.description}
          </p>
        ) : null}
      </div>

      <div className="form-actions">
        <a className="text-command" href="/workspace/tasks">
          Cancel
        </a>
        <SubmitButton pending={pending} />
      </div>
    </form>
  );
}
