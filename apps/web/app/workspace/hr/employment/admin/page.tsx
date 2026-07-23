import { randomUUID } from "node:crypto";
import type { HrEmploymentListCursor, HrEmploymentRecordSummary } from "@esbla/contracts";
import { BriefcaseBusiness } from "lucide-react";
import { cookies } from "next/headers";
import {
  EMPLOYMENT_MUTATION_RECEIPT_COOKIE,
  type EmploymentMutationReceipt,
  loadEmploymentList,
  readEmploymentMutationReceipt,
} from "../../../../../lib/hr-employment-record";
import {
  hasEmploymentAction,
  parseEmploymentWorkerSelection,
} from "../../../../../lib/hr-employment-record-core";
import { EmploymentResult } from "../result";

interface EmploymentAdminPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type EmploymentRecordMutationReceipt = Extract<
  EmploymentMutationReceipt,
  { readonly kind: "record" }
>;

const resultCopy = {
  conflict: "The record changed. Reloaded values are shown; preserved history was not changed.",
  denied: "Your current role does not permit that employment-record action.",
  dependency_unavailable: "A required Workforce Profile or activation dependency is unavailable.",
  inactive: "Employment Record is inactive. Existing facts remain preserved.",
  not_found: "The selected employment record or worker profile is not available.",
  operational_error: "The employment-record action could not be completed. Try again.",
  success: "The employment-record action completed. Continuity values are shown below.",
  validation: "Review the submitted employment facts and try again.",
} as const;

function Result({ value }: Readonly<{ value: string | undefined }>) {
  if (!(value && value in resultCopy)) return null;
  const success = value === "success";
  return (
    <EmploymentResult message={resultCopy[value as keyof typeof resultCopy]} success={success} />
  );
}

function employmentAdminHref(
  cursor: HrEmploymentListCursor | null,
  workerProfileId: string | undefined,
): string {
  const query = new URLSearchParams();
  if (cursor) {
    query.set("cursorCreatedAt", cursor.createdAt);
    query.set("cursorEmploymentRecordId", cursor.employmentRecordId);
  }
  if (workerProfileId) query.set("workerProfileId", workerProfileId);
  const value = query.toString();
  return `/workspace/hr/employment/admin${value ? `?${value}` : ""}`;
}

function CreateRecordForm({ workerProfileId }: Readonly<{ workerProfileId: string | undefined }>) {
  return (
    <form action="/workspace/hr/employment/action" className="leave-request-form" method="post">
      <input name="operation" type="hidden" value="create_record" />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
      <div className="form-field">
        <label htmlFor="employment-worker-profile">Worker Profile ID</label>
        <input
          autoComplete="off"
          defaultValue={workerProfileId}
          id="employment-worker-profile"
          name="workerProfileId"
          pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
          required
          spellCheck={false}
          type="text"
        />
        <p className="field-hint">
          Choose an eligible profile from the authorized Workforce directory. Current eligibility
          and duplicate-record protection are rechecked atomically.
        </p>
      </div>
      <div className="work-queue-actions">
        <a className="command-button" href="/workspace/hr/profile/admin">
          Open Workforce directory
        </a>
        <button className="command-button command-button-primary" type="submit">
          Create employment record
        </button>
      </div>
    </form>
  );
}

function VersionFields({ record }: Readonly<{ record: HrEmploymentRecordSummary }>) {
  const prefix = record.employmentRecordId;
  return (
    <form action="/workspace/hr/employment/action" className="leave-request-form" method="post">
      <input name="operation" type="hidden" value="create_version" />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
      <input name="employmentRecordId" type="hidden" value={record.employmentRecordId} />
      <input name="expectedVersion" type="hidden" value={record.version} />
      <input
        name="expectedCurrentVersion"
        type="hidden"
        value={record.currentVersion?.version ?? ""}
      />
      <div className="form-grid-two">
        <div className="form-field">
          <label htmlFor={`${prefix}-effective-from`}>Effective from</label>
          <input id={`${prefix}-effective-from`} name="effectiveFrom" required type="date" />
        </div>
        <div className="form-field">
          <label htmlFor={`${prefix}-effective-to`}>Effective to</label>
          <input id={`${prefix}-effective-to`} name="effectiveTo" type="date" />
          <p className="field-hint">Leave blank only for an open-ended final effective head.</p>
        </div>
        <div className="form-field">
          <label htmlFor={`${prefix}-employment-type`}>Employment type code</label>
          <input id={`${prefix}-employment-type`} name="employmentTypeCode" type="text" />
        </div>
        <div className="form-field">
          <label htmlFor={`${prefix}-organization`}>Organization reference</label>
          <input id={`${prefix}-organization`} name="organizationReference" type="text" />
        </div>
        <div className="form-field">
          <label htmlFor={`${prefix}-position`}>Position reference</label>
          <input id={`${prefix}-position`} name="positionReference" type="text" />
        </div>
      </div>
      <button className="command-button command-button-primary" type="submit">
        {record.status === "draft"
          ? "Establish first effective version"
          : "Append effective successor"}
      </button>
    </form>
  );
}

function EndFields({ record }: Readonly<{ record: HrEmploymentRecordSummary }>) {
  if (!record.currentVersion) return null;
  return (
    <form action="/workspace/hr/employment/action" className="leave-request-form" method="post">
      <input name="operation" type="hidden" value="end_record" />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
      <input name="employmentRecordId" type="hidden" value={record.employmentRecordId} />
      <input name="expectedVersion" type="hidden" value={record.version} />
      <input name="expectedCurrentVersion" type="hidden" value={record.currentVersion.version} />
      <div className="form-field">
        <label htmlFor={`${record.employmentRecordId}-end-date`}>Exact end date</label>
        <input
          id={`${record.employmentRecordId}-end-date`}
          name="effectiveTo"
          required
          type="date"
        />
      </div>
      <button className="command-button command-button-danger" type="submit">
        End employment record
      </button>
    </form>
  );
}

function ManualVersionForm({
  receipt,
}: Readonly<{ receipt: EmploymentRecordMutationReceipt | null }>) {
  return (
    <form action="/workspace/hr/employment/action" className="leave-request-form" method="post">
      <input name="operation" type="hidden" value="create_version" />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
      <div className="form-grid-two">
        <div className="form-field">
          <label htmlFor="manual-version-record-id">Employment Record ID</label>
          <input
            defaultValue={receipt?.employmentRecordId}
            id="manual-version-record-id"
            name="employmentRecordId"
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
            required
            type="text"
          />
        </div>
        <div className="form-field">
          <label htmlFor="manual-version-root-version">Expected root version</label>
          <input
            defaultValue={receipt?.rootVersion}
            id="manual-version-root-version"
            min="1"
            name="expectedVersion"
            required
            type="number"
          />
        </div>
        <div className="form-field">
          <label htmlFor="manual-version-current-version">Expected current effective version</label>
          <input
            defaultValue={receipt?.currentVersion ?? ""}
            id="manual-version-current-version"
            min="1"
            name="expectedCurrentVersion"
            type="number"
          />
          <p className="field-hint">
            Leave blank only when establishing a draft record's first version.
          </p>
        </div>
        <div className="form-field">
          <label htmlFor="manual-version-effective-from">Effective from</label>
          <input id="manual-version-effective-from" name="effectiveFrom" required type="date" />
        </div>
        <div className="form-field">
          <label htmlFor="manual-version-effective-to">Effective to</label>
          <input id="manual-version-effective-to" name="effectiveTo" type="date" />
        </div>
        <div className="form-field">
          <label htmlFor="manual-version-employment-type">Employment type code</label>
          <input id="manual-version-employment-type" name="employmentTypeCode" type="text" />
        </div>
        <div className="form-field">
          <label htmlFor="manual-version-organization">Organization reference</label>
          <input id="manual-version-organization" name="organizationReference" type="text" />
        </div>
        <div className="form-field">
          <label htmlFor="manual-version-position">Position reference</label>
          <input id="manual-version-position" name="positionReference" type="text" />
        </div>
      </div>
      <button className="command-button command-button-primary" type="submit">
        Append exact effective version
      </button>
    </form>
  );
}

function ManualEndForm({ receipt }: Readonly<{ receipt: EmploymentRecordMutationReceipt | null }>) {
  return (
    <form action="/workspace/hr/employment/action" className="leave-request-form" method="post">
      <input name="operation" type="hidden" value="end_record" />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
      <div className="form-grid-two">
        <div className="form-field">
          <label htmlFor="manual-end-record-id">Employment Record ID</label>
          <input
            defaultValue={receipt?.employmentRecordId}
            id="manual-end-record-id"
            name="employmentRecordId"
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
            required
            type="text"
          />
        </div>
        <div className="form-field">
          <label htmlFor="manual-end-root-version">Expected root version</label>
          <input
            defaultValue={receipt?.rootVersion}
            id="manual-end-root-version"
            min="1"
            name="expectedVersion"
            required
            type="number"
          />
        </div>
        <div className="form-field">
          <label htmlFor="manual-end-current-version">Expected current effective version</label>
          <input
            defaultValue={receipt?.currentVersion ?? ""}
            id="manual-end-current-version"
            min="1"
            name="expectedCurrentVersion"
            required
            type="number"
          />
        </div>
        <div className="form-field">
          <label htmlFor="manual-end-effective-to">Exact end date</label>
          <input id="manual-end-effective-to" name="effectiveTo" required type="date" />
        </div>
      </div>
      <button className="command-button command-button-danger" type="submit">
        End exact employment record
      </button>
    </form>
  );
}

export default async function EmploymentAdminPage({ searchParams }: EmploymentAdminPageProps) {
  const [parameters, cookieStore] = await Promise.all([searchParams, cookies()]);
  let workerProfileId: string | undefined;
  let invalidWorkerSelection = false;
  try {
    workerProfileId = parseEmploymentWorkerSelection(parameters.workerProfileId);
  } catch {
    invalidWorkerSelection = true;
  }
  const employment = await loadEmploymentList({
    cursorCreatedAt: parameters.cursorCreatedAt,
    cursorEmploymentRecordId: parameters.cursorEmploymentRecordId,
  });
  const result = invalidWorkerSelection
    ? "validation"
    : Array.isArray(parameters.result)
      ? undefined
      : parameters.result;
  const canCreate = hasEmploymentAction(employment.authorizedActions, "create_record");
  const canCreateVersion = hasEmploymentAction(employment.authorizedActions, "create_version");
  const canEnd = hasEmploymentAction(employment.authorizedActions, "end_record");
  const canList = hasEmploymentAction(employment.authorizedActions, "list_authorized");
  const canViewDetail = hasEmploymentAction(employment.authorizedActions, "view_detail");
  const hasMutationAction = canCreate || canCreateVersion || canEnd;
  const mutationReceipt =
    result === "success"
      ? readEmploymentMutationReceipt(
          cookieStore.get(EMPLOYMENT_MUTATION_RECEIPT_COOKIE)?.value,
          "admin",
        )
      : null;
  const recordReceipt =
    mutationReceipt?.kind === "record" &&
    hasEmploymentAction(employment.authorizedActions, mutationReceipt.operation)
      ? mutationReceipt
      : null;
  const visibleResult = result === "success" && !recordReceipt ? "operational_error" : result;
  const hasTenantList = employment.status === "success" && employment.page.accessScope === "tenant";
  const hasAdminAccess = hasMutationAction;
  const records = hasTenantList ? employment.page.items : [];
  const hasCursor =
    typeof parameters.cursorCreatedAt === "string" &&
    typeof parameters.cursorEmploymentRecordId === "string";

  return (
    <section aria-labelledby="employment-admin-heading" className="work-surface leave-form-surface">
      <a
        className="text-command detail-back"
        href={canList ? "/workspace/hr/employment" : "/workspace/hr"}
      >
        {canList ? "Back to employment records" : "Back to HR"}
      </a>
      <header className="surface-heading">
        <div>
          <p className="surface-label">HR administration</p>
          <h1 id="employment-admin-heading">Employment record administration</h1>
          <p className="surface-summary">
            Create roots, append non-overlapping immutable versions, or record an exact end fact.
            These actions carry no compensation, document, payroll, or legal meaning.
          </p>
        </div>
      </header>
      {!hasAdminAccess ? (
        <section
          aria-labelledby="employment-admin-unavailable"
          className="leave-list-error"
          role="alert"
        >
          <h2 id="employment-admin-unavailable">
            {employment.status === "success" ? "Employment records unavailable" : employment.title}
          </h2>
          <p>
            {employment.status === "success"
              ? "Your current role does not permit employment-record administration."
              : employment.message}
          </p>
        </section>
      ) : (
        <>
          <Result value={visibleResult} />
          {recordReceipt ? (
            <section
              aria-labelledby="employment-mutation-receipt-heading"
              className="leave-detail-section"
              role="status"
            >
              <h2 id="employment-mutation-receipt-heading">Last mutation receipt</h2>
              <dl className="leave-detail-facts">
                <div>
                  <dt>Employment Record ID</dt>
                  <dd>{recordReceipt.employmentRecordId}</dd>
                </div>
                <div>
                  <dt>Root version</dt>
                  <dd>{recordReceipt.rootVersion}</dd>
                </div>
                <div>
                  <dt>Current effective version</dt>
                  <dd>{recordReceipt.currentVersion ?? "Not established"}</dd>
                </div>
                <div>
                  <dt>Record status</dt>
                  <dd>{recordReceipt.status}</dd>
                </div>
              </dl>
            </section>
          ) : null}
          {employment.status !== "success" ? (
            <section className="leave-list-error" role="alert">
              <h2>{employment.title}</h2>
              <p>{employment.message}</p>
            </section>
          ) : null}
          {canCreate ? (
            <section aria-labelledby="employment-create-heading" className="leave-detail-section">
              <div className="detail-section-heading">
                <BriefcaseBusiness aria-hidden="true" size={20} strokeWidth={1.7} />
                <h2 id="employment-create-heading">Create a draft record</h2>
              </div>
              <CreateRecordForm workerProfileId={workerProfileId} />
            </section>
          ) : null}

          {hasTenantList || canCreateVersion || canEnd ? (
            <section aria-labelledby="employment-maintain-heading" className="leave-detail-section">
              <h2 id="employment-maintain-heading">Maintain effective facts</h2>
              {!hasTenantList ? (
                <>
                  <p>
                    Record data is not available through this authority snapshot. Enter only exact
                    current identifiers and versions; the server rechecks every action.
                  </p>
                  {canCreateVersion ? (
                    <ManualVersionForm
                      receipt={recordReceipt?.status === "ended" ? null : recordReceipt}
                    />
                  ) : null}
                  {canEnd ? (
                    <ManualEndForm
                      receipt={recordReceipt?.status === "active" ? recordReceipt : null}
                    />
                  ) : null}
                </>
              ) : records.length === 0 ? (
                <p>No employment record has been created.</p>
              ) : (
                <ol className="work-queue">
                  {records.map((record) => (
                    <li className="work-queue-item" key={record.employmentRecordId}>
                      <div className="work-queue-primary">
                        <div>
                          <p className="work-queue-kicker">{record.status} record</p>
                          <h3>{record.workerProfileId}</h3>
                          <p className="work-queue-dates">
                            Root version {record.version}; current effective version{" "}
                            {record.currentVersion?.version ?? "not established"}
                          </p>
                        </div>
                        {canViewDetail ? (
                          <a
                            className="text-command"
                            href={`/workspace/hr/employment/by-id/${encodeURIComponent(
                              record.employmentRecordId,
                            )}`}
                          >
                            View immutable history
                          </a>
                        ) : null}
                      </div>
                      {canCreateVersion &&
                      (record.status === "draft" ||
                        (record.status === "active" && record.currentVersion?.effectiveTo)) ? (
                        <VersionFields record={record} />
                      ) : canCreateVersion && record.status === "active" ? (
                        <p className="field-hint">
                          This head is open ended and immutable. End the record rather than
                          overlapping it with another effective version.
                        </p>
                      ) : null}
                      {canEnd && record.status === "active" ? <EndFields record={record} /> : null}
                    </li>
                  ))}
                </ol>
              )}
              {hasTenantList && (employment.page.nextCursor || hasCursor) ? (
                <nav aria-label="Employment record pages" className="list-pagination">
                  {hasCursor ? (
                    <a className="text-command" href={employmentAdminHref(null, workerProfileId)}>
                      Start over
                    </a>
                  ) : (
                    <span />
                  )}
                  {employment.page.nextCursor ? (
                    <a
                      className="text-command"
                      href={employmentAdminHref(employment.page.nextCursor, workerProfileId)}
                    >
                      Next page
                    </a>
                  ) : null}
                </nav>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
