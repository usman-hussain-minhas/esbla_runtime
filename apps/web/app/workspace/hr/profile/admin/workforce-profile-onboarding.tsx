"use client";

import { Check, LoaderCircle, Power, TriangleAlert, UserRoundPlus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  decodeWorkforceActionTransport,
  parseWorkforceOnboardingSnapshot,
  type WorkforceFormState,
  type WorkforceIdempotencyKeys,
  type WorkforceOnboardingProgress,
  workforceOnboardingSnapshot,
} from "../../../../../lib/hr-workforce-profile-core";

interface Props {
  readonly idempotencyKeys: WorkforceIdempotencyKeys;
  readonly storageKey: string;
}

type Profile =
  Awaited<ReturnType<typeof profileRequest>> extends infer Result
    ? Result extends { readonly ok: true; readonly profile: infer Value }
      ? Value
      : never
    : never;

function profileRequest(payload: unknown) {
  return decodeWorkforceActionTransport(
    fetch("/workspace/hr/profile/admin/action", {
      body: JSON.stringify(payload),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
    }),
  );
}

function ActionButton({ children, pending }: { children: string; pending: boolean }) {
  return (
    <button className="command-button command-button-primary" disabled={pending} type="submit">
      {pending ? <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} /> : null}
      {pending ? "Working..." : children}
    </button>
  );
}

function freshIdempotencyKeys(): WorkforceIdempotencyKeys {
  return { activate: crypto.randomUUID(), create: crypto.randomUUID(), link: crypto.randomUUID() };
}

export function WorkforceProfileOnboarding({ idempotencyKeys, storageKey }: Props) {
  const [error, setError] = useState<WorkforceFormState>();
  const [hydrated, setHydrated] = useState(false);
  const [keys, setKeys] = useState(idempotencyKeys);
  const [pending, setPending] = useState(false);
  const [profile, setProfile] = useState<WorkforceOnboardingProgress>();
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const employeeNumberRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const activateRef = useRef<HTMLButtonElement>(null);
  const successRef = useRef<HTMLAnchorElement>(null);
  const storageName = `esbla.hr.workforce.onboarding.v1.${storageKey}`;
  const stage = !profile
    ? "create"
    : !profile.principalLinked
      ? "link"
      : profile.workforceStatus === "draft"
        ? "activate"
        : "complete";

  useEffect(() => {
    if (error || recoveryBlocked) errorRef.current?.focus();
    else if (stage === "create") employeeNumberRef.current?.focus();
    else if (stage === "link") linkRef.current?.focus();
    else if (stage === "activate") activateRef.current?.focus();
    else if (stage === "complete") successRef.current?.focus();
  }, [error, recoveryBlocked, stage]);

  useEffect(() => {
    try {
      if (!/^[0-9a-f]{64}$/.test(storageKey)) throw new TypeError("Invalid storage key");
      const stored = localStorage.getItem(storageName);
      const snapshot = stored
        ? parseWorkforceOnboardingSnapshot(JSON.parse(stored) as unknown)
        : workforceOnboardingSnapshot(idempotencyKeys);
      localStorage.setItem(storageName, JSON.stringify(snapshot));
      setKeys(snapshot.idempotencyKeys);
      setProfile(snapshot.progress ?? undefined);
    } catch {
      setRecoveryBlocked(true);
    } finally {
      setHydrated(true);
    }
  }, [idempotencyKeys, storageKey, storageName]);

  function persist(nextKeys: WorkforceIdempotencyKeys, nextProfile?: Profile) {
    const snapshot = workforceOnboardingSnapshot(nextKeys, nextProfile);
    localStorage.setItem(storageName, JSON.stringify(snapshot));
    setKeys(snapshot.idempotencyKeys);
    setProfile(snapshot.progress ?? undefined);
  }

  async function run(payload: unknown) {
    if (pending) return undefined;
    setPending(true);
    setError(undefined);
    const result = await profileRequest(payload);
    setPending(false);
    if (!result.ok) {
      setError(result.state);
      return undefined;
    }
    try {
      persist(keys, result.profile);
    } catch {
      setRecoveryBlocked(true);
      return undefined;
    }
    return result.profile;
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run({
      employeeNumber: data.get("employeeNumber"),
      idempotencyKey: keys.create,
      operation: "create",
    });
  }

  function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    const data = new FormData(event.currentTarget);
    void run({
      expectedVersion: profile.version,
      idempotencyKey: keys.link,
      operation: "link",
      principalId: data.get("principalId"),
      workerProfileId: profile.workerProfileId,
    });
  }

  function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    void run({
      expectedVersion: profile.version,
      idempotencyKey: keys.activate,
      operation: "activate",
      workerProfileId: profile.workerProfileId,
    });
  }

  function startAnother() {
    try {
      persist(freshIdempotencyKeys());
      setError(undefined);
    } catch {
      setRecoveryBlocked(true);
    }
  }

  if (!hydrated) {
    return (
      <div aria-busy="true" aria-live="polite" className="empty-worklist" role="status">
        <span aria-hidden="true" className="empty-worklist-icon">
          <LoaderCircle className="submit-spinner" size={27} strokeWidth={1.6} />
        </span>
        <h2>Loading safe onboarding</h2>
        <p>Checking durable recovery state before any action is available.</p>
      </div>
    );
  }

  if (recoveryBlocked) {
    return (
      <div className="form-error-summary" ref={errorRef} role="alert" tabIndex={-1}>
        <TriangleAlert aria-hidden="true" size={19} />
        <p>Safe recovery is unavailable. No action is allowed from this page.</p>
      </div>
    );
  }

  return (
    <div>
      <ol aria-label="Onboarding progress" className="leave-history work-queue">
        {[
          ["Create draft profile", Boolean(profile)],
          ["Link principal", Boolean(profile?.principalLinked)],
          ["Activate profile", profile?.workforceStatus === "active"],
        ].map(([label, done], index) => (
          <li className="leave-history-item" key={String(label)}>
            <span aria-hidden="true" className="leave-history-marker">
              {done ? <Check size={15} /> : index + 1}
            </span>
            <div>
              <strong>{label}</strong>
              <p>
                {done
                  ? "Completed"
                  : index === ["create", "link", "activate"].indexOf(stage)
                    ? "Current step"
                    : "Not started"}
              </p>
            </div>
          </li>
        ))}
      </ol>

      {error ? (
        <div className="form-error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={19} />
          <p>
            {error.message}
            {profile ? " The completed steps remain recorded and may be retried safely." : ""}
          </p>
        </div>
      ) : null}

      {stage === "create" ? (
        <form className="leave-request-form" noValidate onSubmit={create}>
          <div className="form-field">
            <div className="form-label-row">
              <label htmlFor="workforce-employee-number">Employee number</label>
              <span>Governed by workforce settings</span>
            </div>
            <input
              aria-describedby={
                error?.fieldErrors.employeeNumber ? "employee-number-error" : undefined
              }
              aria-invalid={Boolean(error?.fieldErrors.employeeNumber)}
              id="workforce-employee-number"
              name="employeeNumber"
              ref={employeeNumberRef}
            />
            {error?.fieldErrors.employeeNumber ? (
              <p className="field-error" id="employee-number-error">
                {error.fieldErrors.employeeNumber}
              </p>
            ) : null}
          </div>
          <div className="form-actions">
            <ActionButton pending={pending}>Create draft profile</ActionButton>
          </div>
        </form>
      ) : null}

      {stage === "link" ? (
        <form className="leave-request-form" noValidate onSubmit={link}>
          <div className="form-field">
            <label htmlFor="workforce-principal-id">Principal ID</label>
            <input
              aria-describedby={
                error?.fieldErrors.principalId
                  ? "principal-id-hint principal-id-error"
                  : "principal-id-hint"
              }
              aria-invalid={Boolean(error?.fieldErrors.principalId)}
              id="workforce-principal-id"
              name="principalId"
              ref={linkRef}
              required
            />
            <p className="field-hint" id="principal-id-hint">
              Enter the canonical UUID for an active principal. Directory search is not available.
            </p>
            {error?.fieldErrors.principalId ? (
              <p className="field-error" id="principal-id-error">
                {error.fieldErrors.principalId}
              </p>
            ) : null}
          </div>
          <div className="form-actions">
            <ActionButton pending={pending}>Link principal</ActionButton>
          </div>
        </form>
      ) : null}

      {stage === "activate" ? (
        <form className="leave-request-form" onSubmit={activate}>
          <p className="surface-summary">
            The draft is linked. Activation enables permission-bound own-profile access.
          </p>
          <div className="form-actions">
            <button
              className="command-button command-button-primary"
              disabled={pending}
              ref={activateRef}
              type="submit"
            >
              <Power aria-hidden="true" size={17} />
              {pending ? "Activating..." : "Activate profile"}
            </button>
          </div>
        </form>
      ) : null}

      {stage === "complete" && profile ? (
        <section className="leave-detail-section" role="status">
          <div className="detail-section-heading">
            <UserRoundPlus aria-hidden="true" size={19} />
            <h2>Onboarding complete</h2>
          </div>
          <p className="surface-summary">
            The worker profile is active. Own-profile access remains subject to the linked
            principal&apos;s current role and capability.
          </p>
          <div className="form-actions">
            <a className="text-command" href="/workspace/hr" ref={successRef}>
              Return to HR
            </a>
            <button className="command-button" onClick={startAnother} type="button">
              Onboard another worker
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
