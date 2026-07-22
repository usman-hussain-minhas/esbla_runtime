"use client";

import type { HrWorkforceStatus, HrWorkforceStatusTarget } from "@esbla/contracts";
import { LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  allowedWorkforceStatusTargets,
  decodeWorkforceMaintenanceTransport,
  validateWorkforceMaintenanceAction,
  type WorkforceMaintenanceAction,
  type WorkforceMaintenanceFormState,
  type WorkforceMaintenanceOperation,
} from "../../../../../../lib/hr-workforce-profile-maintenance-core";

interface WorkforceProfileMaintenanceProps {
  readonly idempotencyKeys: Readonly<Record<WorkforceMaintenanceOperation, string>>;
  readonly initialStatus: HrWorkforceStatus;
  readonly initialVersion: number;
  readonly workerProfileId: string;
}

interface Attempt {
  key: string;
  signature: string | null;
}

const statusLabels: Record<HrWorkforceStatusTarget, string> = {
  active: "Active",
  suspended: "Suspended",
  terminated: "Terminated",
};

function actionPayload(action: WorkforceMaintenanceAction) {
  return action.operation === "status"
    ? {
        expectedVersion: action.body.expectedVersion,
        idempotencyKey: action.idempotencyKey,
        operation: action.operation,
        status: action.body.status,
      }
    : {
        expectedVersion: action.body.expectedVersion,
        idempotencyKey: action.idempotencyKey,
        managerWorkerProfileId: action.body.managerWorkerProfileId,
        operation: action.operation,
      };
}

export function WorkforceProfileMaintenance({
  idempotencyKeys,
  initialStatus,
  initialVersion,
  workerProfileId,
}: WorkforceProfileMaintenanceProps) {
  const [error, setError] = useState<WorkforceMaintenanceFormState>();
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState<WorkforceMaintenanceOperation>();
  const initialTarget = allowedWorkforceStatusTargets(initialStatus)[0] ?? "";
  const [statusTarget, setStatusTarget] = useState<HrWorkforceStatusTarget | "">(initialTarget);
  const attempts = useRef<Record<WorkforceMaintenanceOperation, Attempt>>({
    reporting: { key: idempotencyKeys.reporting, signature: null },
    status: { key: idempotencyKeys.status, signature: null },
  });
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHydrated(true);
    if (error) errorRef.current?.focus();
  }, [error]);

  function idempotencyKey(operation: WorkforceMaintenanceOperation, signature: string) {
    const attempt = attempts.current[operation];
    if (attempt.signature !== null && attempt.signature !== signature) {
      attempt.key = crypto.randomUUID();
    }
    attempt.signature = signature;
    return attempt.key;
  }

  async function run(
    operation: WorkforceMaintenanceOperation,
    signature: string,
    raw: Record<string, unknown>,
  ) {
    if (pending) return;
    const validation = validateWorkforceMaintenanceAction({
      ...raw,
      idempotencyKey: idempotencyKey(operation, signature),
      operation,
    });
    if (!validation.ok) {
      setError(validation.state);
      return;
    }
    setPending(operation);
    setError(undefined);
    const result = await decodeWorkforceMaintenanceTransport(
      fetch(`/workspace/hr/profile/by-id/${encodeURIComponent(workerProfileId)}/action`, {
        body: JSON.stringify(actionPayload(validation.value)),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      }),
      workerProfileId,
      validation.value,
    );
    setPending(undefined);
    if (!result.ok) {
      setError(result.state);
      return;
    }
    window.location.reload();
  }

  function updateStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!statusTarget) return;
    void run("status", `${initialVersion}:${statusTarget}`, {
      expectedVersion: initialVersion,
      status: statusTarget,
    });
  }

  function assignManager(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const managerWorkerProfileId = String(
      new FormData(event.currentTarget).get("managerWorkerProfileId") ?? "",
    ).trim();
    void run("reporting", `${initialVersion}:assigned:${managerWorkerProfileId.toLowerCase()}`, {
      expectedVersion: initialVersion,
      managerWorkerProfileId,
    });
  }

  function removeManager(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("reporting", `${initialVersion}:unassigned`, {
      expectedVersion: initialVersion,
      managerWorkerProfileId: null,
    });
  }

  const nextStatuses = allowedWorkforceStatusTargets(initialStatus);
  return (
    <section aria-labelledby="workforce-maintenance-heading" className="leave-detail-copy">
      <div className="detail-section-heading">
        <ShieldCheck aria-hidden="true" size={20} strokeWidth={1.7} />
        <h2 id="workforce-maintenance-heading">Profile maintenance</h2>
      </div>
      <p className="surface-summary">
        Each update is authorized independently. Viewing this profile does not grant maintenance
        permission.
      </p>

      {error ? (
        <div className="form-error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <TriangleAlert aria-hidden="true" size={19} />
          <p>{error.message}</p>
        </div>
      ) : null}
      {nextStatuses.length > 0 ? (
        <form
          aria-busy={pending === "status"}
          className="leave-request-form"
          onSubmit={updateStatus}
        >
          <div className="form-field">
            <label htmlFor="workforce-status-target">Workforce status</label>
            <select
              aria-describedby={error?.fieldErrors.status ? "workforce-status-error" : undefined}
              aria-invalid={Boolean(error?.fieldErrors.status)}
              disabled={!hydrated || Boolean(pending)}
              id="workforce-status-target"
              onChange={(event) => setStatusTarget(event.target.value as HrWorkforceStatusTarget)}
              value={statusTarget}
            >
              {nextStatuses.map((target) => (
                <option key={target} value={target}>
                  {statusLabels[target]}
                </option>
              ))}
            </select>
            {error?.fieldErrors.status ? (
              <p className="field-error" id="workforce-status-error">
                {error.fieldErrors.status}
              </p>
            ) : null}
          </div>
          <div className="form-actions">
            <button
              className="command-button command-button-primary"
              disabled={!hydrated || Boolean(pending)}
              type="submit"
            >
              {pending === "status" ? (
                <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} />
              ) : null}
              {pending === "status" ? "Updating..." : "Update status"}
            </button>
          </div>
        </form>
      ) : (
        <p className="surface-summary">Terminated is a terminal workforce status.</p>
      )}

      {initialStatus === "active" ? (
        <>
          <form
            aria-busy={pending === "reporting"}
            className="leave-request-form"
            noValidate
            onSubmit={assignManager}
          >
            <div className="form-field">
              <label htmlFor="manager-worker-profile-id">Manager profile ID</label>
              <input
                aria-describedby={
                  error?.fieldErrors.managerWorkerProfileId
                    ? "manager-profile-hint manager-profile-error"
                    : "manager-profile-hint"
                }
                aria-invalid={Boolean(error?.fieldErrors.managerWorkerProfileId)}
                disabled={!hydrated || Boolean(pending)}
                id="manager-worker-profile-id"
                name="managerWorkerProfileId"
                required
              />
              <p className="field-hint" id="manager-profile-hint">
                Enter an exact candidate Worker Profile UUID. Eligibility is checked on submit.
              </p>
              {error?.fieldErrors.managerWorkerProfileId ? (
                <p className="field-error" id="manager-profile-error">
                  {error.fieldErrors.managerWorkerProfileId}
                </p>
              ) : null}
            </div>
            <div className="form-actions">
              <button
                className="command-button command-button-primary"
                disabled={!hydrated || Boolean(pending)}
                type="submit"
              >
                {pending === "reporting" ? (
                  <LoaderCircle aria-hidden="true" className="submit-spinner" size={17} />
                ) : null}
                {pending === "reporting" ? "Updating..." : "Assign manager"}
              </button>
            </div>
          </form>
          <form
            aria-busy={pending === "reporting"}
            className="leave-request-form"
            onSubmit={removeManager}
          >
            <p className="surface-summary">
              Remove the current assignment only when this profile has an assigned manager.
            </p>
            <div className="form-actions">
              <button
                className="command-button command-button-danger"
                disabled={!hydrated || Boolean(pending)}
                type="submit"
              >
                Remove manager
              </button>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
