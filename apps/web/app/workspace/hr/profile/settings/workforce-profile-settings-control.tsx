"use client";

import type { HrServiceControl } from "@esbla/contracts/hr-service-control-api";
import { LoaderCircle, Settings2, ShieldCheck, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  decodeWorkforceServiceControlTransport,
  validateWorkforceServiceControlAction,
  type WorkforceServiceControlAction,
  type WorkforceServiceControlFormState,
  type WorkforceServiceControlOperation,
} from "../../../../../lib/hr-workforce-service-control-core";

interface WorkforceProfileSettingsControlProps {
  readonly idempotencyKeys: Readonly<Record<WorkforceServiceControlOperation, string>>;
  readonly initialControl: HrServiceControl | null;
}

interface Attempt {
  key: string;
  signature: string | null;
}

const defaultSettings = {
  employeeNumberRequired: false,
  managerVisibility: "minimized" as const,
  unlinkedWorkerCreationAllowed: true,
};

function actionPayload(action: WorkforceServiceControlAction) {
  return action.operation === "configure"
    ? {
        employeeNumberRequired: action.body.settings.employeeNumberRequired,
        expectedSettingsVersion: action.body.expectedSettingsVersion,
        idempotencyKey: action.idempotencyKey,
        managerVisibility: action.body.settings.managerVisibility,
        operation: action.operation,
        unlinkedWorkerCreationAllowed: action.body.settings.unlinkedWorkerCreationAllowed,
      }
    : {
        expectedVersion: action.body.expectedVersion,
        idempotencyKey: action.idempotencyKey,
        operation: action.operation,
      };
}

export function WorkforceProfileSettingsControl({
  idempotencyKeys,
  initialControl,
}: WorkforceProfileSettingsControlProps) {
  const [control, setControl] = useState(initialControl);
  const [employeeNumberRequired, setEmployeeNumberRequired] = useState(
    initialControl?.serviceKey === "workforce_profile"
      ? initialControl.settings.employeeNumberRequired
      : defaultSettings.employeeNumberRequired,
  );
  const [managerVisibility, setManagerVisibility] = useState<"minimized" | "none">(
    initialControl?.serviceKey === "workforce_profile"
      ? initialControl.settings.managerVisibility
      : defaultSettings.managerVisibility,
  );
  const [unlinkedWorkerCreationAllowed, setUnlinkedWorkerCreationAllowed] = useState(
    initialControl?.serviceKey === "workforce_profile"
      ? initialControl.settings.unlinkedWorkerCreationAllowed
      : defaultSettings.unlinkedWorkerCreationAllowed,
  );
  const [error, setError] = useState<WorkforceServiceControlFormState>();
  const [success, setSuccess] = useState<string>();
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState<WorkforceServiceControlOperation>();
  const errorRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const attempts = useRef<Record<WorkforceServiceControlOperation, Attempt>>({
    activate: { key: idempotencyKeys.activate, signature: null },
    configure: { key: idempotencyKeys.configure, signature: null },
    deactivate: { key: idempotencyKeys.deactivate, signature: null },
  });

  useEffect(() => {
    setHydrated(true);
    if (error) errorRef.current?.focus();
    else if (success) successRef.current?.focus();
  }, [error, success]);

  function idempotencyKey(operation: WorkforceServiceControlOperation, signature: string) {
    const attempt = attempts.current[operation];
    if (attempt.signature !== null && attempt.signature !== signature) {
      attempt.key = crypto.randomUUID();
    }
    attempt.signature = signature;
    return attempt.key;
  }

  async function run(raw: Record<string, unknown>) {
    if (pending) return;
    const validation = validateWorkforceServiceControlAction(raw);
    if (!validation.ok) {
      setSuccess(undefined);
      setError(validation.state);
      return;
    }
    const action = validation.value;
    setPending(action.operation);
    setError(undefined);
    setSuccess(undefined);
    const result = await decodeWorkforceServiceControlTransport(
      fetch("/workspace/hr/profile/settings/action", {
        body: JSON.stringify(actionPayload(action)),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      }),
      control,
      action,
    );
    setPending(undefined);
    if (!result.ok) {
      setError(result.state);
      return;
    }
    setControl(result.control);
    if (result.control.serviceKey === "workforce_profile") {
      setEmployeeNumberRequired(result.control.settings.employeeNumberRequired);
      setManagerVisibility(result.control.settings.managerVisibility);
      setUnlinkedWorkerCreationAllowed(result.control.settings.unlinkedWorkerCreationAllowed);
    }
    setSuccess(
      action.operation === "configure"
        ? "Workforce Profile settings saved."
        : action.operation === "activate"
          ? "Workforce Profile activated."
          : "Workforce Profile deactivated. Existing records and evidence were preserved.",
    );
  }

  function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const expectedVersion = control?.activationVersion ?? null;
    void run({
      expectedVersion,
      idempotencyKey: idempotencyKey("activate", String(expectedVersion)),
      operation: "activate",
    });
  }

  function deactivate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!control) return;
    void run({
      expectedVersion: control.activationVersion,
      idempotencyKey: idempotencyKey("deactivate", String(control.activationVersion)),
      operation: "deactivate",
    });
  }

  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!control) return;
    const signature = [
      control.settingsVersion,
      employeeNumberRequired,
      managerVisibility,
      unlinkedWorkerCreationAllowed,
    ].join(":");
    void run({
      employeeNumberRequired,
      expectedSettingsVersion: control.settingsVersion,
      idempotencyKey: idempotencyKey("configure", signature),
      managerVisibility,
      operation: "configure",
      unlinkedWorkerCreationAllowed,
    });
  }

  const active = control?.activationState === "active";
  return (
    <div className="leave-detail-copy">
      <section aria-labelledby="workforce-control-state" className="leave-detail-section">
        <div className="detail-section-heading">
          <ShieldCheck aria-hidden="true" size={20} strokeWidth={1.7} />
          <h2 id="workforce-control-state">Service state</h2>
        </div>
        <p className={`leave-status leave-status-${active ? "approved" : "rejected"}`}>
          {control ? (active ? "Active" : "Inactive") : "Ready to activate"}
        </p>
        {control ? (
          <dl className="leave-detail-facts">
            <div>
              <dt>Activation version</dt>
              <dd>{control.activationVersion}</dd>
            </div>
            <div>
              <dt>Settings version</dt>
              <dd>{control.settingsVersion}</dd>
            </div>
            <div>
              <dt>Control version</dt>
              <dd>{control.version}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>
                <time dateTime={control.updatedAt}>
                  {new Date(control.updatedAt).toLocaleString()}
                </time>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="surface-summary">
            No service control exists yet. First activation creates the default settings atomically.
          </p>
        )}
      </section>

      {error ? (
        <div className="form-error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={19} />
          <p>{error.message}</p>
        </div>
      ) : null}
      {success ? (
        <div className="success-banner" ref={successRef} role="status" tabIndex={-1}>
          <ShieldCheck aria-hidden="true" size={19} />
          <div>
            <strong>Service control updated</strong>
            <span>{success}</span>
          </div>
        </div>
      ) : null}

      {active ? (
        <form
          aria-busy={pending === "configure"}
          className="leave-request-form"
          onSubmit={configure}
        >
          <div className="detail-section-heading">
            <Settings2 aria-hidden="true" size={20} strokeWidth={1.7} />
            <h2>Workforce settings</h2>
          </div>
          <label className="settings-choice-row">
            <input
              checked={employeeNumberRequired}
              disabled={!hydrated || Boolean(pending)}
              onChange={(event) => setEmployeeNumberRequired(event.target.checked)}
              type="checkbox"
            />
            <span>Require an employee number when an HR operator creates a profile</span>
          </label>
          <div className="form-field">
            <label htmlFor="manager-visibility">Manager visibility</label>
            <select
              disabled={!hydrated || Boolean(pending)}
              id="manager-visibility"
              onChange={(event) => setManagerVisibility(event.target.value as "minimized" | "none")}
              value={managerVisibility}
            >
              <option value="minimized">Minimized direct-report profile</option>
              <option value="none">No manager profile visibility</option>
            </select>
            <p className="field-hint">
              This controls current-manager list and detail access; it never grants unrestricted HR
              record access.
            </p>
          </div>
          <label className="settings-choice-row">
            <input
              checked={unlinkedWorkerCreationAllowed}
              disabled={!hydrated || Boolean(pending)}
              onChange={(event) => setUnlinkedWorkerCreationAllowed(event.target.checked)}
              type="checkbox"
            />
            <span>Allow an HR operator to create an unlinked worker profile</span>
          </label>
          <p className="surface-summary">
            An unlinked profile never enables employee self-service. Each save is authorized again.
          </p>
          <div className="form-actions">
            <button
              className="command-button command-button-primary"
              disabled={!hydrated || Boolean(pending)}
              type="submit"
            >
              {pending === "configure" ? (
                <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} />
              ) : null}
              {pending === "configure" ? "Saving..." : "Save Workforce settings"}
            </button>
          </div>
        </form>
      ) : control ? (
        <section aria-labelledby="preserved-workforce-settings" className="leave-detail-section">
          <h2 id="preserved-workforce-settings">Preserved settings</h2>
          <p className="surface-summary">
            Settings remain stored while the service is inactive. Reactivate before changing them.
          </p>
          <dl className="leave-detail-facts">
            <div>
              <dt>Employee number</dt>
              <dd>{control.settings.employeeNumberRequired ? "Required" : "Optional"}</dd>
            </div>
            <div>
              <dt>Manager visibility</dt>
              <dd>{control.settings.managerVisibility === "minimized" ? "Minimized" : "None"}</dd>
            </div>
            <div>
              <dt>Unlinked worker creation</dt>
              <dd>{control.settings.unlinkedWorkerCreationAllowed ? "Allowed" : "Blocked"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {active ? (
        <form
          aria-busy={pending === "deactivate"}
          className="leave-request-form"
          onSubmit={deactivate}
        >
          <h2>Deactivate Workforce Profile</h2>
          <p className="surface-summary">
            Deactivation blocks Workforce Profile behavior without deleting records, settings,
            evidence, or outbox history.
          </p>
          <div className="form-actions">
            <button
              className="command-button command-button-danger"
              disabled={!hydrated || Boolean(pending)}
              type="submit"
            >
              {pending === "deactivate" ? "Deactivating..." : "Deactivate service"}
            </button>
          </div>
        </form>
      ) : (
        <form aria-busy={pending === "activate"} className="leave-request-form" onSubmit={activate}>
          <h2>{control ? "Reactivate Workforce Profile" : "Activate Workforce Profile"}</h2>
          <p className="surface-summary">
            Activation rechecks exact migration, catalogue, dependency, and current tenant-admin
            authority before the service becomes reachable.
          </p>
          <div className="form-actions">
            <button
              className="command-button command-button-primary"
              disabled={!hydrated || Boolean(pending)}
              type="submit"
            >
              {pending === "activate" ? "Activating..." : "Activate service"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
