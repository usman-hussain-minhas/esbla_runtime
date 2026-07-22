import { randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { OperationContext } from "@esbla/platform-core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HR_EMPLOYMENT_RECORD_RUNTIME_TABLE_PRIVILEGES } from "./activation-readiness.js";
import {
  createEmploymentRecord,
  createEmploymentRecordVersion,
  endEmploymentRecord,
  getAuthorizedEmploymentRecordDetail,
  listAuthorizedEmploymentRecords,
} from "./employment.js";
import {
  activateEmploymentRecordService,
  configureEmploymentRecordService,
  deactivateEmploymentRecordService,
  getEmploymentRecordServiceControl,
} from "./employment-service-control.js";
import {
  awaitControlledSignal,
  createControlledPool,
  observeDirectBlockerUntil,
} from "./leave.integration-fixture.js";
import {
  changeWorkforceStatus,
  createWorkforceProfile,
  linkWorkforcePrincipal,
} from "./workforce-commands.js";

const ids = {
  adminA: randomUUID(),
  adminAccessRace: randomUUID(),
  adminDetailRace: randomUUID(),
  adminSettingsRace: randomUUID(),
  employeeA: randomUUID(),
  employeeAccessRace: randomUUID(),
  employeeDetailRace: randomUUID(),
  employeeSettingsRace: randomUUID(),
  hrA: randomUUID(),
  hrB: randomUUID(),
  hrAccessRace: randomUUID(),
  hrDetailRace: randomUUID(),
  hrSettingsRace: randomUUID(),
  managerA: randomUUID(),
  tenantA: randomUUID(),
  tenantAccessRace: randomUUID(),
  tenantB: randomUUID(),
  tenantDetailRace: randomUUID(),
  tenantSettingsRace: randomUUID(),
};
let appPool: Pool, migrationPool: Pool, migrationReadPool: Pool;
function context(
  actorPrincipalId: string = ids.hrA,
  tenantId: string = ids.tenantA,
  correlationId: string = randomUUID(),
): OperationContext {
  return { actorPrincipalId, correlationId, tenantId };
}
async function withTenant(
  tenantId: string,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function tenantRows<Row extends QueryResultRow>(
  tenantId: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  let rows: Row[] = [];
  await withTenant(tenantId, async (client) => {
    rows = (await client.query<Row>(text, [...values])).rows;
  });
  return rows;
}
async function setMember(principalId: string, roleKey: string): Promise<void> {
  await tenantRows(
    ids.tenantA,
    `UPDATE memberships SET role_key=$3,status=$4
     WHERE tenant_id=$1 AND principal_id=$2`,
    [ids.tenantA, principalId, roleKey, "active"],
  );
}
async function setCapability(principalId: string, capabilityId: string, present: boolean) {
  await tenantRows(
    ids.tenantA,
    present
      ? `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`
      : `DELETE FROM membership_capabilities
         WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [ids.tenantA, principalId, capabilityId],
  );
}
async function setWorkforceState(state: "active" | "inactive"): Promise<void> {
  await tenantRows(
    ids.tenantA,
    `UPDATE service_activations SET state=$2,version=version+1
     WHERE tenant_id=$1 AND service_key='workforce_profile' AND state IS DISTINCT FROM $2`,
    [ids.tenantA, state],
  );
}
async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}
interface Snapshot {
  readonly evidence: number;
  readonly outbox: number;
  readonly records: number;
  readonly versions: number;
  readonly work: number;
}
async function snapshot(tenantId: string = ids.tenantA): Promise<Snapshot> {
  const rows = await tenantRows<Snapshot>(
    tenantId,
    `SELECT
       (SELECT count(*)::integer FROM hr_employment_records WHERE tenant_id=$1) records,
       (SELECT count(*)::integer FROM hr_employment_record_versions WHERE tenant_id=$1) versions,
       (SELECT count(*)::integer FROM evidence_events WHERE tenant_id=$1) evidence,
       (SELECT count(*)::integer FROM outbox_events WHERE tenant_id=$1) outbox,
       (SELECT count(*)::integer FROM work_items WHERE tenant_id=$1) work`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error("Employment snapshot was unavailable");
  return row;
}
async function seedRaceTenant(
  tenantId: string,
  hrPrincipalId: string,
  adminPrincipalId: string,
  employeePrincipalId: string,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key) VALUES
         (gen_random_uuid(),$1,$2,'hr_operator'),
         (gen_random_uuid(),$1,$3,'tenant_admin'),
         (gen_random_uuid(),$1,$4,'employee')`,
      [tenantId, hrPrincipalId, adminPrincipalId, employeePrincipalId],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id) VALUES
       ($1,$2,'hr.workforce.create_profile'),($1,$2,'hr.workforce.link_principal'),
       ($1,$2,'hr.workforce.change_status'),($1,$2,'hr.employment.create_record'),
       ($1,$2,'hr.employment.create_version'),
       ($1,$3,'hr.employment.activate_service'),($1,$3,'hr.employment.configure_service'),
       ($1,$4,'hr.employment.list_authorized'),($1,$4,'hr.employment.view_detail')`,
      [tenantId, hrPrincipalId, adminPrincipalId, employeePrincipalId],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1)`,
      [tenantId],
    );
  });
}
async function restoreRuntimeTableAuthority(applicationRole: string): Promise<void> {
  for (const required of HR_EMPLOYMENT_RECORD_RUNTIME_TABLE_PRIVILEGES) {
    if (!/^public\.[a-z_][a-z0-9_]*$/.test(required.name)) {
      throw new Error("Employment Runtime authority contains an unsafe table identity");
    }
    const columns = await migrationPool.query<{ value: string | null }>(
      `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) value
       FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`,
      [required.name],
    );
    const columnList = columns.rows[0]?.value;
    if (!columnList) throw new Error("Employment Runtime table columns are unavailable");
    await migrationPool.query(
      `REVOKE ALL PRIVILEGES ON TABLE ${required.name} FROM ${applicationRole}`,
    );
    await migrationPool.query(
      `REVOKE SELECT (${columnList}), INSERT (${columnList}), UPDATE (${columnList}),
              REFERENCES (${columnList}) ON ${required.name} FROM ${applicationRole}`,
    );
  }
}
async function setup(): Promise<void> {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!runtimeUrl || !migrationUrl || !applicationRole) {
    throw new Error("PostgreSQL harness environment is required");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("Application role is not a safe PostgreSQL identifier");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 3 });
  migrationReadPool = createDatabasePool(migrationUrl, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await restoreRuntimeTableAuthority(applicationRole);
  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT ON memberships,membership_capabilities,tenant_settings,
       hr_workforce_profile_service_control,hr_workforce_status_history,
       hr_employment_record_service_control TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT,INSERT,UPDATE ON service_activations,hr_worker_profiles,
       hr_employment_records TO ${applicationRole}`,
  );
  await migrationPool.query(
    `GRANT SELECT,INSERT ON evidence_events,outbox_events,hr_reporting_relationships,
       hr_employment_record_versions TO ${applicationRole}`,
  );
  appPool = createDatabasePool(runtimeUrl, { max: 8 });
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name) VALUES
       ($1,'Employment A'),($2,'Employment B'),
       ($3,'Employment Access Race'),($4,'Employment Settings Race'),
       ($5,'Employment Detail Race')`,
    [ids.tenantA, ids.tenantB, ids.tenantAccessRace, ids.tenantSettingsRace, ids.tenantDetailRace],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name) VALUES
       ($1,'HR A'),($2,'Admin A'),($3,'Employee A'),($4,'Manager A'),
       ($5,'HR B'),($6,'Access Race HR'),($7,'Access Race Admin'),
       ($8,'Access Race Employee'),($9,'Settings Race HR'),
       ($10,'Settings Race Admin'),($11,'Settings Race Employee'),
       ($12,'Detail Race HR'),($13,'Detail Race Admin'),($14,'Detail Race Employee')`,
    [
      ids.hrA,
      ids.adminA,
      ids.employeeA,
      ids.managerA,
      ids.hrB,
      ids.hrAccessRace,
      ids.adminAccessRace,
      ids.employeeAccessRace,
      ids.hrSettingsRace,
      ids.adminSettingsRace,
      ids.employeeSettingsRace,
      ids.hrDetailRace,
      ids.adminDetailRace,
      ids.employeeDetailRace,
    ],
  );
  await withTenant(ids.tenantA, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key) VALUES
         (gen_random_uuid(),$1,$2,'hr_operator'),(gen_random_uuid(),$1,$3,'tenant_admin'),
         (gen_random_uuid(),$1,$4,'employee'),(gen_random_uuid(),$1,$5,'manager')`,
      [ids.tenantA, ids.hrA, ids.adminA, ids.employeeA, ids.managerA],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id) VALUES
       ($1,$2,'hr.workforce.create_profile'),($1,$2,'hr.workforce.link_principal'),
       ($1,$2,'hr.workforce.change_status'),($1,$2,'hr.employment.create_record'),
       ($1,$2,'hr.employment.create_version'),($1,$2,'hr.employment.end_record'),
       ($1,$2,'hr.employment.list_authorized'),($1,$2,'hr.employment.view_detail'),
       ($1,$3,'hr.employment.activate_service'),($1,$3,'hr.employment.configure_service'),
       ($1,$3,'hr.employment.deactivate_service'),($1,$3,'hr.employment.view_service_control'),
       ($1,$4,'hr.employment.list_authorized'),($1,$4,'hr.employment.view_detail'),
       ($1,$5,'hr.employment.list_authorized'),($1,$5,'hr.employment.view_detail')`,
      [ids.tenantA, ids.hrA, ids.adminA, ids.employeeA, ids.managerA],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1)`,
      [ids.tenantA],
    );
  });
  await withTenant(ids.tenantB, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id,tenant_id,principal_id,role_key)
       VALUES ($1,$2,$3,'hr_operator')`,
      [randomUUID(), ids.tenantB, ids.hrB],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id) VALUES
         ($1,$2,'hr.employment.list_authorized'),
         ($1,$2,'hr.employment.view_detail')`,
      [ids.tenantB, ids.hrB],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'workforce_profile','active',1),
              ($1,'employment_record','active',1)`,
      [ids.tenantB],
    );
  });
  await seedRaceTenant(
    ids.tenantAccessRace,
    ids.hrAccessRace,
    ids.adminAccessRace,
    ids.employeeAccessRace,
  );
  await seedRaceTenant(
    ids.tenantSettingsRace,
    ids.hrSettingsRace,
    ids.adminSettingsRace,
    ids.employeeSettingsRace,
  );
  await seedRaceTenant(
    ids.tenantDetailRace,
    ids.hrDetailRace,
    ids.adminDetailRace,
    ids.employeeDetailRace,
  );
}
async function createActiveEmployeeProfile(): Promise<string> {
  const created = await createWorkforceProfile(appPool, context(), {
    idempotencyKey: randomUUID(),
  });
  const linked = await linkWorkforcePrincipal(appPool, context(), {
    expectedVersion: created.profile.version,
    idempotencyKey: randomUUID(),
    principalId: ids.employeeA,
    workerProfileId: created.profile.workerProfileId,
  });
  const active = await changeWorkforceStatus(appPool, context(), {
    expectedVersion: linked.profile.version,
    idempotencyKey: randomUUID(),
    status: "active",
    workerProfileId: linked.profile.workerProfileId,
  });
  return active.profile.workerProfileId;
}
interface RaceFixture {
  readonly employmentRecordId: string;
  readonly recordVersion: number;
  readonly settingsVersion: number;
  readonly workerProfileId: string;
  readonly workerProfileVersion: number;
}
async function prepareRaceFixture(
  tenantId: string,
  hrPrincipalId: string,
  adminPrincipalId: string,
  employeePrincipalId: string,
): Promise<RaceFixture> {
  await activateEmploymentRecordService(
    appPool,
    migrationReadPool,
    context(adminPrincipalId, tenantId),
    { expectedVersion: null },
    "non_production",
  );
  const configured = await configureEmploymentRecordService(
    appPool,
    context(adminPrincipalId, tenantId),
    {
      expectedSettingsVersion: 1,
      settings: {
        effectiveRangeOverlapAllowed: false,
        employmentTypeCodes: "permanent,race",
      },
    },
  );
  const createdProfile = await createWorkforceProfile(appPool, context(hrPrincipalId, tenantId), {
    idempotencyKey: randomUUID(),
  });
  const linkedProfile = await linkWorkforcePrincipal(appPool, context(hrPrincipalId, tenantId), {
    expectedVersion: createdProfile.profile.version,
    idempotencyKey: randomUUID(),
    principalId: employeePrincipalId,
    workerProfileId: createdProfile.profile.workerProfileId,
  });
  const activeProfile = await changeWorkforceStatus(appPool, context(hrPrincipalId, tenantId), {
    expectedVersion: linkedProfile.profile.version,
    idempotencyKey: randomUUID(),
    status: "active",
    workerProfileId: linkedProfile.profile.workerProfileId,
  });
  const createdRecord = await createEmploymentRecord(appPool, context(hrPrincipalId, tenantId), {
    idempotencyKey: randomUUID(),
    workerProfileId: activeProfile.profile.workerProfileId,
  });
  const firstVersion = await createEmploymentRecordVersion(
    appPool,
    context(hrPrincipalId, tenantId),
    {
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      employmentRecordId: createdRecord.mutation.employmentRecordId,
      employmentTypeCode: "permanent",
      expectedCurrentVersion: null,
      expectedVersion: createdRecord.mutation.rootVersion,
      idempotencyKey: randomUUID(),
      organizationReference: null,
      positionReference: null,
    },
  );
  return {
    employmentRecordId: firstVersion.mutation.employmentRecordId,
    recordVersion: firstVersion.mutation.rootVersion,
    settingsVersion: configured.mutation.settingsVersion,
    workerProfileId: activeProfile.profile.workerProfileId,
    workerProfileVersion: activeProfile.profile.version,
  };
}
async function expectBackendsIdle(observer: PoolClient, pids: readonly number[]): Promise<void> {
  const result = await observer.query<{ active_transaction: boolean; pid: number; state: string }>(
    `SELECT pid,state,xact_start IS NOT NULL AS active_transaction
     FROM pg_catalog.pg_stat_activity WHERE pid=ANY($1::integer[]) ORDER BY pid`,
    [[...pids]],
  );
  expect(result.rows).toHaveLength(pids.length);
  expect(
    result.rows.every(({ active_transaction, state }) => !active_transaction && state === "idle"),
  ).toBe(true);
}
describe("Employment Record complete domain", () => {
  beforeAll(setup);
  afterAll(async () => {
    await appPool?.end();
    await migrationReadPool?.end();
    await migrationPool?.end();
  });
  it("keeps effective facts tenant-scoped, immutable, current-authority checked, and atomic", async () => {
    const admin = context(ids.adminA);
    const activated = await activateEmploymentRecordService(
      appPool,
      migrationReadPool,
      admin,
      { expectedVersion: null },
      "non_production",
    );
    expect(activated).toMatchObject({
      billingState: "non_billable",
      mutation: {
        activationState: "active",
        operation: "activate_service",
        serviceKey: "employment_record",
      },
      replayed: false,
    });
    await expectCode(
      activateEmploymentRecordService(
        appPool,
        migrationReadPool,
        context(ids.adminA),
        { expectedVersion: activated.mutation.activationVersion },
        "production",
      ),
      "ACTIVATION_DEPENDENCY_BLOCKED",
    );
    const configureContext = context(ids.adminA);
    const configured = await configureEmploymentRecordService(appPool, configureContext, {
      expectedSettingsVersion: 1,
      settings: {
        effectiveRangeOverlapAllowed: false,
        employmentTypeCodes: "unspecified,permanent,contract",
      },
    });
    expect(configured.mutation).toMatchObject({
      operation: "configure_service",
      settingsVersion: 2,
    });
    expect(
      (await getEmploymentRecordServiceControl(appPool, context(ids.adminA))).control.settings,
    ).toMatchObject({ employmentTypeCodes: "unspecified,permanent,contract" });
    await expectCode(
      configureEmploymentRecordService(appPool, configureContext, {
        expectedSettingsVersion: 1,
        settings: { effectiveRangeOverlapAllowed: false, employmentTypeCodes: "other" },
      }),
      "IDEMPOTENCY_CONFLICT",
    );
    expect(
      (
        await configureEmploymentRecordService(appPool, configureContext, {
          expectedSettingsVersion: 1,
          settings: {
            effectiveRangeOverlapAllowed: false,
            employmentTypeCodes: "unspecified,permanent,contract",
          },
        })
      ).replayed,
    ).toBe(true);
    const workerProfileId = await createActiveEmployeeProfile();
    const createKey = randomUUID();
    const created = await createEmploymentRecord(appPool, context(), {
      idempotencyKey: createKey,
      workerProfileId,
    });
    const employmentRecordId = created.mutation.employmentRecordId;
    expect(created.mutation).toEqual({
      currentVersion: null,
      employmentRecordId,
      operation: "create_record",
      rootVersion: 1,
      status: "draft",
    });
    expect(
      await getAuthorizedEmploymentRecordDetail(appPool, context(), { employmentRecordId }),
    ).toMatchObject({
      accessScope: "tenant",
      history: { items: [] },
      status: "draft",
      version: 1,
      workerProfileId,
    });
    expect(
      (
        await createEmploymentRecord(appPool, context(), {
          idempotencyKey: createKey,
          workerProfileId,
        })
      ).replayed,
    ).toBe(true);
    await expectCode(
      createEmploymentRecord(appPool, context(), {
        idempotencyKey: randomUUID(),
        workerProfileId,
      }),
      "EMPLOYMENT_CONFLICT",
    );
    const firstInput = {
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
      employmentRecordId,
      employmentTypeCode: "permanent",
      expectedCurrentVersion: null,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      organizationReference: "org-opaque",
      positionReference: "position-opaque",
    } as const;
    const first = await createEmploymentRecordVersion(appPool, context(), firstInput);
    expect(first.mutation).toEqual({
      currentVersion: 1,
      employmentRecordId,
      operation: "create_version",
      rootVersion: 2,
      status: "active",
    });
    expect(
      (await getAuthorizedEmploymentRecordDetail(appPool, context(), { employmentRecordId }))
        .currentVersion,
    ).toMatchObject({
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
      kind: "effective",
      rowVersion: 1,
      terminal: false,
      version: 1,
    });
    const beforeOverlap = await snapshot();
    await expectCode(
      createEmploymentRecordVersion(appPool, context(), {
        effectiveFrom: "2026-06-30",
        effectiveTo: "2026-07-31",
        employmentRecordId,
        employmentTypeCode: "contract",
        expectedCurrentVersion: 1,
        expectedVersion: 2,
        idempotencyKey: randomUUID(),
        organizationReference: null,
        positionReference: null,
      }),
      "EMPLOYMENT_CONFLICT",
    );
    expect(await snapshot()).toEqual(beforeOverlap);
    const secondInput = {
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
      employmentRecordId,
      employmentTypeCode: "contract",
      expectedCurrentVersion: 1,
      expectedVersion: 2,
      idempotencyKey: randomUUID(),
      organizationReference: "org-opaque",
      positionReference: "position-two",
    } as const;
    const beforeCompetingSuccessors = await snapshot();
    const competingSuccessors = await Promise.allSettled([
      createEmploymentRecordVersion(appPool, context(), secondInput),
      createEmploymentRecordVersion(appPool, context(), {
        ...secondInput,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(competingSuccessors.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const loser = competingSuccessors.find(({ status }) => status === "rejected");
    if (loser?.status !== "rejected") throw new Error("Expected one CAS loser");
    expect(loser.reason).toMatchObject({
      code: expect.stringMatching(/^EMPLOYMENT_(?:VERSION_)?CONFLICT$/),
    });
    const winner = competingSuccessors.find(({ status }) => status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Expected one CAS winner");
    const second = winner.value;
    expect(second.mutation).toMatchObject({
      currentVersion: 2,
      operation: "create_version",
      rootVersion: 3,
    });
    expect(await snapshot()).toEqual({
      ...beforeCompetingSuccessors,
      evidence: beforeCompetingSuccessors.evidence + 2,
      outbox: beforeCompetingSuccessors.outbox + 1,
      versions: beforeCompetingSuccessors.versions + 1,
    });
    const beforeOpen = await snapshot();
    await expectCode(
      createEmploymentRecordVersion(appPool, context(), {
        ...secondInput,
        effectiveFrom: "2027-01-01",
        effectiveTo: "2027-12-31",
        expectedCurrentVersion: 2,
        expectedVersion: 3,
        idempotencyKey: randomUUID(),
      }),
      "EMPLOYMENT_CONFLICT",
    );
    expect(await snapshot()).toEqual(beforeOpen);
    const staleKey = randomUUID();
    await expectCode(
      endEmploymentRecord(appPool, context(), {
        effectiveTo: "2026-12-31",
        employmentRecordId,
        expectedCurrentVersion: 1,
        expectedVersion: 2,
        idempotencyKey: staleKey,
      }),
      "EMPLOYMENT_VERSION_CONFLICT",
    );
    const endContext = context();
    const endInput = {
      effectiveTo: "2026-12-31",
      employmentRecordId,
      expectedCurrentVersion: 2,
      expectedVersion: 3,
      idempotencyKey: randomUUID(),
    } as const;
    const ended = await endEmploymentRecord(appPool, endContext, endInput);
    expect(ended.mutation).toEqual({
      currentVersion: 3,
      employmentRecordId,
      operation: "end_record",
      rootVersion: 4,
      status: "ended",
    });
    const endedDetail = await getAuthorizedEmploymentRecordDetail(appPool, context(), {
      employmentRecordId,
    });
    expect(endedDetail).toMatchObject({
      accessScope: "tenant",
      currentVersion: { kind: "end", terminal: true, version: 3 },
      status: "ended",
      version: 4,
    });
    expect(endedDetail.history.items.map(({ kind, version }) => [kind, version])).toEqual([
      ["end", 3],
      ["effective", 2],
      ["effective", 1],
    ]);
    expect((await endEmploymentRecord(appPool, endContext, endInput)).replayed).toBe(true);
    const firstReplay = await createEmploymentRecordVersion(appPool, context(), firstInput);
    expect(firstReplay).toEqual({ ...first, replayed: true });
    const mutationProof = await tenantRows<{
      actor_principal_id: string;
      aggregate_version: number;
      correlation_id: string;
      new_state: string;
      payload: Record<string, unknown>;
      prior_state: string | null;
    }>(
      ids.tenantA,
      `SELECT evidence.actor_principal_id, evidence.correlation_id::text,
              evidence.prior_state, evidence.new_state,
              outbox.aggregate_version, outbox.payload
       FROM evidence_events evidence
       JOIN outbox_events outbox
         ON outbox.tenant_id=evidence.tenant_id
        AND outbox.event_type=evidence.event_type
        AND outbox.aggregate_type=evidence.subject_type
        AND outbox.aggregate_id=evidence.subject_id
        AND outbox.correlation_id=evidence.correlation_id
       WHERE evidence.tenant_id=$1 AND evidence.subject_type='hr.employment_record'
         AND evidence.subject_id=$2
       ORDER BY outbox.aggregate_version`,
      [ids.tenantA, employmentRecordId],
    );
    expect(mutationProof).toHaveLength(4);
    expect(mutationProof.map(({ new_state, prior_state }) => [prior_state, new_state])).toEqual([
      [null, "draft"],
      ["draft", "active"],
      ["active", "active"],
      ["active", "ended"],
    ]);
    expect(mutationProof.map(({ aggregate_version }) => aggregate_version)).toEqual([1, 2, 3, 4]);
    const proofKeys = "action afterVersion beforeVersion billingState payloadVersion receiptId";
    for (const [index, proof] of mutationProof.entries()) {
      expect(proof.actor_principal_id).toBe(ids.hrA);
      expect(proof.correlation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(Object.keys(proof.payload).sort()).toEqual(proofKeys.split(" "));
      expect(proof.payload).toMatchObject({
        afterVersion: index + 1,
        beforeVersion: index === 0 ? null : index,
        billingState: "non_billable",
        payloadVersion: 1,
      });
    }
    const originalCreatePayload = mutationProof[0]?.payload;
    if (!originalCreatePayload) throw new Error("Employment create proof was unavailable");
    await tenantRows(
      ids.tenantA,
      `UPDATE outbox_events SET payload=payload || '{"forbidden":"fact"}'::jsonb
       WHERE tenant_id=$1 AND aggregate_type='hr.employment_record' AND aggregate_id=$2
         AND event_type='hr.employment_record.create_record'`,
      [ids.tenantA, employmentRecordId],
    );
    try {
      await expectCode(
        createEmploymentRecord(appPool, context(), { idempotencyKey: createKey, workerProfileId }),
        "IDEMPOTENCY_CONFLICT",
      );
    } finally {
      await tenantRows(
        ids.tenantA,
        `UPDATE outbox_events SET payload=$3::jsonb
         WHERE tenant_id=$1 AND aggregate_type='hr.employment_record' AND aggregate_id=$2
           AND event_type='hr.employment_record.create_record'`,
        [ids.tenantA, employmentRecordId, JSON.stringify(originalCreatePayload)],
      );
    }
    await withTenant(ids.tenantA, async (client) => {
      await client.query("SELECT set_config('app.actor_principal_id',$1,true)", [ids.hrA]);
      await client.query("SELECT set_config('app.correlation_id',$1,true)", [randomUUID()]);
      await client.query(
        `WITH workers AS (
           INSERT INTO hr_worker_profiles (tenant_id)
           SELECT $1 FROM generate_series(1,256)
           RETURNING worker_profile_id
         )
         INSERT INTO hr_employment_records (tenant_id,worker_profile_id)
         SELECT $1,worker_profile_id FROM workers`,
        [ids.tenantA],
      );
      await client.query("ANALYZE hr_employment_records");
      await client.query("ANALYZE hr_employment_record_versions");
      await client.query("SET LOCAL enable_seqscan=off");
      const tenantPlan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF,SUMMARY OFF)
         SELECT record.employment_record_id
         FROM hr_employment_records record
         WHERE record.tenant_id=$1
         ORDER BY record.created_at DESC NULLS LAST,
                  record.employment_record_id DESC NULLS LAST LIMIT 51`,
        [ids.tenantA],
      );
      const workerPlan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF,SUMMARY OFF)
         SELECT record.employment_record_id
         FROM hr_employment_records record
         WHERE record.tenant_id=$1 AND record.worker_profile_id=$2
         ORDER BY record.created_at DESC NULLS LAST,
                  record.employment_record_id DESC NULLS LAST LIMIT 51`,
        [ids.tenantA, workerProfileId],
      );
      const historyPlan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE,COSTS OFF,TIMING OFF,SUMMARY OFF)
         SELECT employment_record_version_id
         FROM hr_employment_record_versions
         WHERE tenant_id=$1 AND employment_record_id=$2
         ORDER BY version DESC NULLS LAST,
                  employment_record_version_id DESC NULLS LAST LIMIT 51`,
        [ids.tenantA, employmentRecordId],
      );
      const plans = [...tenantPlan.rows, ...workerPlan.rows, ...historyPlan.rows]
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(plans).toContain("idx_hr_employment_records_tenant_order_cursor");
      expect(plans).toContain("idx_hr_employment_records_tenant_cursor");
      expect(plans).toContain("idx_hr_employment_record_versions_tenant_record_cursor");
    });
    const employeeList = await listAuthorizedEmploymentRecords(appPool, context(ids.employeeA), {
      pageSize: 1,
    });
    expect(employeeList).toMatchObject({ accessScope: "own" });
    expect(employeeList.items[0]?.employmentRecordId).toBe(employmentRecordId);
    const employeeDetail = await getAuthorizedEmploymentRecordDetail(
      appPool,
      context(ids.employeeA),
      { employmentRecordId, pageSize: 1 },
    );
    expect(employeeDetail).toMatchObject({ accessScope: "own" });
    expect(employeeDetail.history.items).toHaveLength(1);
    const unrelatedProfile = await createWorkforceProfile(appPool, context(), {
      idempotencyKey: randomUUID(),
    });
    const unrelatedRecord = await createEmploymentRecord(appPool, context(), {
      idempotencyKey: randomUUID(),
      workerProfileId: unrelatedProfile.profile.workerProfileId,
    });
    for (const inaccessibleRecordId of [
      unrelatedRecord.mutation.employmentRecordId,
      randomUUID(),
    ]) {
      await expectCode(
        getAuthorizedEmploymentRecordDetail(appPool, context(ids.employeeA), {
          employmentRecordId: inaccessibleRecordId,
        }),
        "EMPLOYMENT_NOT_FOUND",
      );
    }
    const historyCursor = employeeDetail.history.nextCursor;
    if (!historyCursor) throw new Error("Expected another Employment Record history page");
    const secondHistoryPage = await getAuthorizedEmploymentRecordDetail(
      appPool,
      context(ids.employeeA),
      {
        cursor: historyCursor,
        employmentRecordId,
        pageSize: 2,
      },
    );
    expect(secondHistoryPage.history.items).toHaveLength(2);
    expect(secondHistoryPage.history.nextCursor).toBeNull();
    await expectCode(
      listAuthorizedEmploymentRecords(appPool, context(ids.managerA)),
      "POLICY_DENIED",
    );
    await expectCode(
      getAuthorizedEmploymentRecordDetail(appPool, context(ids.adminA), {
        employmentRecordId,
      }),
      "POLICY_DENIED",
    );
    await expectCode(
      getAuthorizedEmploymentRecordDetail(appPool, context(ids.hrB, ids.tenantB), {
        employmentRecordId,
      }),
      "EMPLOYMENT_NOT_FOUND",
    );
    const deniedBaseline = await snapshot();
    await setMember(ids.hrA, "employee");
    await expectCode(endEmploymentRecord(appPool, endContext, endInput), "POLICY_DENIED");
    await setMember(ids.hrA, "hr_operator");
    expect(await snapshot()).toEqual(deniedBaseline);
    await setCapability(ids.hrA, "hr.employment.list_authorized", false);
    await expectCode(listAuthorizedEmploymentRecords(appPool, context()), "POLICY_DENIED");
    await setCapability(ids.hrA, "hr.employment.list_authorized", true);
    await setWorkforceState("inactive");
    await expectCode(
      listAuthorizedEmploymentRecords(appPool, context()),
      "EMPLOYMENT_DEPENDENCY_INACTIVE",
    );
    expect(
      (await getEmploymentRecordServiceControl(appPool, context(ids.adminA))).control.settings,
    ).toMatchObject({ employmentTypeCodes: "unspecified,permanent,contract" });
    const dependencyUnavailableConfiguration = await configureEmploymentRecordService(
      appPool,
      context(ids.adminA),
      {
        expectedSettingsVersion: configured.mutation.settingsVersion,
        settings: {
          effectiveRangeOverlapAllowed: false,
          employmentTypeCodes: "unspecified,permanent,contract,seasonal",
        },
      },
    );
    expect(dependencyUnavailableConfiguration.mutation.settingsVersion).toBe(
      configured.mutation.settingsVersion + 1,
    );
    expect(
      await configureEmploymentRecordService(appPool, configureContext, {
        expectedSettingsVersion: 1,
        settings: {
          effectiveRangeOverlapAllowed: false,
          employmentTypeCodes: "unspecified,permanent,contract",
        },
      }),
    ).toEqual({ ...configured, replayed: true });
    const deactivated = await deactivateEmploymentRecordService(appPool, context(ids.adminA), {
      expectedVersion: activated.mutation.activationVersion,
    });
    expect(deactivated.mutation.activationState).toBe("inactive");
    expect(
      (await getEmploymentRecordServiceControl(appPool, context(ids.adminA))).control
        .activationState,
    ).toBe("inactive");
    await expectCode(
      activateEmploymentRecordService(
        appPool,
        migrationReadPool,
        context(ids.adminA),
        { expectedVersion: deactivated.mutation.activationVersion },
        "non_production",
      ),
      "EMPLOYMENT_DEPENDENCY_INACTIVE",
    );
    await setWorkforceState("active");
    const reactivated = await activateEmploymentRecordService(
      appPool,
      migrationReadPool,
      context(ids.adminA),
      { expectedVersion: deactivated.mutation.activationVersion },
      "non_production",
    );
    expect(reactivated.mutation.activationState).toBe("active");
    const finallyDeactivated = await deactivateEmploymentRecordService(
      appPool,
      context(ids.adminA),
      { expectedVersion: reactivated.mutation.activationVersion },
    );
    expect(finallyDeactivated.mutation.activationState).toBe("inactive");
    const controlProof = await tenantRows<{
      aggregate_version: number;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      ids.tenantA,
      `SELECT event_type,aggregate_version,payload FROM outbox_events
       WHERE tenant_id=$1 AND aggregate_type='hr.employment_record.service_control'
       ORDER BY aggregate_version`,
      [ids.tenantA],
    );
    expect(controlProof.map(({ event_type }) => event_type)).toEqual([
      "hr.employment_record.activate_service",
      "hr.employment_record.configure_service",
      "hr.employment_record.configure_service",
      "hr.employment_record.deactivate_service",
      "hr.employment_record.activate_service",
      "hr.employment_record.deactivate_service",
    ]);
    for (const [index, proof] of controlProof.entries()) {
      const action = proof.event_type.replace("hr.employment_record.", "");
      const expectedKeys =
        "action afterVersion beforeVersion billingState control payloadVersion receiptId";
      expect(Object.keys(proof.payload).sort()).toEqual(expectedKeys.split(" "));
      expect(proof.payload).toMatchObject({
        action,
        afterVersion: index + 1,
        beforeVersion: index === 0 ? null : index,
        billingState: "non_billable",
        control: { version: index + 1 },
        payloadVersion: 1,
      });
      expect(proof.aggregate_version).toBe(index + 1);
    }
    const originalActivationPayload = controlProof[0]?.payload;
    if (!originalActivationPayload) throw new Error("Employment activation proof was unavailable");
    await tenantRows(
      ids.tenantA,
      `UPDATE outbox_events
       SET payload=jsonb_set(payload,'{control,updatedAt}','"2099-01-01T00:00:00.000Z"'::jsonb)
       WHERE tenant_id=$1 AND aggregate_type='hr.employment_record.service_control'
         AND event_type='hr.employment_record.activate_service' AND aggregate_version=1`,
      [ids.tenantA],
    );
    try {
      await expectCode(
        activateEmploymentRecordService(
          appPool,
          migrationReadPool,
          admin,
          { expectedVersion: null },
          "non_production",
        ),
        "IDEMPOTENCY_CONFLICT",
      );
    } finally {
      await tenantRows(
        ids.tenantA,
        `UPDATE outbox_events SET payload=$2::jsonb
         WHERE tenant_id=$1 AND aggregate_type='hr.employment_record.service_control'
           AND event_type='hr.employment_record.activate_service' AND aggregate_version=1`,
        [ids.tenantA, JSON.stringify(originalActivationPayload)],
      );
    }
    expect(
      await activateEmploymentRecordService(
        appPool,
        migrationReadPool,
        admin,
        { expectedVersion: null },
        "non_production",
      ),
    ).toEqual({ ...activated, replayed: true });
    await expectCode(
      listAuthorizedEmploymentRecords(appPool, context()),
      "EMPLOYMENT_SERVICE_INACTIVE",
    );
    expect((await snapshot()).work).toBe(deniedBaseline.work);
  });

  it("serializes employee-own reads before a concurrent Workforce suspension", async () => {
    const fixture = await prepareRaceFixture(
      ids.tenantAccessRace,
      ids.hrAccessRace,
      ids.adminAccessRace,
      ids.employeeAccessRace,
    );
    const readControl = createControlledPool(
      appPool,
      (statement, values) =>
        statement.includes(" FROM hr_worker_profiles ") &&
        statement.includes(" principal_id=$2 ") &&
        statement.includes(" workforce_status='active' ") &&
        values[0] === ids.tenantAccessRace &&
        values[1] === ids.employeeAccessRace,
    );
    const statusControl = createControlledPool(appPool);
    const observer = await appPool.connect();
    let readOperation: ReturnType<typeof getAuthorizedEmploymentRecordDetail> | undefined;
    let statusOperation: ReturnType<typeof changeWorkforceStatus> | undefined;
    let readPid: number | undefined;
    let statusPid: number | undefined;
    try {
      readOperation = getAuthorizedEmploymentRecordDetail(
        readControl.pool,
        context(ids.employeeAccessRace, ids.tenantAccessRace),
        { employmentRecordId: fixture.employmentRecordId },
      );
      readPid = (
        await awaitControlledSignal(
          "employee authority resolver",
          readControl.paused,
          readOperation,
        )
      ).pid;
      statusOperation = changeWorkforceStatus(
        statusControl.pool,
        context(ids.hrAccessRace, ids.tenantAccessRace),
        {
          expectedVersion: fixture.workerProfileVersion,
          idempotencyKey: randomUUID(),
          status: "suspended",
          workerProfileId: fixture.workerProfileId,
        },
      );
      statusPid = await awaitControlledSignal(
        "Workforce suspension connection",
        statusControl.connected,
        statusOperation,
      );
      let statusSettled = false;
      void statusOperation.then(
        () => {
          statusSettled = true;
        },
        () => {
          statusSettled = true;
        },
      );
      expect(
        await observeDirectBlockerUntil(observer, statusPid, readPid, () => statusSettled),
      ).toBe(true);

      readControl.release();
      const detail = await readOperation;
      readOperation = undefined;
      const suspended = await statusOperation;
      statusOperation = undefined;
      expect(detail).toMatchObject({
        accessScope: "own",
        employmentRecordId: fixture.employmentRecordId,
      });
      expect(suspended.profile).toMatchObject({ workforceStatus: "suspended" });
      const afterSuspension = await snapshot(ids.tenantAccessRace);
      await expectCode(
        getAuthorizedEmploymentRecordDetail(
          appPool,
          context(ids.employeeAccessRace, ids.tenantAccessRace),
          { employmentRecordId: fixture.employmentRecordId },
        ),
        "POLICY_DENIED",
      );
      expect(await snapshot(ids.tenantAccessRace)).toEqual(afterSuspension);
      await expectBackendsIdle(observer, [readPid, statusPid]);
    } finally {
      readControl.release();
      statusControl.release();
      const pending: Promise<unknown>[] = [];
      if (readOperation) pending.push(readOperation);
      if (statusOperation) pending.push(statusOperation);
      await Promise.allSettled(pending);
      observer.release();
    }
  }, 15_000);

  it("serializes employment-type validation before a concurrent settings removal", async () => {
    const fixture = await prepareRaceFixture(
      ids.tenantSettingsRace,
      ids.hrSettingsRace,
      ids.adminSettingsRace,
      ids.employeeSettingsRace,
    );
    const versionControl = createControlledPool(
      appPool,
      (statement, values) =>
        statement.includes(" FROM hr_employment_record_service_control control ") &&
        statement.includes(" LEFT JOIN tenant_settings setting ") &&
        values[0] === ids.tenantSettingsRace &&
        values[1] === "hr.employment_record.employment_type_codes",
    );
    const settingsControl = createControlledPool(appPool);
    const observer = await appPool.connect();
    let versionOperation: ReturnType<typeof createEmploymentRecordVersion> | undefined;
    let settingsOperation: ReturnType<typeof configureEmploymentRecordService> | undefined;
    let versionPid: number | undefined;
    let settingsPid: number | undefined;
    try {
      versionOperation = createEmploymentRecordVersion(
        versionControl.pool,
        context(ids.hrSettingsRace, ids.tenantSettingsRace),
        {
          effectiveFrom: "2027-01-01",
          effectiveTo: "2027-12-31",
          employmentRecordId: fixture.employmentRecordId,
          employmentTypeCode: "race",
          expectedCurrentVersion: 1,
          expectedVersion: fixture.recordVersion,
          idempotencyKey: randomUUID(),
          organizationReference: null,
          positionReference: null,
        },
      );
      versionPid = (
        await awaitControlledSignal(
          "employment type settings resolver",
          versionControl.paused,
          versionOperation,
        )
      ).pid;
      settingsOperation = configureEmploymentRecordService(
        settingsControl.pool,
        context(ids.adminSettingsRace, ids.tenantSettingsRace),
        {
          expectedSettingsVersion: fixture.settingsVersion,
          settings: {
            effectiveRangeOverlapAllowed: false,
            employmentTypeCodes: "permanent",
          },
        },
      );
      settingsPid = await awaitControlledSignal(
        "Employment settings connection",
        settingsControl.connected,
        settingsOperation,
      );
      let settingsSettled = false;
      void settingsOperation.then(
        () => {
          settingsSettled = true;
        },
        () => {
          settingsSettled = true;
        },
      );
      expect(
        await observeDirectBlockerUntil(observer, settingsPid, versionPid, () => settingsSettled),
      ).toBe(true);

      versionControl.release();
      const version = await versionOperation;
      versionOperation = undefined;
      const configured = await settingsOperation;
      settingsOperation = undefined;
      expect(version.mutation).toMatchObject({
        currentVersion: 2,
        operation: "create_version",
        rootVersion: 3,
      });
      expect(configured.mutation).toMatchObject({ operation: "configure_service" });
      const afterConfiguration = await snapshot(ids.tenantSettingsRace);
      await expectCode(
        createEmploymentRecordVersion(
          appPool,
          context(ids.hrSettingsRace, ids.tenantSettingsRace),
          {
            effectiveFrom: "2028-01-01",
            effectiveTo: "2028-12-31",
            employmentRecordId: fixture.employmentRecordId,
            employmentTypeCode: "race",
            expectedCurrentVersion: 2,
            expectedVersion: version.mutation.rootVersion,
            idempotencyKey: randomUUID(),
            organizationReference: null,
            positionReference: null,
          },
        ),
        "EMPLOYMENT_INPUT_INVALID",
      );
      expect(await snapshot(ids.tenantSettingsRace)).toEqual(afterConfiguration);
      await expectBackendsIdle(observer, [versionPid, settingsPid]);
    } finally {
      versionControl.release();
      settingsControl.release();
      const pending: Promise<unknown>[] = [];
      if (versionOperation) pending.push(versionOperation);
      if (settingsOperation) pending.push(settingsOperation);
      await Promise.allSettled(pending);
      observer.release();
    }
  }, 15_000);

  it("returns one coherent root, head, and history before a concurrent successor", async () => {
    const fixture = await prepareRaceFixture(
      ids.tenantDetailRace,
      ids.hrDetailRace,
      ids.adminDetailRace,
      ids.employeeDetailRace,
    );
    const detailControl = createControlledPool(
      appPool,
      (statement, values) =>
        statement.includes(" FROM hr_employment_records record ") &&
        statement.includes(" LEFT JOIN hr_employment_record_versions head ") &&
        values[0] === ids.tenantDetailRace &&
        values[1] === fixture.employmentRecordId,
    );
    const versionControl = createControlledPool(appPool);
    const observer = await appPool.connect();
    let detailOperation: ReturnType<typeof getAuthorizedEmploymentRecordDetail> | undefined;
    let versionOperation: ReturnType<typeof createEmploymentRecordVersion> | undefined;
    let detailPid: number | undefined;
    let versionPid: number | undefined;
    try {
      detailOperation = getAuthorizedEmploymentRecordDetail(
        detailControl.pool,
        context(ids.employeeDetailRace, ids.tenantDetailRace),
        { employmentRecordId: fixture.employmentRecordId },
      );
      detailPid = (
        await awaitControlledSignal("employment detail root", detailControl.paused, detailOperation)
      ).pid;
      versionOperation = createEmploymentRecordVersion(
        versionControl.pool,
        context(ids.hrDetailRace, ids.tenantDetailRace),
        {
          effectiveFrom: "2027-01-01",
          effectiveTo: "2027-12-31",
          employmentRecordId: fixture.employmentRecordId,
          employmentTypeCode: "race",
          expectedCurrentVersion: 1,
          expectedVersion: fixture.recordVersion,
          idempotencyKey: randomUUID(),
          organizationReference: "detail-race-successor",
          positionReference: null,
        },
      );
      versionPid = await awaitControlledSignal(
        "employment successor connection",
        versionControl.connected,
        versionOperation,
      );
      let versionSettled = false;
      void versionOperation.then(
        () => {
          versionSettled = true;
        },
        () => {
          versionSettled = true;
        },
      );
      expect(
        await observeDirectBlockerUntil(observer, versionPid, detailPid, () => versionSettled),
      ).toBe(true);

      detailControl.release();
      const detail = await detailOperation;
      detailOperation = undefined;
      const successor = await versionOperation;
      versionOperation = undefined;
      expect(detail).toMatchObject({
        currentVersion: { version: 1 },
        history: { items: [{ version: 1 }], nextCursor: null },
        version: 2,
      });
      expect(successor.mutation).toMatchObject({
        currentVersion: 2,
        rootVersion: 3,
      });
      const current = await getAuthorizedEmploymentRecordDetail(
        appPool,
        context(ids.employeeDetailRace, ids.tenantDetailRace),
        { employmentRecordId: fixture.employmentRecordId },
      );
      expect(current).toMatchObject({
        currentVersion: { organizationReference: "detail-race-successor", version: 2 },
        history: { items: [{ version: 2 }, { version: 1 }], nextCursor: null },
        version: 3,
      });
      await expectBackendsIdle(observer, [detailPid, versionPid]);
    } finally {
      detailControl.release();
      versionControl.release();
      const pending: Promise<unknown>[] = [];
      if (detailOperation) pending.push(detailOperation);
      if (versionOperation) pending.push(versionOperation);
      await Promise.allSettled(pending);
      observer.release();
    }
  }, 15_000);
});
