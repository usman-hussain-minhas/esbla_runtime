"use client";

import type { HrWorkforceServiceControl } from "@esbla/contracts";
import { LoaderCircle, Power, PowerOff, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { parseWorkforceControlTransport } from "../../../../../lib/hr-workforce-profile-manage-core";

interface WorkforceProfileServiceControlProps {
  readonly idempotencyKeys: { readonly activate: string; readonly deactivate: string };
  readonly initialControl: HrWorkforceServiceControl | null;
}

export function WorkforceProfileServiceControl({
  idempotencyKeys,
  initialControl,
}: WorkforceProfileServiceControlProps) {
  const [control, setControl] = useState(initialControl);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const active = control?.activationState === "active";

  useEffect(() => {
    if (message) feedback.current?.focus();
  }, [message]);

  async function mutate() {
    if (pending) return;
    setPending(true);
    setMessage(null);
    const action = active ? "deactivate" : "activate";
    try {
      const response = await fetch("/workspace/hr/profile/settings/submit", {
        body: JSON.stringify({
          action,
          expectedVersion: control?.activationVersion ?? null,
          idempotencyKey: idempotencyKeys[action],
        }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const result = parseWorkforceControlTransport(await response.json());
      if (!result.ok) setMessage(result.message);
      else setControl(result.control);
    } catch {
      setMessage("The workforce profile action is unavailable. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="profile-service-control">
      {message ? (
        <div className="form-error-summary" ref={feedback} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={19} strokeWidth={1.8} />
          <p>{message}</p>
        </div>
      ) : null}
      <div className="service-control-row">
        <div>
          <span className={`leave-status ${active ? "leave-status-approved" : ""}`}>
            {active ? "active" : "inactive"}
          </span>
          <h2>Workforce profile</h2>
          <p>
            {active
              ? "Authorized workforce profile behavior is available."
              : "Profile reads and mutations fail closed."}
          </p>
        </div>
        <button
          className={`command-button service-control-action ${active ? "command-button-danger" : "command-button-primary"}`}
          disabled={pending}
          onClick={mutate}
          type="button"
        >
          {pending ? (
            <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} />
          ) : active ? (
            <PowerOff aria-hidden="true" size={17} />
          ) : (
            <Power aria-hidden="true" size={17} />
          )}
          {pending ? "Saving..." : active ? "Deactivate" : "Activate"}
        </button>
      </div>
      {control ? (
        <p className="service-control-version">
          Activation version {control.activationVersion}; settings version {control.settingsVersion}
          .
        </p>
      ) : null}
    </div>
  );
}
