import { randomUUID } from "node:crypto";
import { parseHrShiftAssignmentResponse } from "@esbla/contracts";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { type OperationContext, PlatformError } from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  observeShiftServiceLockContention,
  restoreShiftRuntimeTableAuthority,
} from "./shift-assignment.integration-fixture.js";
import {
  assignShift,
  cancelShiftAssignment,
  createShiftRoster,
  publishShiftRoster,
} from "./shift-assignment.js";
import {
  getAuthorizedShiftAssignmentDetail,
  listAuthorizedShiftAssignments,
} from "./shift-assignment-queries.js";
import {
  activateShiftAssignmentService,
  configureShiftAssignmentService,
  deactivateShiftAssignmentService,
  getShiftAssignmentServiceControl,
} from "./shift-assignment-service-control.js";
import { changeWorkforceReportingRelationship } from "./workforce-commands.js";

const ids = {
  actor: "a6000000-0000-4000-8000-000000000001",
  actorMembership: "26000000-0000-4000-8000-000000000001",
  controlAdmin: "e6000000-0000-4000-8000-000000000005",
  controlAdminMembership: "26000000-0000-4000-8000-000000000005",
  controlTenant: "d8000000-0000-4000-8000-000000000004",
  manager: "d6000000-0000-4000-8000-000000000004",
  managerMembership: "26000000-0000-4000-8000-000000000004",
  missingTenant: "c8000000-0000-4000-8000-000000000003",
  otherActor: "b6000000-0000-4000-8000-000000000002",
  otherMembership: "26000000-0000-4000-8000-000000000002",
  otherTenant: "b8000000-0000-4000-8000-000000000002",
  tenant: "a8000000-0000-4000-8000-000000000001",
  worker: "c6000000-0000-4000-8000-000000000003",
  workerMembership: "26000000-0000-4000-8000-000000000003",
} as const;

let applicationRole = "";
let migrationPool: Pool;
let pool: Pool;
let managerProfileId = "";
let workerProfileId = "";
function context(
  correlationId: string = randomUUID(),
  tenantId: string = ids.tenant,
  actorPrincipalId: string = ids.actor,
): OperationContext {
  return { actorPrincipalId, correlationId, tenantId };
}
const rosterInput = (periodStart: string, periodEnd: string, idempotencyKey = randomUUID()) => ({
  idempotencyKey,
  periodEnd,
  periodStart,
});
const assignmentInput = (
  rosterVersionId: string,
  startsAt: string,
  endsAt: string,
  ianaTimezone = "Asia/Karachi",
) => ({
  endsAt,
  ianaTimezone,
  idempotencyKey: randomUUID(),
  rosterVersionId,
  startsAt,
  workerProfileId,
});
async function tenantTransaction<T>(
  source: Pool,
  tenantId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await source.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true),
              set_config('app.actor_principal_id',$2,true),
              set_config('app.correlation_id',$3,true)`,
      [tenantId, actorId, randomUUID()],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type ShiftCounts = { evidence: number; outbox: number; rosters: number; work: number };
async function shiftCounts(periodStart: string): Promise<ShiftCounts> {
  return await tenantTransaction(migrationPool, ids.tenant, ids.actor, async (client) => {
    const result = await client.query<ShiftCounts>(
      `SELECT
         (SELECT count(*) FROM hr_shift_roster_versions
          WHERE tenant_id=$1 AND period_start=$2)::integer rosters,
         (SELECT count(*) FROM evidence_events
          WHERE tenant_id=$1 AND event_type LIKE 'hr.shift_assignment.%')::integer evidence,
         (SELECT count(*) FROM outbox_events
          WHERE tenant_id=$1 AND event_type LIKE 'hr.shift_assignment.%')::integer outbox,
         (SELECT count(*) FROM work_items WHERE tenant_id=$1)::integer work`,
      [ids.tenant, periodStart],
    );
    return result.rows[0] as ShiftCounts;
  });
}

type ControlCounts = {
  activations: number;
  assignments: number;
  controls: number;
  evidence: number;
  outbox: number;
  rosters: number;
  settings: number;
  work: number;
};
async function controlCounts(): Promise<ControlCounts> {
  return await tenantTransaction(
    migrationPool,
    ids.controlTenant,
    ids.controlAdmin,
    async (client) => {
      const result = await client.query<ControlCounts>(
        `SELECT
           (SELECT count(*) FROM service_activations WHERE tenant_id=$1)::integer activations,
           (SELECT count(*) FROM hr_shift_assignment_service_control
            WHERE tenant_id=$1)::integer controls,
           (SELECT count(*) FROM tenant_settings
            WHERE tenant_id=$1 AND setting_key LIKE 'hr.shift_assignment.%')::integer settings,
           (SELECT count(*) FROM hr_shift_roster_versions WHERE tenant_id=$1)::integer rosters,
           (SELECT count(*) FROM hr_shift_assignments WHERE tenant_id=$1)::integer assignments,
           (SELECT count(*) FROM evidence_events WHERE tenant_id=$1)::integer evidence,
           (SELECT count(*) FROM outbox_events WHERE tenant_id=$1)::integer outbox,
           (SELECT count(*) FROM work_items WHERE tenant_id=$1)::integer work`,
        [ids.controlTenant],
      );
      return result.rows[0] as ControlCounts;
    },
  );
}

const setActivation = (
  tenantId: string,
  actorId: string,
  serviceKey: string,
  state: "active" | "inactive",
) =>
  tenantTransaction(migrationPool, tenantId, actorId, (client) =>
    client.query(
      `UPDATE service_activations SET state=$3,version=version+1
       WHERE tenant_id=$1 AND service_key=$2`,
      [tenantId, serviceKey, state],
    ),
  );

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL Shift lifecycle harness is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  await migrateDatabase(createDatabase(migrationPool));
  await restoreShiftRuntimeTableAuthority(migrationPool, applicationRole);
  pool = createDatabasePool(runtimeUrl, { max: 8 });
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings TO ${applicationRole};
     GRANT SELECT,INSERT ON hr_reporting_relationships TO ${applicationRole};
     GRANT SELECT,UPDATE ON service_activations,hr_worker_profiles TO ${applicationRole};
     GRANT SELECT,INSERT ON evidence_events,outbox_events TO ${applicationRole}`,
  );

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Shift Lifecycle'),($2,'Other Shift'),($3,'Missing Shift'),
            ($4,'Shift Control')`,
    [ids.tenant, ids.otherTenant, ids.missingTenant, ids.controlTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Shift Operator'),($2,'Other Operator'),($3,'Shift Worker'),
            ($4,'Shift Manager'),($5,'Shift Administrator')`,
    [ids.actor, ids.otherActor, ids.worker, ids.manager, ids.controlAdmin],
  );
  for (const [tenantId, actorId, membershipId] of [
    [ids.tenant, ids.actor, ids.actorMembership],
    [ids.otherTenant, ids.otherActor, ids.otherMembership],
  ] as const) {
    await tenantTransaction(migrationPool, tenantId, actorId, async (client) => {
      await client.query(
        `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'hr_operator')`,
        [membershipId, tenantId, actorId],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
        [
          tenantId,
          actorId,
          [
            "hr.shift.assign",
            "hr.shift.cancel",
            "hr.shift.create_roster",
            "hr.shift.list_roster",
            "hr.shift.publish",
            "hr.shift.view_detail",
            "hr.workforce.change_reporting_relationship",
          ],
        ],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),($1,'shift_assignment','active',1)`,
        [tenantId],
      );
    });
  }
  await tenantTransaction(migrationPool, ids.controlTenant, ids.controlAdmin, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
         VALUES ($1,$2,$3,'tenant_admin')`,
      [ids.controlAdminMembership, ids.controlTenant, ids.controlAdmin],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         SELECT $1,$2,capability FROM unnest($3::text[]) capability`,
      [
        ids.controlTenant,
        ids.controlAdmin,
        [
          "hr.shift.activate_service",
          "hr.shift.configure_service",
          "hr.shift.deactivate_service",
          "hr.shift.view_service_control",
        ],
      ],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1)`,
      [ids.controlTenant],
    );
  });
  await tenantTransaction(migrationPool, ids.tenant, ids.actor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'employee'),($4,$2,$5,'manager')`,
      [ids.workerMembership, ids.tenant, ids.worker, ids.managerMembership, ids.manager],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       SELECT $1,principal_id,capability
       FROM unnest($2::uuid[]) principal_id
       CROSS JOIN unnest($3::text[]) capability`,
      [ids.tenant, [ids.worker, ids.manager], ["hr.shift.list_roster", "hr.shift.view_detail"]],
    );
    const worker = await client.query<{ worker_profile_id: string }>(
      `INSERT INTO hr_worker_profiles (tenant_id)
       VALUES ($1) RETURNING worker_profile_id::text`,
      [ids.tenant],
    );
    workerProfileId = worker.rows[0]?.worker_profile_id ?? "";
    await client.query(
      `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId, ids.worker],
    );
    await client.query(
      `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId],
    );
    const manager = await client.query<{ worker_profile_id: string }>(
      `INSERT INTO hr_worker_profiles (tenant_id)
       VALUES ($1) RETURNING worker_profile_id::text`,
      [ids.tenant],
    );
    managerProfileId = manager.rows[0]?.worker_profile_id ?? "";
    await client.query(
      `UPDATE hr_worker_profiles SET principal_id=$3,row_version=2
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, managerProfileId, ids.manager],
    );
    await client.query(
      `UPDATE hr_worker_profiles SET workforce_status='active',row_version=3
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, managerProfileId],
    );
    const relationship = await client.query<{ reporting_relationship_id: string }>(
      `INSERT INTO hr_reporting_relationships
         (tenant_id,worker_profile_id,manager_worker_profile_id,relationship_status,
          relationship_version)
       VALUES ($1,$2,$3,'assigned',1)
       RETURNING reporting_relationship_id::text`,
      [ids.tenant, workerProfileId, managerProfileId],
    );
    await client.query(
      `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3,row_version=4
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [ids.tenant, workerProfileId, relationship.rows[0]?.reporting_relationship_id],
    );
  });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("Shift Assignment mutation lifecycle", () => {
  it("lists only published authorized shifts and returns evidence-backed detail", async () => {
    const draft = (
      await createShiftRoster(pool, context(), rosterInput("2028-01-01", "2028-01-14"))
    ).roster;
    const assigned = await assignShift(
      pool,
      context(),
      assignmentInput(draft.rosterVersionId, "2028-01-03T04:00:00Z", "2028-01-03T12:00:00Z"),
    );
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `INSERT INTO hr_shift_assignments
           (tenant_id,roster_version_id,worker_profile_id,starts_at,ends_at,iana_timezone)
         SELECT $1,$2,$3,$4::timestamptz + slot * interval '4 hours',
                $4::timestamptz + slot * interval '4 hours' + interval '3 hours',$5
         FROM generate_series(0,49) slot`,
        [
          ids.tenant,
          draft.rosterVersionId,
          workerProfileId,
          "2028-01-04T00:00:00Z",
          "Asia/Karachi",
        ],
      ),
    );
    expect(
      await listAuthorizedShiftAssignments(pool, context(randomUUID(), ids.tenant, ids.worker), {
        mode: "own",
        rangeEnd: "2028-02-01T00:00:00Z",
        rangeStart: "2028-01-01T00:00:00Z",
      }),
    ).toMatchObject({ accessScope: "own", items: [] });
    await publishShiftRoster(pool, context(), {
      expectedVersion: draft.version,
      idempotencyKey: randomUUID(),
      rosterVersionId: draft.rosterVersionId,
    });

    const own = await listAuthorizedShiftAssignments(
      pool,
      context(randomUUID(), ids.tenant, ids.worker),
      {
        mode: "own",
        pageSize: 50,
        rangeEnd: "2028-02-01T00:00:00Z",
        rangeStart: "2028-01-01T00:00:00Z",
      },
    );
    expect(own.accessScope).toBe("own");
    expect(own.items[0]).toMatchObject({
      shiftAssignmentId: assigned.assignment.shiftAssignmentId,
      status: "active",
    });
    expect(own.items).toHaveLength(50);
    expect(own.nextCursor).not.toBeNull();
    const nextCursor = own.nextCursor;
    if (!nextCursor) throw new Error("Expected a full-page Shift cursor");
    const tail = await listAuthorizedShiftAssignments(
      pool,
      context(randomUUID(), ids.tenant, ids.worker),
      {
        cursor: nextCursor,
        mode: "own",
        pageSize: 50,
        rangeEnd: "2028-02-01T00:00:00Z",
        rangeStart: "2028-01-01T00:00:00Z",
      },
    );
    expect(tail).toMatchObject({ accessScope: "own", nextCursor: null });
    expect(tail.items).toHaveLength(1);
    const detail = await getAuthorizedShiftAssignmentDetail(
      pool,
      context(randomUUID(), ids.tenant, ids.worker),
      assigned.assignment.shiftAssignmentId,
    );
    expect(detail).toMatchObject({
      assignment: { shiftAssignmentId: assigned.assignment.shiftAssignmentId, status: "active" },
      history: [
        {
          eventType: "hr.shift_assignment.assign_shift",
          newState: "active",
          priorState: null,
        },
      ],
    });
  }, 20_000);

  it("re-reads manager relationship and role while HR keeps tenant-scoped roster access", async () => {
    const draft = (
      await createShiftRoster(pool, context(), rosterInput("2028-02-01", "2028-02-14"))
    ).roster;
    const assigned = await assignShift(
      pool,
      context(),
      assignmentInput(draft.rosterVersionId, "2028-02-03T04:00:00Z", "2028-02-03T12:00:00Z"),
    );
    const managerContext = () => context(randomUUID(), ids.tenant, ids.manager);
    await expect(
      listAuthorizedShiftAssignments(pool, managerContext(), {
        mode: "roster",
        rosterVersionId: draft.rosterVersionId,
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
    await publishShiftRoster(pool, context(), {
      expectedVersion: draft.version,
      idempotencyKey: randomUUID(),
      rosterVersionId: draft.rosterVersionId,
    });
    expect(
      await listAuthorizedShiftAssignments(pool, managerContext(), {
        mode: "roster",
        rosterVersionId: draft.rosterVersionId,
        status: "active",
      }),
    ).toMatchObject({
      accessScope: "assigned",
      items: [{ shiftAssignmentId: assigned.assignment.shiftAssignmentId }],
    });
    expect(
      await listAuthorizedShiftAssignments(pool, context(), {
        mode: "roster",
        rosterVersionId: draft.rosterVersionId,
        status: "active",
      }),
    ).toMatchObject({ accessScope: "tenant", items: [{ workerProfileId }] });
    const emptyDraft = (
      await createShiftRoster(pool, context(), rosterInput("2028-02-15", "2028-02-28"))
    ).roster;
    await publishShiftRoster(pool, context(), {
      expectedVersion: emptyDraft.version,
      idempotencyKey: randomUUID(),
      rosterVersionId: emptyDraft.rosterVersionId,
    });
    expect(
      await listAuthorizedShiftAssignments(pool, managerContext(), {
        mode: "roster",
        rosterVersionId: emptyDraft.rosterVersionId,
        status: "active",
      }),
    ).toMatchObject({ accessScope: "assigned", items: [], nextCursor: null });

    await changeWorkforceReportingRelationship(pool, context(), {
      expectedVersion: 4,
      idempotencyKey: randomUUID(),
      managerWorkerProfileId: null,
      relationshipStatus: "unassigned",
      workerProfileId,
    });
    await expect(
      getAuthorizedShiftAssignmentDetail(
        pool,
        managerContext(),
        assigned.assignment.shiftAssignmentId,
      ),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
    await expect(
      listAuthorizedShiftAssignments(pool, managerContext(), {
        mode: "roster",
        rosterVersionId: draft.rosterVersionId,
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
    await changeWorkforceReportingRelationship(pool, context(), {
      expectedVersion: 5,
      idempotencyKey: randomUUID(),
      managerWorkerProfileId: managerProfileId,
      relationshipStatus: "assigned",
      workerProfileId,
    });
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE memberships SET role_key='employee'
         WHERE tenant_id=$1 AND principal_id=$2`,
        [ids.tenant, ids.manager],
      ),
    );
    await expect(
      getAuthorizedShiftAssignmentDetail(
        pool,
        managerContext(),
        assigned.assignment.shiftAssignmentId,
      ),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE memberships SET role_key='manager'
         WHERE tenant_id=$1 AND principal_id=$2`,
        [ids.tenant, ids.manager],
      ),
    );
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `DELETE FROM membership_capabilities
         WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='hr.shift.view_detail'`,
        [ids.tenant, ids.manager],
      ),
    );
    for (const shiftAssignmentId of [assigned.assignment.shiftAssignmentId, randomUUID()]) {
      await expect(
        getAuthorizedShiftAssignmentDetail(pool, managerContext(), shiftAssignmentId),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    }
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.shift.view_detail')`,
        [ids.tenant, ids.manager],
      ),
    );
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE hr_worker_profiles
         SET workforce_status='suspended',row_version=row_version+1
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, managerProfileId],
      ),
    );
    for (const shiftAssignmentId of [assigned.assignment.shiftAssignmentId, randomUUID()]) {
      await expect(
        getAuthorizedShiftAssignmentDetail(pool, managerContext(), shiftAssignmentId),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    }
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE hr_worker_profiles
         SET workforce_status='active',row_version=row_version+1
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [ids.tenant, managerProfileId],
      ),
    );
    await expect(
      getAuthorizedShiftAssignmentDetail(
        pool,
        context(randomUUID(), ids.otherTenant, ids.otherActor),
        assigned.assignment.shiftAssignmentId,
      ),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
  });

  it("creates a distant bounded roster once and replays without duplicate proof", async () => {
    const key = randomUUID();
    const input = rosterInput("2099-01-01", "2099-01-14", key);
    const before = await shiftCounts(input.periodStart);
    const created = await createShiftRoster(pool, context(), input);
    expect(created).toMatchObject({
      billingState: "non_billable",
      replayed: false,
      roster: { periodVersion: 1, status: "draft", version: 1 },
    });
    const afterCreated = await shiftCounts(input.periodStart);
    expect(afterCreated).toEqual({
      evidence: before.evidence + 2,
      outbox: before.outbox + 1,
      rosters: 1,
      work: 0,
    });
    const replay = await createShiftRoster(
      pool,
      context(randomUUID().toUpperCase(), ids.tenant.toUpperCase(), ids.actor.toUpperCase()),
      input,
    );
    expect(replay).toEqual({ ...created, replayed: true });
    expect(await shiftCounts(input.periodStart)).toEqual(afterCreated);
    await expect(
      createShiftRoster(pool, context(), {
        ...input,
        periodStart: "2099-01-02",
      }),
    ).rejects.toBeInstanceOf(PlatformError);
    await expect(
      createShiftRoster(pool, context(), rosterInput("2099-01-01", "2099-01-15")),
    ).rejects.toMatchObject({ code: "SHIFT_INPUT_INVALID" });

    const concurrent = await Promise.allSettled(
      [1, 2].map(() => createShiftRoster(pool, context(), rosterInput("2099-02-01", "2099-02-14"))),
    );
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "SHIFT_CONFLICT" },
    });
    expect(await shiftCounts("2099-02-01")).toEqual({
      evidence: afterCreated.evidence + 2,
      outbox: afterCreated.outbox + 1,
      rosters: 1,
      work: 0,
    });
  });

  it("uses IANA-local roster dates and serializes overlap decisions", async () => {
    const roster = (
      await createShiftRoster(pool, context(), rosterInput("2027-03-14", "2027-03-20"))
    ).roster;
    await expect(
      assignShift(
        pool,
        context(),
        assignmentInput(
          roster.rosterVersionId,
          "2027-03-14T04:30:00Z",
          "2027-03-14T06:00:00Z",
          "America/New_York",
        ),
      ),
    ).rejects.toMatchObject({ code: "SHIFT_INPUT_INVALID" });
    const concurrent = await Promise.allSettled([
      assignShift(
        pool,
        context(),
        assignmentInput(
          roster.rosterVersionId,
          "2027-03-14T07:30:00Z",
          "2027-03-14T12:00:00Z",
          "America/New_York",
        ),
      ),
      assignShift(
        pool,
        context(),
        assignmentInput(
          roster.rosterVersionId,
          "2027-03-14T11:00:00Z",
          "2027-03-14T13:00:00Z",
          "America/New_York",
        ),
      ),
    ]);
    expect(concurrent.find(({ status }) => status === "fulfilled")).toMatchObject({
      value: { assignment: { status: "active", version: 1 }, billingState: "non_billable" },
    });
    expect(concurrent.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "SHIFT_CONFLICT" },
    });
    await expect(
      assignShift(
        pool,
        context(),
        assignmentInput(
          roster.rosterVersionId,
          "2027-03-14T14:00:00Z",
          "2027-03-14T15:00:00Z",
          "Not/A_Zone",
        ),
      ),
    ).rejects.toMatchObject({ code: "SHIFT_INPUT_INVALID" });
  });

  it("returns version-bounded assignment history and replays without duplicate semantics", async () => {
    const roster = (
      await createShiftRoster(pool, context(), rosterInput("2099-08-01", "2099-08-14"))
    ).roster;
    const assignInput = assignmentInput(
      roster.rosterVersionId,
      "2099-08-03T04:00:00Z",
      "2099-08-03T12:00:00Z",
    );
    const assigned = await assignShift(pool, context(), assignInput);
    const assignedResponse = parseHrShiftAssignmentResponse(
      await getAuthorizedShiftAssignmentDetail(
        pool,
        context(),
        assigned.assignment.shiftAssignmentId,
      ),
    );
    expect(assignedResponse).toMatchObject({
      assignment: { status: "active", version: 1 },
      history: [
        {
          eventType: "hr.shift_assignment.assign_shift",
          newState: "active",
          priorState: null,
        },
      ],
    });
    expect.soft(assigned).toEqual({
      ...assigned,
      assignment: assignedResponse.assignment,
      history: assignedResponse.history,
    });

    const cancelInput = {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      shiftAssignmentId: assigned.assignment.shiftAssignmentId,
    };
    const cancelled = await cancelShiftAssignment(pool, context(), cancelInput);
    const cancelledResponse = parseHrShiftAssignmentResponse(
      await getAuthorizedShiftAssignmentDetail(
        pool,
        context(),
        assigned.assignment.shiftAssignmentId,
      ),
    );
    expect(cancelledResponse).toMatchObject({
      assignment: { status: "cancelled", version: 2 },
      history: [
        { eventType: "hr.shift_assignment.assign_shift", newState: "active", priorState: null },
        {
          eventType: "hr.shift_assignment.cancel_assignment",
          newState: "cancelled",
          priorState: "active",
        },
      ],
    });
    expect.soft(cancelled).toEqual({
      ...cancelled,
      assignment: cancelledResponse.assignment,
      history: cancelledResponse.history,
    });

    const semanticCounts = async () =>
      await tenantTransaction(migrationPool, ids.tenant, ids.actor, async (client) => {
        const result = await client.query<{
          assignments: number;
          billing: number;
          evidence: number;
          outbox: number;
          rosters: number;
          work: number;
        }>(
          `SELECT
             (SELECT count(*) FROM hr_shift_assignments
              WHERE tenant_id=$1 AND roster_version_id=$2)::integer assignments,
             (SELECT count(*) FROM hr_shift_roster_versions
              WHERE tenant_id=$1 AND roster_version_id=$2)::integer rosters,
             (SELECT count(*) FROM evidence_events
              WHERE tenant_id=$1 AND event_type LIKE 'hr.shift_assignment.%')::integer evidence,
             (SELECT count(*) FROM outbox_events
              WHERE tenant_id=$1 AND event_type LIKE 'hr.shift_assignment.%')::integer outbox,
             (SELECT count(*) FROM work_items WHERE tenant_id=$1)::integer work,
             (SELECT count(*) FROM outbox_events
              WHERE tenant_id=$1 AND event_type LIKE 'hr.shift_assignment.%'
                AND payload->>'billingState'='non_billable')::integer billing`,
          [ids.tenant, roster.rosterVersionId],
        );
        return result.rows[0];
      });
    const beforeReplays = await semanticCounts();
    const assignReplay = await assignShift(pool, context(), assignInput);
    const cancelReplay = await cancelShiftAssignment(pool, context(), cancelInput);
    expect.soft(assignReplay).toEqual({
      ...assigned,
      assignment: assignedResponse.assignment,
      history: assignedResponse.history,
      replayed: true,
    });
    expect.soft(cancelReplay).toEqual({
      ...cancelled,
      assignment: cancelledResponse.assignment,
      history: cancelledResponse.history,
      replayed: true,
    });
    expect(await semanticCounts()).toEqual(beforeReplays);
  });

  it("publishes and atomically supersedes the exact predecessor before cancellation", async () => {
    const period = { periodEnd: "2027-04-14", periodStart: "2027-04-01" };
    const first = await createShiftRoster(
      pool,
      context(),
      rosterInput(period.periodStart, period.periodEnd),
    );
    const firstAssignmentInput = assignmentInput(
      first.roster.rosterVersionId,
      "2027-04-03T08:00:00Z",
      "2027-04-03T16:00:00Z",
    );
    const firstAssignment = await assignShift(pool, context(), firstAssignmentInput);
    const firstPublishInput = {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      rosterVersionId: first.roster.rosterVersionId,
    };
    const published = await publishShiftRoster(pool, context(), firstPublishInput);
    expect(published.roster).toMatchObject({ periodVersion: 1, status: "published", version: 2 });

    const successor = await createShiftRoster(
      pool,
      context(),
      rosterInput(period.periodStart, period.periodEnd),
    );
    const successorInput = assignmentInput(
      successor.roster.rosterVersionId,
      "2027-04-03T08:00:00Z",
      "2027-04-03T16:00:00Z",
    );
    const successorAssignment = await assignShift(pool, context(), successorInput);
    await cancelShiftAssignment(pool, context(), {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      shiftAssignmentId: successorAssignment.assignment.shiftAssignmentId,
    });
    await assignShift(pool, context(), {
      ...successorInput,
      idempotencyKey: randomUUID(),
    });
    await expect(
      publishShiftRoster(pool, context(), {
        expectedVersion: 2,
        idempotencyKey: randomUUID(),
        rosterVersionId: successor.roster.rosterVersionId,
      }),
    ).rejects.toMatchObject({ code: "SHIFT_VERSION_CONFLICT" });
    const replaced = await publishShiftRoster(pool, context(), {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      rosterVersionId: successor.roster.rosterVersionId,
    });
    expect(replaced.roster).toMatchObject({
      periodVersion: 2,
      status: "published",
      supersedesRosterVersionId: first.roster.rosterVersionId,
    });
    expect(await publishShiftRoster(pool, context(), firstPublishInput)).toEqual({
      ...published,
      replayed: true,
    });
    const states = await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT status,count(*)::integer count FROM hr_shift_roster_versions
         WHERE tenant_id=$1 AND period_start=$2 GROUP BY status ORDER BY status`,
        [ids.tenant, period.periodStart],
      ),
    );
    expect(states.rows).toEqual([
      { count: 1, status: "published" },
      { count: 1, status: "superseded" },
    ]);
    const cancelled = await cancelShiftAssignment(pool, context(), {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      shiftAssignmentId: firstAssignment.assignment.shiftAssignmentId,
    });
    expect(cancelled.assignment).toMatchObject({ status: "cancelled", version: 2 });
    expect(
      await getAuthorizedShiftAssignmentDetail(
        pool,
        context(),
        firstAssignment.assignment.shiftAssignmentId,
      ),
    ).toMatchObject({
      assignment: { status: "cancelled", version: 2 },
      history: [{ newState: "active" }, { newState: "cancelled", priorState: "active" }],
    });
    expect(await assignShift(pool, context(), firstAssignmentInput)).toEqual({
      ...firstAssignment,
      replayed: true,
    });
    const eventTypes = await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM outbox_events
           WHERE tenant_id=$1 AND event_type LIKE 'hr.shift_assignment.%'
           ORDER BY event_type`,
        [ids.tenant],
      ),
    );
    expect(eventTypes.rows.map(({ event_type }) => event_type)).toEqual([
      "hr.shift_assignment.assign_shift",
      "hr.shift_assignment.cancel_assignment",
      "hr.shift_assignment.create_roster",
      "hr.shift_assignment.publish_roster",
    ]);
  });

  it("rechecks authority and dependencies before replay and rolls proof failures back", async () => {
    const key = randomUUID();
    const input = rosterInput("2099-03-01", "2099-03-14", key);
    const seeded = await createShiftRoster(pool, context(), input);
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE memberships SET role_key='employee'
         WHERE tenant_id=$1 AND principal_id=$2`,
        [ids.tenant, ids.actor],
      ),
    );
    await expect(createShiftRoster(pool, context(), input)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
      client.query(
        `UPDATE memberships SET role_key='hr_operator'
         WHERE tenant_id=$1 AND principal_id=$2`,
        [ids.tenant, ids.actor],
      ),
    );
    await setActivation(ids.tenant, ids.actor, "workforce_profile", "inactive");
    await expect(
      listAuthorizedShiftAssignments(pool, context(), {
        mode: "roster",
        rosterVersionId: seeded.roster.rosterVersionId,
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "SHIFT_DEPENDENCY_INACTIVE" });
    await expect(
      createShiftRoster(pool, context(), rosterInput("2099-04-01", "2099-04-14")),
    ).rejects.toMatchObject({ code: "SHIFT_DEPENDENCY_INACTIVE" });
    await setActivation(ids.tenant, ids.actor, "workforce_profile", "active");
    const activationBlocker = await migrationPool.connect();
    try {
      await activationBlocker.query("BEGIN");
      await activationBlocker.query("SELECT set_config('app.tenant_id',$1,true)", [ids.tenant]);
      await activationBlocker.query(
        `SELECT service_key FROM service_activations
         WHERE tenant_id=$1 AND service_key='workforce_profile' FOR UPDATE`,
        [ids.tenant],
      );
      await expect(
        listAuthorizedShiftAssignments(pool, context(), {
          mode: "roster",
          rosterVersionId: seeded.roster.rosterVersionId,
          status: "active",
        }),
      ).rejects.toMatchObject({
        code: "SHIFT_VERSION_CONFLICT",
        message: "Shift Assignment read currentness check failed",
      });
    } finally {
      await activationBlocker.query("ROLLBACK").catch(() => undefined);
      activationBlocker.release();
    }

    const beforeProofFailure = await shiftCounts("2099-05-01");
    await migrationPool.query(`REVOKE INSERT ON outbox_events FROM ${applicationRole}`);
    try {
      await expect(
        createShiftRoster(pool, context(), rosterInput("2099-05-01", "2099-05-14")),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await migrationPool.query(`GRANT INSERT ON outbox_events TO ${applicationRole}`);
    }
    expect(await shiftCounts("2099-05-01")).toEqual(beforeProofFailure);

    const denyAbsentActor = (tenantId: string) =>
      expect(
        createShiftRoster(
          pool,
          context(randomUUID(), tenantId, ids.actor),
          rosterInput("2099-06-01", "2099-06-14"),
        ),
      ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" });
    await denyAbsentActor(ids.otherTenant);
    await setActivation(ids.otherTenant, ids.otherActor, "shift_assignment", "inactive");
    await expect(
      getAuthorizedShiftAssignmentDetail(
        pool,
        context(randomUUID(), ids.otherTenant, ids.otherActor),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "SHIFT_SERVICE_INACTIVE" });
    await expect(
      createShiftRoster(
        pool,
        context(randomUUID(), ids.otherTenant, ids.otherActor),
        rosterInput("2099-07-01", "2099-07-14"),
      ),
    ).rejects.toMatchObject({ code: "SHIFT_SERVICE_INACTIVE" });
    await denyAbsentActor(ids.otherTenant);
    await denyAbsentActor(ids.missingTenant);
  });
});
describe("Shift Assignment service control", () => {
  const adminContext = (correlationId = randomUUID()) =>
    context(correlationId, ids.controlTenant, ids.controlAdmin);

  it("activates, configures and deactivates with exact replay-safe full controls", async () => {
    const initialCounts = await controlCounts();
    await expect(getShiftAssignmentServiceControl(pool, adminContext())).rejects.toMatchObject({
      code: "SHIFT_SERVICE_CONTROL_NOT_FOUND",
    });
    await expect(
      getShiftAssignmentServiceControl(pool, context(randomUUID(), ids.tenant, ids.controlAdmin)),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" });
    expect(await controlCounts()).toEqual(initialCounts);

    await setActivation(ids.controlTenant, ids.controlAdmin, "workforce_profile", "inactive");
    const dependencyBlockedCounts = await controlCounts();
    await expect(
      activateShiftAssignmentService(
        pool,
        migrationPool,
        adminContext(),
        { expectedVersion: null },
        "non_production",
      ),
    ).rejects.toMatchObject({ code: "SHIFT_DEPENDENCY_INACTIVE" });
    expect(await controlCounts()).toEqual(dependencyBlockedCounts);
    await setActivation(ids.controlTenant, ids.controlAdmin, "workforce_profile", "active");

    const isolatedReaderCounts = await controlCounts();
    await expect(
      activateShiftAssignmentService(
        pool,
        pool,
        adminContext(),
        { expectedVersion: null },
        "non_production",
      ),
    ).rejects.toMatchObject({ code: "ACTIVATION_DEPENDENCY_BLOCKED" });
    expect(await controlCounts()).toEqual(isolatedReaderCounts);

    const contention = await observeShiftServiceLockContention(
      migrationPool,
      ids.controlTenant,
      async () =>
        await activateShiftAssignmentService(
          pool,
          migrationPool,
          adminContext(),
          { expectedVersion: null },
          "non_production",
        ),
    );
    expect(contention).toEqual({
      bounded: "SHIFT_VERSION_CONFLICT",
      settled: "SHIFT_VERSION_CONFLICT",
    });
    expect(await controlCounts()).toEqual(isolatedReaderCounts);

    const activateKey = randomUUID();
    const activated = await activateShiftAssignmentService(
      pool,
      migrationPool,
      adminContext(activateKey),
      { expectedVersion: null },
      "non_production",
    );
    expect(activated).toEqual({
      billingState: "non_billable",
      control: {
        activationState: "active",
        activationVersion: 1,
        serviceKey: "shift_assignment",
        settings: { overlapAllowed: false, rosterHorizonDays: 14 },
        settingsVersion: 1,
        updatedAt: expect.any(String),
        version: 1,
      },
      replayed: false,
    });
    await expect(
      activateShiftAssignmentService(
        pool,
        migrationPool,
        adminContext(activateKey),
        { expectedVersion: null },
        "production",
      ),
    ).resolves.toEqual({ ...activated, replayed: true });
    await expect(
      activateShiftAssignmentService(
        pool,
        migrationPool,
        adminContext(activateKey),
        { expectedVersion: 1 },
        "non_production",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const configureKey = randomUUID();
    const configureInput = {
      expectedSettingsVersion: 1,
      settings: { overlapAllowed: false as const, rosterHorizonDays: 21 },
    };
    const configured = await configureShiftAssignmentService(
      pool,
      adminContext(configureKey),
      configureInput,
    );
    expect(configured).toMatchObject({
      billingState: "non_billable",
      control: {
        activationState: "active",
        activationVersion: 1,
        serviceKey: "shift_assignment",
        settings: configureInput.settings,
        settingsVersion: 2,
        version: 2,
      },
      replayed: false,
    });
    await expect(
      configureShiftAssignmentService(pool, adminContext(configureKey), configureInput),
    ).resolves.toEqual({ ...configured, replayed: true });
    await expect(
      configureShiftAssignmentService(pool, adminContext(configureKey), {
        ...configureInput,
        settings: { overlapAllowed: false, rosterHorizonDays: 22 },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const concurrent = await Promise.allSettled(
      [20, 22].map(
        async (rosterHorizonDays) =>
          await configureShiftAssignmentService(pool, adminContext(), {
            expectedSettingsVersion: 2,
            settings: { overlapAllowed: false, rosterHorizonDays },
          }),
      ),
    );
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const current = await getShiftAssignmentServiceControl(pool, adminContext());
    expect(current.control).toMatchObject({ activationVersion: 1, settingsVersion: 3, version: 3 });

    const deactivateKey = randomUUID();
    const deactivated = await deactivateShiftAssignmentService(pool, adminContext(deactivateKey), {
      expectedVersion: current.control.activationVersion,
    });
    expect(deactivated).toMatchObject({
      control: { activationState: "inactive", activationVersion: 2, version: 4 },
      replayed: false,
    });
    const productionCounts = await controlCounts();
    await expect(
      activateShiftAssignmentService(
        pool,
        migrationPool,
        adminContext(),
        { expectedVersion: 2 },
        "production",
      ),
    ).rejects.toMatchObject({ code: "ACTIVATION_DEPENDENCY_BLOCKED" });
    expect(await controlCounts()).toEqual(productionCounts);

    const reactivated = await activateShiftAssignmentService(
      pool,
      migrationPool,
      adminContext(),
      { expectedVersion: 2 },
      "non_production",
    );
    expect(reactivated).toMatchObject({
      control: { activationState: "active", activationVersion: 3, version: 5 },
      replayed: false,
    });
    await expect(
      deactivateShiftAssignmentService(pool, adminContext(deactivateKey), {
        expectedVersion: current.control.activationVersion,
      }),
    ).resolves.toEqual({ ...deactivated, replayed: true });
    await expect(
      configureShiftAssignmentService(pool, adminContext(configureKey), configureInput),
    ).resolves.toEqual({ ...configured, replayed: true });

    await tenantTransaction(
      migrationPool,
      ids.controlTenant,
      ids.controlAdmin,
      async (client) =>
        await client.query(
          `UPDATE memberships SET role_key='employee'
           WHERE tenant_id=$1 AND principal_id=$2`,
          [ids.controlTenant, ids.controlAdmin],
        ),
    );
    const deniedCounts = await controlCounts();
    await expect(getShiftAssignmentServiceControl(pool, adminContext())).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    expect(await controlCounts()).toEqual(deniedCounts);
  }, 30_000);
});
