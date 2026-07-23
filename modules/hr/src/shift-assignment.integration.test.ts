import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { type OperationContext, PlatformError } from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignShift,
  cancelShiftAssignment,
  createShiftRoster,
  publishShiftRoster,
} from "./shift-assignment.js";

const ids = {
  actor: "a6000000-0000-4000-8000-000000000001",
  actorMembership: "26000000-0000-4000-8000-000000000001",
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
  pool = createDatabasePool(runtimeUrl, { max: 8 });
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities,tenant_settings TO ${applicationRole};
     GRANT SELECT,UPDATE ON service_activations,hr_worker_profiles TO ${applicationRole};
     GRANT SELECT,INSERT ON evidence_events,outbox_events TO ${applicationRole}`,
  );

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Shift Lifecycle'),($2,'Other Shift'),($3,'Missing Shift')`,
    [ids.tenant, ids.otherTenant, ids.missingTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Shift Operator'),($2,'Other Operator'),($3,'Shift Worker')`,
    [ids.actor, ids.otherActor, ids.worker],
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
          ["hr.shift.assign", "hr.shift.cancel", "hr.shift.create_roster", "hr.shift.publish"],
        ],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id,service_key,state,version)
         VALUES ($1,'workforce_profile','active',1),($1,'shift_assignment','active',1)`,
        [tenantId],
      );
    });
  }
  await tenantTransaction(migrationPool, ids.tenant, ids.actor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'employee')`,
      [ids.workerMembership, ids.tenant, ids.worker],
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
  });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("Shift Assignment mutation lifecycle", () => {
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
    await createShiftRoster(pool, context(), input);
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
      createShiftRoster(pool, context(), rosterInput("2099-04-01", "2099-04-14")),
    ).rejects.toMatchObject({ code: "SHIFT_DEPENDENCY_INACTIVE" });
    await setActivation(ids.tenant, ids.actor, "workforce_profile", "active");

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
