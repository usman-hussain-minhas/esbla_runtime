import {
  assertPolicyAllowed,
  evaluatePolicy,
  type OperationContext,
  PlatformError,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import { hrManifest } from "./manifest.js";
import {
  HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
  type HrShiftAssignment,
  HrShiftAssignmentError,
} from "./shift-assignment.js";

export type ShiftAssignmentAccessScope = "assigned" | "own" | "tenant";
export type ShiftAssignmentCursor = Readonly<{ shiftAssignmentId: string; startsAt: string }>;
export type ListAuthorizedShiftAssignmentsOptions =
  | Readonly<{
      cursor?: ShiftAssignmentCursor;
      mode: "own";
      pageSize?: number;
      rangeEnd: string;
      rangeStart: string;
    }>
  | Readonly<{
      cursor?: ShiftAssignmentCursor;
      mode: "roster";
      pageSize?: number;
      rosterVersionId: string;
      status: "active" | "cancelled";
    }>;
export interface AuthorizedShiftAssignmentList {
  readonly accessScope: ShiftAssignmentAccessScope;
  readonly items: readonly HrShiftAssignment[];
  readonly nextCursor: ShiftAssignmentCursor | null;
}
export interface ShiftAssignmentEvidenceEvent {
  readonly eventType: "hr.shift_assignment.assign_shift" | "hr.shift_assignment.cancel_assignment";
  readonly newState: "active" | "cancelled";
  readonly occurredAt: string;
  readonly priorState: "active" | null;
}
export type AuthorizedShiftAssignmentDetail = Readonly<{
  assignment: HrShiftAssignment;
  history: readonly ShiftAssignmentEvidenceEvent[];
}>;

interface AssignmentRow {
  readonly ends_at: Date | string;
  readonly iana_timezone: string;
  readonly roster_status: "draft" | "published" | "superseded";
  readonly roster_version_id: string;
  readonly row_version: number;
  readonly shift_assignment_id: string;
  readonly starts_at: Date | string;
  readonly status: "active" | "cancelled";
  readonly worker_profile_id: string;
}
interface EvidenceRow {
  readonly event_type: "hr.shift_assignment.assign_shift" | "hr.shift_assignment.cancel_assignment";
  readonly new_state: "active" | "cancelled";
  readonly occurred_at: Date | string;
  readonly prior_state: "active" | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSIGNMENT_COLUMNS = `assignment.shift_assignment_id,assignment.roster_version_id,
  assignment.worker_profile_id,assignment.starts_at,assignment.ends_at,
  assignment.iana_timezone,assignment.status,assignment.row_version,
  roster.status AS roster_status`;

function deny(): never {
  throw new PlatformError("POLICY_DENIED", "Policy decision denied the action");
}
function notFound(): never {
  throw new HrShiftAssignmentError("SHIFT_NOT_FOUND", "Shift assignment was not found");
}
function inputInvalid(message: string): never {
  throw new HrShiftAssignmentError("SHIFT_INPUT_INVALID", message);
}
function isPostgresCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    codes.includes(String((error as { code?: unknown }).code))
  );
}
function normalizeUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) inputInvalid(`${field} must be a UUID`);
  return value.toLowerCase();
}
function instant(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    !/[zZ]|[+-]\d\d:\d\d$/.test(value)
  ) {
    inputInvalid(`${field} must be a timezone-aware instant`);
  }
  return new Date(value).toISOString();
}
function pageSize(value: number | undefined): number {
  const selected = value ?? 50;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 50) {
    inputInvalid("pageSize must be an integer from 1 through 50");
  }
  return selected;
}
function cursor(value: ShiftAssignmentCursor | undefined): ShiftAssignmentCursor | undefined {
  if (!value) return undefined;
  return {
    shiftAssignmentId: normalizeUuid(value.shiftAssignmentId, "cursor.shiftAssignmentId"),
    startsAt: instant(value.startsAt, "cursor.startsAt"),
  };
}
function iso(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) {
    throw new HrShiftAssignmentError("SHIFT_CONFLICT", "Stored Shift instant is invalid");
  }
  return result;
}
function assignment(row: AssignmentRow): HrShiftAssignment {
  if (
    !UUID_PATTERN.test(row.shift_assignment_id) ||
    !UUID_PATTERN.test(row.roster_version_id) ||
    !UUID_PATTERN.test(row.worker_profile_id) ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < 1
  ) {
    throw new HrShiftAssignmentError("SHIFT_CONFLICT", "Stored Shift assignment is invalid");
  }
  return {
    endsAt: iso(row.ends_at),
    ianaTimezone: row.iana_timezone,
    rosterVersionId: row.roster_version_id,
    shiftAssignmentId: row.shift_assignment_id,
    startsAt: iso(row.starts_at),
    status: row.status,
    version: row.row_version,
    workerProfileId: row.worker_profile_id,
  };
}

async function withShiftRead<T>(
  pool: Pool,
  context: OperationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withTenantTransaction(
      pool,
      context,
      async (transaction) => {
        if (transaction.lockedServiceActivation?.state !== "active") {
          throw new HrShiftAssignmentError(
            "SHIFT_SERVICE_INACTIVE",
            "Shift Assignment service is inactive",
          );
        }
        const workforce = await transaction.client.query<{ state: string }>(
          `SELECT state FROM service_activations
           WHERE tenant_id=$1 AND service_key='workforce_profile' FOR SHARE NOWAIT`,
          [transaction.context.tenantId],
        );
        if (workforce.rows[0]?.state !== "active") {
          throw new HrShiftAssignmentError(
            "SHIFT_DEPENDENCY_INACTIVE",
            "Shift Assignment dependency is unavailable",
          );
        }
        return await operation(transaction);
      },
      {
        serviceActivationKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
        serviceActivationLock: "share",
      },
    );
  } catch (error) {
    if (error instanceof HrShiftAssignmentError || error instanceof PlatformError) throw error;
    if (isPostgresCode(error, "40001", "40P01", "55P03")) {
      throw new HrShiftAssignmentError(
        "SHIFT_VERSION_CONFLICT",
        "Shift Assignment read currentness check failed",
      );
    }
    throw error;
  }
}

async function authorizeRead(
  transaction: TenantTransaction,
  action: "list_roster" | "view_detail",
  role: "employee" | "hr_operator" | "manager",
): Promise<void> {
  const actionKey = `hr.shift.${action}`;
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "tenant" && id === actionKey,
  );
  const capability = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  assertPolicyAllowed(
    evaluatePolicy(
      {
        actionKey,
        input: { capabilityCurrent: registered && capability.rows.length === 1, role },
        resourceKey: HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
        transaction,
      },
      [
        {
          effect: "allow",
          id: `current_${role}_${action}`,
          matches: (input, actor) =>
            actor.roleKey === input.role && input.capabilityCurrent === true,
        },
      ],
    ),
    transaction,
    actionKey,
    HR_SHIFT_ASSIGNMENT_SERVICE_KEY,
  );
}

async function activeActorProfile(
  transaction: TenantTransaction,
  lock: boolean = true,
): Promise<string> {
  const result = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id FROM hr_worker_profiles
     WHERE tenant_id=$1 AND principal_id=$2 AND workforce_status='active'
     ORDER BY worker_profile_id LIMIT 2 ${lock ? "FOR SHARE" : ""}`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId],
  );
  if (result.rows.length !== 1 || !result.rows[0]) deny();
  return result.rows[0].worker_profile_id;
}

async function lockProfiles(
  transaction: TenantTransaction,
  profileIds: readonly string[],
): Promise<void> {
  const selected = [...new Set(profileIds)].sort();
  const result = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT worker_profile_id FROM hr_worker_profiles
     WHERE tenant_id=$1 AND worker_profile_id=ANY($2::uuid[])
     ORDER BY worker_profile_id FOR SHARE`,
    [transaction.context.tenantId, selected],
  );
  if (result.rows.length !== selected.length) notFound();
}

async function lockAssignments(
  transaction: TenantTransaction,
  shiftAssignmentIds: readonly string[],
): Promise<void> {
  const selected = [...new Set(shiftAssignmentIds)];
  if (selected.length === 0) return;
  const result = await transaction.client.query<{ shift_assignment_id: string }>(
    `SELECT shift_assignment_id FROM hr_shift_assignments
     WHERE tenant_id=$1 AND shift_assignment_id=ANY($2::uuid[])
     ORDER BY worker_profile_id,starts_at,shift_assignment_id FOR SHARE`,
    [transaction.context.tenantId, selected],
  );
  if (result.rows.length !== selected.length) {
    throw new HrShiftAssignmentError(
      "SHIFT_CONFLICT",
      "Shift Assignment list changed during authorization",
    );
  }
}

async function isCurrentReport(
  transaction: TenantTransaction,
  managerWorkerProfileId: string,
  workerProfileId: string,
): Promise<boolean> {
  const result = await transaction.client.query(
    `SELECT 1 FROM hr_worker_profiles profile
     JOIN hr_reporting_relationships relationship
       ON relationship.tenant_id=profile.tenant_id
      AND relationship.worker_profile_id=profile.worker_profile_id
      AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
     WHERE profile.tenant_id=$1 AND profile.worker_profile_id=$2
       AND profile.workforce_status='active'
       AND relationship.manager_worker_profile_id=$3
       AND relationship.relationship_status='assigned' LIMIT 1`,
    [transaction.context.tenantId, workerProfileId, managerWorkerProfileId],
  );
  return result.rows.length === 1;
}

async function currentReportCandidate(
  transaction: TenantTransaction,
  managerWorkerProfileId: string,
): Promise<string | null> {
  const result = await transaction.client.query<{ worker_profile_id: string }>(
    `SELECT profile.worker_profile_id FROM hr_worker_profiles profile
     JOIN hr_reporting_relationships relationship
       ON relationship.tenant_id=profile.tenant_id
      AND relationship.worker_profile_id=profile.worker_profile_id
      AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
     WHERE profile.tenant_id=$1 AND profile.workforce_status='active'
       AND relationship.manager_worker_profile_id=$2
       AND relationship.relationship_status='assigned'
     ORDER BY profile.worker_profile_id LIMIT 1`,
    [transaction.context.tenantId, managerWorkerProfileId],
  );
  return result.rows[0]?.worker_profile_id ?? null;
}

async function isCurrentActorProfile(
  transaction: TenantTransaction,
  workerProfileId: string,
): Promise<boolean> {
  const result = await transaction.client.query(
    `SELECT 1 FROM hr_worker_profiles
     WHERE tenant_id=$1 AND worker_profile_id=$2 AND principal_id=$3
       AND workforce_status='active'`,
    [transaction.context.tenantId, workerProfileId, transaction.context.actorPrincipalId],
  );
  return result.rows.length === 1;
}

async function listOwn(
  transaction: TenantTransaction,
  options: Extract<ListAuthorizedShiftAssignmentsOptions, { mode: "own" }>,
  limit: number,
  selectedCursor: ShiftAssignmentCursor | undefined,
): Promise<AuthorizedShiftAssignmentList> {
  if (transaction.actor.roleKey !== "employee") deny();
  await authorizeRead(transaction, "list_roster", "employee");
  const workerProfileId = await activeActorProfile(transaction);
  const rangeStart = instant(options.rangeStart, "rangeStart");
  const rangeEnd = instant(options.rangeEnd, "rangeEnd");
  if (rangeEnd <= rangeStart) inputInvalid("rangeEnd must follow rangeStart");
  const values: unknown[] = [transaction.context.tenantId, workerProfileId, rangeEnd, rangeStart];
  const cursorPredicate = selectedCursor
    ? `AND (assignment.starts_at,assignment.shift_assignment_id)>
       ($5::timestamptz,$6::uuid)`
    : "";
  if (selectedCursor) values.push(selectedCursor.startsAt, selectedCursor.shiftAssignmentId);
  values.push(limit);
  const result = await transaction.client.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM hr_shift_assignments assignment
     JOIN hr_shift_roster_versions roster
       ON roster.tenant_id=assignment.tenant_id
      AND roster.roster_version_id=assignment.roster_version_id
     WHERE assignment.tenant_id=$1 AND assignment.worker_profile_id=$2
       AND roster.status='published'
       AND assignment.starts_at<$3::timestamptz AND assignment.ends_at>$4::timestamptz
       ${cursorPredicate}
     ORDER BY assignment.starts_at,assignment.shift_assignment_id
     LIMIT $${values.length}`,
    values,
  );
  return page("own", result.rows, limit);
}

async function listRoster(
  transaction: TenantTransaction,
  options: Extract<ListAuthorizedShiftAssignmentsOptions, { mode: "roster" }>,
  limit: number,
  selectedCursor: ShiftAssignmentCursor | undefined,
): Promise<AuthorizedShiftAssignmentList> {
  const rosterVersionId = normalizeUuid(options.rosterVersionId, "rosterVersionId");
  const role = transaction.actor.roleKey;
  if (role !== "manager" && role !== "hr_operator") deny();
  await authorizeRead(transaction, "list_roster", role);
  const managerWorkerProfileId =
    role === "manager" ? await activeActorProfile(transaction, false) : null;
  const roster = await transaction.client.query<{ status: string }>(
    `SELECT status FROM hr_shift_roster_versions
     WHERE tenant_id=$1 AND roster_version_id=$2 FOR SHARE`,
    [transaction.context.tenantId, rosterVersionId],
  );
  if (
    !roster.rows[0] ||
    (managerWorkerProfileId !== null && roster.rows[0].status !== "published")
  ) {
    if (managerWorkerProfileId !== null) {
      await lockProfiles(transaction, [managerWorkerProfileId]);
      if (!(await isCurrentActorProfile(transaction, managerWorkerProfileId))) deny();
    }
    notFound();
  }
  if (managerWorkerProfileId) {
    const values: unknown[] = [
      transaction.context.tenantId,
      rosterVersionId,
      options.status,
      managerWorkerProfileId,
    ];
    const cursorPredicate = selectedCursor
      ? `AND (assignment.starts_at,assignment.shift_assignment_id)>($5::timestamptz,$6::uuid)`
      : "";
    if (selectedCursor) values.push(selectedCursor.startsAt, selectedCursor.shiftAssignmentId);
    values.push(limit);
    const readManagerPage = () =>
      transaction.client.query<AssignmentRow>(
        `SELECT ${ASSIGNMENT_COLUMNS}
       FROM hr_shift_assignments assignment
       JOIN hr_shift_roster_versions roster
         ON roster.tenant_id=assignment.tenant_id
        AND roster.roster_version_id=assignment.roster_version_id
       JOIN hr_worker_profiles profile
         ON profile.tenant_id=assignment.tenant_id
        AND profile.worker_profile_id=assignment.worker_profile_id
       JOIN hr_reporting_relationships relationship
         ON relationship.tenant_id=profile.tenant_id
        AND relationship.worker_profile_id=profile.worker_profile_id
        AND relationship.reporting_relationship_id=profile.current_reporting_relationship_id
       WHERE assignment.tenant_id=$1 AND assignment.roster_version_id=$2
         AND assignment.status=$3 AND profile.workforce_status='active'
         AND relationship.manager_worker_profile_id=$4
         AND relationship.relationship_status='assigned' ${cursorPredicate}
       ORDER BY assignment.starts_at,assignment.shift_assignment_id
       LIMIT $${values.length}`,
        values,
      );
    const candidates = await readManagerPage();
    if (candidates.rows.length === 0) {
      const reportWorkerProfileId = await currentReportCandidate(
        transaction,
        managerWorkerProfileId,
      );
      await lockProfiles(transaction, [
        managerWorkerProfileId,
        ...(reportWorkerProfileId ? [reportWorkerProfileId] : []),
      ]);
      if (!(await isCurrentActorProfile(transaction, managerWorkerProfileId))) deny();
      if (
        !reportWorkerProfileId ||
        !(await isCurrentReport(transaction, managerWorkerProfileId, reportWorkerProfileId))
      ) {
        notFound();
      }
      return { accessScope: "assigned", items: [], nextCursor: null };
    }
    await lockProfiles(transaction, [
      managerWorkerProfileId,
      ...candidates.rows.map(({ worker_profile_id }) => worker_profile_id),
    ]);
    if (!(await isCurrentActorProfile(transaction, managerWorkerProfileId))) deny();
    await lockAssignments(
      transaction,
      candidates.rows.map(({ shift_assignment_id }) => shift_assignment_id),
    );
    const result = await readManagerPage();
    if (
      result.rows.length !== candidates.rows.length ||
      result.rows.some(
        ({ shift_assignment_id }, index) =>
          shift_assignment_id !== candidates.rows[index]?.shift_assignment_id,
      )
    ) {
      throw new HrShiftAssignmentError(
        "SHIFT_CONFLICT",
        "Shift Assignment list changed during authorization",
      );
    }
    return page("assigned", result.rows, limit);
  }
  const values: unknown[] = [transaction.context.tenantId, rosterVersionId, options.status];
  const cursorOffset = values.length + 1;
  const cursorPredicate = selectedCursor
    ? `AND (assignment.starts_at,assignment.shift_assignment_id)>
       ($${cursorOffset}::timestamptz,$${cursorOffset + 1}::uuid)`
    : "";
  if (selectedCursor) values.push(selectedCursor.startsAt, selectedCursor.shiftAssignmentId);
  values.push(limit);
  const candidate = await transaction.client.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM hr_shift_assignments assignment
     JOIN hr_shift_roster_versions roster
       ON roster.tenant_id=assignment.tenant_id
      AND roster.roster_version_id=assignment.roster_version_id
     WHERE assignment.tenant_id=$1 AND assignment.roster_version_id=$2
       AND assignment.status=$3 ${cursorPredicate}
     ORDER BY assignment.starts_at,assignment.shift_assignment_id
     LIMIT $${values.length}`,
    values,
  );
  if (candidate.rows.length === 0) {
    return { accessScope: "tenant", items: [], nextCursor: null };
  }
  await lockAssignments(
    transaction,
    candidate.rows.map(({ shift_assignment_id }) => shift_assignment_id),
  );
  const result = await transaction.client.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM hr_shift_assignments assignment
     JOIN hr_shift_roster_versions roster
       ON roster.tenant_id=assignment.tenant_id
      AND roster.roster_version_id=assignment.roster_version_id
     WHERE assignment.tenant_id=$1 AND assignment.roster_version_id=$2
       AND assignment.status=$3 ${cursorPredicate}
     ORDER BY assignment.starts_at,assignment.shift_assignment_id
     LIMIT $${values.length}`,
    values,
  );
  if (
    result.rows.length !== candidate.rows.length ||
    result.rows.some(
      ({ shift_assignment_id }, index) =>
        shift_assignment_id !== candidate.rows[index]?.shift_assignment_id,
    )
  ) {
    throw new HrShiftAssignmentError(
      "SHIFT_CONFLICT",
      "Shift Assignment list changed during authorization",
    );
  }
  return page("tenant", result.rows, limit);
}

function page(
  accessScope: ShiftAssignmentAccessScope,
  selected: readonly AssignmentRow[],
  limit: number,
): AuthorizedShiftAssignmentList {
  const rows = selected.slice(0, limit);
  const last = rows.length === limit ? rows.at(-1) : undefined;
  return {
    accessScope,
    items: rows.map(assignment),
    nextCursor: last
      ? { shiftAssignmentId: last.shift_assignment_id, startsAt: iso(last.starts_at) }
      : null,
  };
}

export async function listAuthorizedShiftAssignments(
  pool: Pool,
  context: OperationContext,
  options: ListAuthorizedShiftAssignmentsOptions,
): Promise<AuthorizedShiftAssignmentList> {
  const limit = pageSize(options.pageSize);
  const selectedCursor = cursor(options.cursor);
  return await withShiftRead(pool, context, async (transaction) =>
    options.mode === "own"
      ? listOwn(transaction, options, limit, selectedCursor)
      : listRoster(transaction, options, limit, selectedCursor),
  );
}

async function detailAuthority(
  transaction: TenantTransaction,
  role: "employee" | "hr_operator" | "manager",
  actorProfileId: string | null,
  workerProfileId: string,
  rosterStatus: AssignmentRow["roster_status"],
): Promise<void> {
  if (role === "employee") {
    if (rosterStatus !== "published" || actorProfileId !== workerProfileId) notFound();
    await lockProfiles(transaction, [workerProfileId]);
    if (!(await isCurrentActorProfile(transaction, workerProfileId))) notFound();
    return;
  }
  if (role === "manager") {
    if (rosterStatus !== "published") notFound();
    if (!actorProfileId || !(await isCurrentReport(transaction, actorProfileId, workerProfileId))) {
      notFound();
    }
    await lockProfiles(transaction, [actorProfileId, workerProfileId]);
    if (
      !(await isCurrentActorProfile(transaction, actorProfileId)) ||
      !(await isCurrentReport(transaction, actorProfileId, workerProfileId))
    ) {
      notFound();
    }
    return;
  }
}

async function history(
  transaction: TenantTransaction,
  current: HrShiftAssignment,
): Promise<readonly ShiftAssignmentEvidenceEvent[]> {
  const result = await transaction.client.query<EvidenceRow>(
    `SELECT event_type,prior_state,new_state,occurred_at
     FROM evidence_events
     WHERE tenant_id=$1 AND subject_type='hr.shift_assignment' AND subject_id=$2
       AND event_type=ANY($3::text[])
     ORDER BY occurred_at,evidence_event_id LIMIT 3`,
    [
      transaction.context.tenantId,
      current.shiftAssignmentId,
      ["hr.shift_assignment.assign_shift", "hr.shift_assignment.cancel_assignment"],
    ],
  );
  const rows = result.rows;
  const valid =
    (rows.length === 1 || rows.length === 2) &&
    rows[0]?.event_type === "hr.shift_assignment.assign_shift" &&
    rows[0].prior_state === null &&
    rows[0].new_state === "active" &&
    (rows.length === 1 ||
      (rows[1]?.event_type === "hr.shift_assignment.cancel_assignment" &&
        rows[1].prior_state === "active" &&
        rows[1].new_state === "cancelled")) &&
    rows.at(-1)?.new_state === current.status;
  if (!valid) {
    throw new HrShiftAssignmentError("SHIFT_CONFLICT", "Shift Assignment history is inconsistent");
  }
  return rows.map((row) => ({
    eventType: row.event_type,
    newState: row.new_state,
    occurredAt: iso(row.occurred_at),
    priorState: row.prior_state,
  }));
}

export async function getAuthorizedShiftAssignmentDetail(
  pool: Pool,
  context: OperationContext,
  shiftAssignmentId: string,
): Promise<AuthorizedShiftAssignmentDetail> {
  const selectedId = normalizeUuid(shiftAssignmentId, "shiftAssignmentId");
  return await withShiftRead(pool, context, async (transaction) => {
    const role = transaction.actor.roleKey;
    if (role !== "employee" && role !== "manager" && role !== "hr_operator") deny();
    await authorizeRead(transaction, "view_detail", role);
    const actorProfileId =
      role === "hr_operator" ? null : await activeActorProfile(transaction, false);
    const candidate = await transaction.client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS}
       FROM hr_shift_assignments assignment
       JOIN hr_shift_roster_versions roster
         ON roster.tenant_id=assignment.tenant_id
        AND roster.roster_version_id=assignment.roster_version_id
       WHERE assignment.tenant_id=$1 AND assignment.shift_assignment_id=$2`,
      [transaction.context.tenantId, selectedId],
    );
    const preliminary = candidate.rows[0];
    if (!preliminary) notFound();
    const roster = await transaction.client.query<{ status: AssignmentRow["roster_status"] }>(
      `SELECT status FROM hr_shift_roster_versions
       WHERE tenant_id=$1 AND roster_version_id=$2 FOR SHARE`,
      [transaction.context.tenantId, preliminary.roster_version_id],
    );
    if (roster.rows[0]?.status !== preliminary.roster_status) notFound();
    await detailAuthority(
      transaction,
      role,
      actorProfileId,
      preliminary.worker_profile_id,
      preliminary.roster_status,
    );
    const locked = await transaction.client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS}
       FROM hr_shift_assignments assignment
       JOIN hr_shift_roster_versions roster
         ON roster.tenant_id=assignment.tenant_id
        AND roster.roster_version_id=assignment.roster_version_id
       WHERE assignment.tenant_id=$1 AND assignment.shift_assignment_id=$2
       FOR SHARE OF assignment`,
      [transaction.context.tenantId, selectedId],
    );
    const row = locked.rows[0];
    if (
      !row ||
      row.worker_profile_id !== preliminary.worker_profile_id ||
      row.roster_version_id !== preliminary.roster_version_id ||
      row.roster_status !== preliminary.roster_status
    ) {
      notFound();
    }
    const current = assignment(row);
    return { assignment: current, history: await history(transaction, current) };
  });
}
