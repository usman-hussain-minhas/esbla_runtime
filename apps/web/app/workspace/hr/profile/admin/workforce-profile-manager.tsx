"use client";

import type { HrWorkforceProfile } from "@esbla/contracts";
import { Check, Link2, LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { parseWorkforceManageTransport } from "../../../../../lib/hr-workforce-profile-manage-core";

interface WorkforceProfileManagerProps {
  readonly idempotencyKeys: {
    readonly activate: string;
    readonly create: string;
    readonly link: string;
  };
}

async function submitCommand(body: unknown) {
  const response = await fetch("/workspace/hr/profile/admin/submit", {
    body: JSON.stringify(body),
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
  });
  return parseWorkforceManageTransport(await response.json());
}

export function WorkforceProfileManager({ idempotencyKeys }: WorkforceProfileManagerProps) {
  const [profile, setProfile] = useState<HrWorkforceProfile | null>(null);
  const [pending, setPending] = useState<"activate" | "create" | "link" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const feedback = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message) feedback.current?.focus();
  }, [message]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending("create");
    setMessage(null);
    try {
      const form = new FormData(event.currentTarget);
      const result = await submitCommand({
        action: "create",
        employeeNumber: form.get("employeeNumber"),
        idempotencyKey: idempotencyKeys.create,
      });
      if (!result.ok) setMessage(result.message);
      else setProfile(result.profile);
    } catch {
      setMessage("The workforce profile action is unavailable. Try again.");
    } finally {
      setPending(null);
    }
  }

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !profile) return;
    setPending("link");
    setMessage(null);
    try {
      const form = new FormData(event.currentTarget);
      const result = await submitCommand({
        action: "link",
        expectedVersion: profile.version,
        idempotencyKey: idempotencyKeys.link,
        principalId: form.get("principalId"),
        workerProfileId: profile.workerProfileId,
      });
      if (!result.ok) setMessage(result.message);
      else setProfile(result.profile);
    } catch {
      setMessage("The workforce profile action is unavailable. Try again.");
    } finally {
      setPending(null);
    }
  }

  async function activate() {
    if (pending || !profile) return;
    setPending("activate");
    setMessage(null);
    try {
      const result = await submitCommand({
        action: "activate_profile",
        expectedVersion: profile.version,
        idempotencyKey: idempotencyKeys.activate,
        workerProfileId: profile.workerProfileId,
      });
      if (!result.ok) setMessage(result.message);
      else setProfile(result.profile);
    } catch {
      setMessage("The workforce profile action is unavailable. Try again.");
    } finally {
      setPending(null);
    }
  }

  const created = profile !== null;
  const linked = profile?.principalLinked === true;
  const active = profile?.workforceStatus === "active";

  return (
    <div className="profile-workflow">
      {message ? (
        <div className="form-error-summary" ref={feedback} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={19} strokeWidth={1.8} />
          <p>{message}</p>
        </div>
      ) : null}

      <ol aria-label="Workforce profile setup progress" className="profile-steps">
        <li data-complete={created}>Create</li>
        <li data-complete={linked}>Link</li>
        <li data-complete={active}>Activate</li>
      </ol>

      {!created ? (
        <form className="leave-request-form profile-step-form" noValidate onSubmit={create}>
          <div className="form-field">
            <div className="form-label-row">
              <label htmlFor="workforce-employee-number">Employee number</label>
              <span>Optional by default</span>
            </div>
            <input
              id="workforce-employee-number"
              maxLength={64}
              name="employeeNumber"
              type="text"
            />
          </div>
          <div className="form-actions">
            <span />
            <button
              className="command-button command-button-primary"
              disabled={pending !== null}
              type="submit"
            >
              {pending === "create" ? (
                <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} />
              ) : (
                <Plus aria-hidden="true" size={17} />
              )}
              {pending === "create" ? "Creating..." : "Create draft"}
            </button>
          </div>
        </form>
      ) : (
        <div className="profile-created-summary" role="status">
          <Check aria-hidden="true" size={18} />
          <span>
            Draft <strong>{profile.workerProfileId}</strong> is at version {profile.version}.
          </span>
        </div>
      )}

      {created && !linked ? (
        <form className="leave-request-form profile-step-form" noValidate onSubmit={link}>
          <div className="form-field">
            <label htmlFor="workforce-principal-id">Active principal ID</label>
            <input id="workforce-principal-id" name="principalId" required type="text" />
            <p className="field-hint">
              Use the active principal ID from Core identity administration.
            </p>
          </div>
          <div className="form-actions">
            <span />
            <button
              className="command-button command-button-primary"
              disabled={pending !== null}
              type="submit"
            >
              {pending === "link" ? (
                <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} />
              ) : (
                <Link2 aria-hidden="true" size={17} />
              )}
              {pending === "link" ? "Linking..." : "Link principal"}
            </button>
          </div>
        </form>
      ) : null}

      {linked && !active ? (
        <div className="profile-step-form">
          <h2>Activate the linked profile</h2>
          <p>The employee can view the minimized profile only after this transition.</p>
          <button
            className="command-button command-button-primary"
            disabled={pending !== null}
            onClick={activate}
            type="button"
          >
            {pending === "activate" ? (
              <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} />
            ) : (
              <Check aria-hidden="true" size={17} />
            )}
            {pending === "activate" ? "Activating..." : "Activate profile"}
          </button>
        </div>
      ) : null}

      {active ? (
        <div className="success-banner" role="status">
          <Check aria-hidden="true" size={19} />
          <div>
            <strong>Workforce profile is active</strong>
            <span>The linked employee can now open their privacy-minimized profile.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
