import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readWorkforceTenantSnapshot,
  setupWorkforceIntegration,
  teardownWorkforceIntegration,
  withWorkforceTenant,
  workforceApplicationRole,
  workforceContext,
  workforceIds,
  workforceMigrationPool,
  workforcePool,
} from "./workforce.integration-fixture.js";
import {
  changeWorkforceReportingRelationship,
  changeWorkforceStatus,
  createWorkforceProfile,
  linkWorkforcePrincipal,
} from "./workforce-commands.js";
import { getOwnWorkforceProfile, listAuthorizedWorkforceProfiles } from "./workforce-queries.js";
import type { ChangeWorkforceReportingRelationshipInput } from "./workforce-types.js";

function context(
  tenantId: string = workforceIds.tenantA,
  actorPrincipalId: string = workforceIds.hrOperatorA,
) {
  return workforceContext(tenantId, actorPrincipalId, randomUUID());
}

async function tenantQuery<Row extends QueryResultRow>(
  tenantId: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  let rows: Row[] = [];
  await withWorkforceTenant(tenantId, async (client) => {
    rows = (await client.query<Row>(text, [...values])).rows;
  });
  return rows;
}

async function setCapability(capabilityId: string, present: boolean): Promise<void> {
  await tenantQuery(
    workforceIds.tenantA,
    present
      ? `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
      : `DELETE FROM membership_capabilities
         WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = $3`,
    [workforceIds.tenantA, workforceIds.hrOperatorA, capabilityId],
  );
}

async function setActorState(roleKey: string, status = "active"): Promise<void> {
  await tenantQuery(
    workforceIds.tenantA,
    `UPDATE memberships SET role_key = $3, status = $4
     WHERE tenant_id = $1 AND principal_id = $2`,
    [workforceIds.tenantA, workforceIds.hrOperatorA, roleKey, status],
  );
}

async function setServiceState(state: "active" | "inactive"): Promise<void> {
  await tenantQuery(
    workforceIds.tenantA,
    `UPDATE service_activations SET state = $2, version = version + 1
     WHERE tenant_id = $1 AND service_key = 'workforce_profile'`,
    [workforceIds.tenantA, state],
  );
}
async function setReplayDenial(
  state: "actor" | "capability" | "service",
  denied: boolean,
): Promise<void> {
  if (state === "actor") return setActorState(denied ? "employee" : "hr_operator");
  if (state === "capability")
    return setCapability("hr.workforce.change_reporting_relationship", !denied);
  return setServiceState(denied ? "inactive" : "active");
}

async function setBooleanSetting(key: string, value: boolean | null): Promise<void> {
  await tenantQuery(
    workforceIds.tenantA,
    value === null
      ? "DELETE FROM tenant_settings WHERE tenant_id = $1 AND setting_key = $2"
      : `INSERT INTO tenant_settings (tenant_id, setting_key, value_type, value)
         VALUES ($1, $2, 'boolean', $3::jsonb)
         ON CONFLICT (tenant_id, setting_key) DO UPDATE
         SET value = excluded.value, version = tenant_settings.version + 1`,
    value === null
      ? [workforceIds.tenantA, key]
      : [workforceIds.tenantA, key, JSON.stringify(value)],
  );
}

async function createActiveReportingProfile(
  roleKey: "employee" | "manager",
  tenantId: string = workforceIds.tenantA,
  actorPrincipalId: string = workforceIds.hrOperatorA,
) {
  const principalId = randomUUID();
  await workforceMigrationPool.query(
    "INSERT INTO principals (principal_id, display_name) VALUES ($1, 'Synthetic reporting actor')",
    [principalId],
  );
  await tenantQuery(
    tenantId,
    `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), tenantId, principalId, roleKey],
  );
  const actorContext = () => context(tenantId, actorPrincipalId);
  const created = await createWorkforceProfile(workforcePool, actorContext(), {
    idempotencyKey: randomUUID(),
  });
  const linked = await linkWorkforcePrincipal(workforcePool, actorContext(), {
    expectedVersion: created.profile.version,
    idempotencyKey: randomUUID(),
    principalId,
    workerProfileId: created.profile.workerProfileId,
  });
  const active = await changeWorkforceStatus(workforcePool, actorContext(), {
    expectedVersion: linked.profile.version,
    idempotencyKey: randomUUID(),
    status: "active",
    workerProfileId: created.profile.workerProfileId,
  });
  return { principalId, workerProfileId: active.profile.workerProfileId };
}
function reportingInput(
  workerProfileId: string,
  expectedVersion: number,
  managerWorkerProfileId: string | null,
  relationshipStatus: "assigned" | "unassigned" = "assigned",
  idempotencyKey: string = randomUUID(),
): ChangeWorkforceReportingRelationshipInput {
  return {
    expectedVersion,
    idempotencyKey,
    managerWorkerProfileId,
    relationshipStatus,
    workerProfileId,
  };
}
function changeReporting(
  input: ChangeWorkforceReportingRelationshipInput,
  operationContext = context(),
) {
  return changeWorkforceReportingRelationship(workforcePool, operationContext, input);
}
async function setReportingRole(principalId: string, role: string, status = "active") {
  await tenantQuery(
    workforceIds.tenantA,
    "UPDATE memberships SET role_key=$3, status=$4 WHERE tenant_id=$1 AND principal_id=$2",
    [workforceIds.tenantA, principalId, role, status],
  );
}
async function setListCapability(principalId: string, present: boolean) {
  await tenantQuery(
    workforceIds.tenantA,
    present
      ? `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.workforce.list_authorized') ON CONFLICT DO NOTHING`
      : `DELETE FROM membership_capabilities
         WHERE tenant_id=$1 AND principal_id=$2
           AND capability_id='hr.workforce.list_authorized'`,
    [workforceIds.tenantA, principalId],
  );
}
async function setReportingStatus(workerProfileId: string, workforceStatus: string): Promise<void> {
  await withWorkforceTenant(workforceIds.tenantA, async (client) => {
    await client.query(
      "SELECT set_config('app.actor_principal_id',$1,true), set_config('app.correlation_id',$2,true)",
      [workforceIds.hrOperatorA, randomUUID()],
    );
    await client.query(
      "UPDATE hr_worker_profiles SET workforce_status=$3, row_version=row_version+1 WHERE tenant_id=$1 AND worker_profile_id=$2",
      [workforceIds.tenantA, workerProfileId, workforceStatus],
    );
  });
}
async function reportingSnapshot(tenantId: string, workerProfileId: string) {
  const [state] = await tenantQuery(
    tenantId,
    `SELECT current_reporting_relationship_id AS head, row_version AS version,
       (SELECT count(*)::int FROM hr_reporting_relationships WHERE tenant_id=$1 AND worker_profile_id=$2) relationships,
       (SELECT count(*)::int FROM hr_workforce_status_history WHERE tenant_id=$1 AND worker_profile_id=$2) history,
       (SELECT count(*)::int FROM evidence_events WHERE tenant_id=$1) evidence,
       (SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1) outbox,
       (SELECT count(*)::int FROM work_items WHERE tenant_id=$1) work
     FROM hr_worker_profiles WHERE tenant_id=$1 AND worker_profile_id=$2`,
    [tenantId, workerProfileId],
  );
  if (!state) throw new Error("Reporting profile snapshot was unavailable");
  return state;
}
describe("Workforce Profile domain", () => {
  beforeAll(setupWorkforceIntegration);
  afterAll(teardownWorkforceIntegration);

  it("requires the current HR-operator role even when tenant admin has the capability", async () => {
    const before = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    await expect(
      createWorkforceProfile(
        workforcePool,
        workforceContext(
          workforceIds.tenantA,
          workforceIds.tenantAdminA,
          workforceIds.correlationTenantAdmin,
        ),
        {
          employeeNumber: "EMP-RED",
          idempotencyKey: workforceIds.idempotencyTenantAdmin,
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(before);
  });

  it("requires the exact current capability and permits the role-plus-capability control", async () => {
    const before = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    await setCapability("hr.workforce.create_profile", false);
    try {
      await expect(
        createWorkforceProfile(workforcePool, context(), {
          employeeNumber: "EMP-NO-CAP",
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await setCapability("hr.workforce.create_profile", true);
    }
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(before);

    const result = await createWorkforceProfile(workforcePool, context(), {
      employeeNumber: " EMP-AUTHORIZED ",
      idempotencyKey: randomUUID(),
    });
    expect(result).toMatchObject({
      billingState: "non_billable",
      profile: {
        employeeNumber: " EMP-AUTHORIZED ",
        principalLinked: false,
        version: 1,
        workforceStatus: "draft",
      },
      replayed: false,
    });
  });

  it("serializes concurrent create replay and binds idempotency separately from correlation", async () => {
    const before = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    const idempotencyKey = randomUUID();
    const correlations = [randomUUID(), randomUUID()] as const;
    const results = await Promise.all(
      correlations.map((correlationId) =>
        createWorkforceProfile(
          workforcePool,
          workforceContext(workforceIds.tenantA, workforceIds.hrOperatorA, correlationId),
          { employeeNumber: "EMP-CONCURRENT", idempotencyKey },
        ),
      ),
    );
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(results[0]?.profile).toEqual(results[1]?.profile);
    const after = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    expect(after).toEqual({
      evidence: before.evidence + 2,
      history: before.history + 1,
      outbox: before.outbox + 1,
      profiles: before.profiles + 1,
      work: before.work,
    });
    const receipts = await tenantQuery<{ correlation_id: string }>(
      workforceIds.tenantA,
      `SELECT correlation_id FROM evidence_events
       WHERE tenant_id = $1 AND subject_type = 'hr.workforce_profile.idempotency'
         AND event_type = 'hr.workforce_profile.create_profile.response_bound'
       ORDER BY occurred_at DESC LIMIT 1`,
      [workforceIds.tenantA],
    );
    expect(correlations).toContain(receipts[0]?.correlation_id);
    expect(receipts[0]?.correlation_id).not.toBe(idempotencyKey);

    await expect(
      createWorkforceProfile(workforcePool, context(), {
        employeeNumber: "EMP-CHANGED",
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(after);

    const nullKey = randomUUID();
    const nullCreate = await createWorkforceProfile(workforcePool, context(), {
      idempotencyKey: nullKey,
    });
    expect(
      await createWorkforceProfile(workforcePool, context(), {
        idempotencyKey: nullKey.toUpperCase(),
      }),
    ).toEqual({ ...nullCreate, replayed: true });
    const nullBaseline = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    await expect(
      createWorkforceProfile(workforcePool, context(), {
        employeeNumber: "<null>",
        idempotencyKey: nullKey,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(nullBaseline);
  });

  it("executes the complete lifecycle, original replay, own projection, and one-winner CAS", async () => {
    const createKey = randomUUID();
    const created = await createWorkforceProfile(workforcePool, context(), {
      employeeNumber: "EMP-LIFECYCLE",
      idempotencyKey: createKey,
    });
    expect(Object.keys(created.profile).sort()).toEqual([
      "employeeNumber",
      "principalLinked",
      "version",
      "workerProfileId",
      "workforceStatus",
    ]);
    await expect(
      getOwnWorkforceProfile(workforcePool, context(workforceIds.tenantA, workforceIds.employeeA)),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_NOT_FOUND" });

    const linkInput = {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      principalId: workforceIds.employeeA,
      workerProfileId: created.profile.workerProfileId,
    };
    const linked = await linkWorkforcePrincipal(workforcePool, context(), linkInput);
    expect(linked).toMatchObject({
      billingState: "non_billable",
      profile: { principalLinked: true, version: 2, workforceStatus: "draft" },
      replayed: false,
    });
    expect(await linkWorkforcePrincipal(workforcePool, context(), linkInput)).toEqual({
      ...linked,
      replayed: true,
    });
    await expect(
      linkWorkforcePrincipal(workforcePool, context(), {
        ...linkInput,
        principalId: workforceIds.tenantAdminA,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const activeKey = randomUUID();
    const activeInput = {
      expectedVersion: 2,
      idempotencyKey: activeKey,
      status: "active" as const,
      workerProfileId: created.profile.workerProfileId,
    };
    const active = await changeWorkforceStatus(workforcePool, context(), activeInput);
    expect(active).toMatchObject({
      billingState: "non_billable",
      profile: { principalLinked: true, version: 3, workforceStatus: "active" },
    });
    const activeSnapshot = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    expect(await changeWorkforceStatus(workforcePool, context(), activeInput)).toEqual({
      ...active,
      replayed: true,
    });
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(activeSnapshot);
    expect(
      await getOwnWorkforceProfile(
        workforcePool,
        context(workforceIds.tenantA, workforceIds.employeeA),
      ),
    ).toEqual(active.profile);

    const contenders = await Promise.allSettled([
      changeWorkforceStatus(workforcePool, context(), {
        expectedVersion: 3,
        idempotencyKey: randomUUID(),
        status: "suspended",
        workerProfileId: created.profile.workerProfileId,
      }),
      changeWorkforceStatus(workforcePool, context(), {
        expectedVersion: 3,
        idempotencyKey: randomUUID(),
        status: "suspended",
        workerProfileId: created.profile.workerProfileId,
      }),
    ]);
    const winner = contenders.find((result) => result.status === "fulfilled");
    const loser = contenders.find((result) => result.status === "rejected");
    expect(winner).toMatchObject({
      status: "fulfilled",
      value: { profile: { version: 4, workforceStatus: "suspended" } },
    });
    expect(loser).toMatchObject({
      reason: { code: "WORKFORCE_VERSION_CONFLICT" },
      status: "rejected",
    });
    await expect(
      getOwnWorkforceProfile(workforcePool, context(workforceIds.tenantA, workforceIds.employeeA)),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_NOT_FOUND" });

    const reactivated = await changeWorkforceStatus(workforcePool, context(), {
      expectedVersion: 4,
      idempotencyKey: randomUUID(),
      status: "active",
      workerProfileId: created.profile.workerProfileId,
    });
    const terminated = await changeWorkforceStatus(workforcePool, context(), {
      expectedVersion: reactivated.profile.version,
      idempotencyKey: randomUUID(),
      status: "terminated",
      workerProfileId: created.profile.workerProfileId,
    });
    expect(terminated.profile).toMatchObject({ version: 6, workforceStatus: "terminated" });
    await expect(
      getOwnWorkforceProfile(workforcePool, context(workforceIds.tenantA, workforceIds.employeeA)),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_NOT_FOUND" });

    const terminalSnapshot = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    await expect(
      changeWorkforceStatus(workforcePool, context(), {
        expectedVersion: 6,
        idempotencyKey: randomUUID(),
        status: "active",
        workerProfileId: created.profile.workerProfileId,
      }),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_CONFLICT" });
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(terminalSnapshot);

    const createReplay = await createWorkforceProfile(workforcePool, context(), {
      employeeNumber: "EMP-LIFECYCLE",
      idempotencyKey: createKey,
    });
    expect(createReplay).toEqual({ ...created, replayed: true });
    const [storedProof] = await tenantQuery<{ payload: Record<string, unknown> }>(
      workforceIds.tenantA,
      `SELECT payload FROM outbox_events
       WHERE tenant_id = $1 AND aggregate_id = $2 AND aggregate_version = 3
         AND event_type = 'hr.workforce_profile.change_status'`,
      [workforceIds.tenantA, created.profile.workerProfileId],
    );
    if (!storedProof) throw new Error("Stored status proof was unavailable");
    await tenantQuery(
      workforceIds.tenantA,
      `UPDATE outbox_events SET payload = payload || '{"principalId":"forbidden"}'::jsonb
       WHERE tenant_id = $1 AND aggregate_id = $2 AND aggregate_version = 3`,
      [workforceIds.tenantA, created.profile.workerProfileId],
    );
    try {
      await expect(
        changeWorkforceStatus(workforcePool, context(), activeInput),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    } finally {
      await tenantQuery(
        workforceIds.tenantA,
        `UPDATE outbox_events SET payload = $3::jsonb
         WHERE tenant_id = $1 AND aggregate_id = $2 AND aggregate_version = 3`,
        [
          workforceIds.tenantA,
          created.profile.workerProfileId,
          JSON.stringify(storedProof.payload),
        ],
      );
    }
    const history = await tenantQuery<{ new_status: string; previous_status: string | null }>(
      workforceIds.tenantA,
      `SELECT previous_status, new_status FROM hr_workforce_status_history
       WHERE tenant_id = $1 AND worker_profile_id = $2
       ORDER BY effective_at, workforce_status_history_id`,
      [workforceIds.tenantA, created.profile.workerProfileId],
    );
    expect(history).toEqual([
      { new_status: "draft", previous_status: null },
      { new_status: "active", previous_status: "draft" },
      { new_status: "suspended", previous_status: "active" },
      { new_status: "active", previous_status: "suspended" },
      { new_status: "terminated", previous_status: "active" },
    ]);
    const payloads = await tenantQuery<{ payload: Record<string, unknown> }>(
      workforceIds.tenantA,
      `SELECT payload FROM outbox_events
       WHERE tenant_id = $1 AND aggregate_type = 'hr.workforce_profile'
         AND aggregate_id = $2`,
      [workforceIds.tenantA, created.profile.workerProfileId],
    );
    expect(payloads).toHaveLength(6);
    for (const { payload } of payloads) {
      expect(payload).not.toHaveProperty("actorPrincipalId");
      expect(payload).not.toHaveProperty("correlationId");
      expect(payload).not.toHaveProperty("employeeNumber");
      expect(payload).not.toHaveProperty("principalId");
      expect(payload).not.toHaveProperty("tenantId");
    }
  });

  it("applies settings and denies stale authority, inactive service, and cross-tenant IDs", async () => {
    const requiredKey = "hr.workforce_profile.employee_number_required";
    const unlinkedKey = "hr.workforce_profile.unlinked_worker_creation_allowed";
    const beforeSettings = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    await setBooleanSetting(requiredKey, true);
    try {
      await expect(
        createWorkforceProfile(workforcePool, context(), { idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: "WORKFORCE_INPUT_INVALID" });
      await setBooleanSetting(unlinkedKey, false);
      await expect(
        createWorkforceProfile(workforcePool, context(), {
          employeeNumber: "EMP-BLOCKED",
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await setBooleanSetting(requiredKey, null);
      await setBooleanSetting(unlinkedKey, null);
    }
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(beforeSettings);

    const idempotencyKey = randomUUID();
    await createWorkforceProfile(workforcePool, context(), {
      employeeNumber: "EMP-AUTHORITY",
      idempotencyKey,
    });
    const authorityBaseline = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    for (const state of ["demoted", "capability_revoked", "suspended", "inactive"] as const) {
      try {
        if (state === "demoted") await setActorState("employee");
        if (state === "capability_revoked") {
          await setCapability("hr.workforce.create_profile", false);
        }
        if (state === "suspended") await setActorState("hr_operator", "suspended");
        if (state === "inactive") await setServiceState("inactive");
        await expect(
          createWorkforceProfile(workforcePool, context(), {
            employeeNumber: "EMP-AUTHORITY",
            idempotencyKey,
          }),
        ).rejects.toMatchObject({
          code:
            state === "suspended"
              ? "ACTOR_NOT_ACTIVE_MEMBER"
              : state === "inactive"
                ? "WORKFORCE_SERVICE_INACTIVE"
                : "POLICY_DENIED",
        });
      } finally {
        if (state === "demoted" || state === "suspended") await setActorState("hr_operator");
        if (state === "capability_revoked") {
          await setCapability("hr.workforce.create_profile", true);
        }
        if (state === "inactive") await setServiceState("active");
      }
      expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(authorityBaseline);
    }

    const tenantAProfile = await createWorkforceProfile(workforcePool, context(), {
      employeeNumber: "EMP-TENANT-A",
      idempotencyKey: randomUUID(),
    });
    const beforeA = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    const beforeB = await readWorkforceTenantSnapshot(workforceIds.tenantB);
    await expect(
      linkWorkforcePrincipal(
        workforcePool,
        context(workforceIds.tenantB, workforceIds.hrOperatorB),
        {
          expectedVersion: 1,
          idempotencyKey: randomUUID(),
          principalId: workforceIds.employeeB,
          workerProfileId: tenantAProfile.profile.workerProfileId,
        },
      ),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_NOT_FOUND" });
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(beforeA);
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantB)).toEqual(beforeB);
  });

  it("rolls profile, history, evidence, outbox, and work back when proof cannot commit", async () => {
    const before = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    await workforceMigrationPool.query(
      `REVOKE INSERT ON outbox_events FROM ${workforceApplicationRole}`,
    );
    try {
      await expect(
        createWorkforceProfile(workforcePool, context(), {
          employeeNumber: "EMP-ROLLBACK",
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await workforceMigrationPool.query(
        `GRANT INSERT ON outbox_events TO ${workforceApplicationRole}`,
      );
    }
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(before);
  });
  it("appends and replays one immutable assign/unassign chain with minimized proof", async () => {
    const report = await createActiveReportingProfile("employee");
    const manager = await createActiveReportingProfile("manager");
    const before = await reportingSnapshot(workforceIds.tenantA, report.workerProfileId);
    const assign = reportingInput(report.workerProfileId, before.version, manager.workerProfileId);
    const assigned = await changeReporting(assign);
    expect(assigned).toMatchObject({
      billingState: "non_billable",
      replayed: false,
      relationship: {
        effectiveAt: expect.any(String),
        managerWorkerProfileId: manager.workerProfileId,
        relationshipStatus: "assigned",
        relationshipVersion: 1,
        reportingRelationshipId: expect.any(String),
        supersedesReportingRelationshipId: null,
        workerProfileId: report.workerProfileId,
        workerProfileVersion: before.version + 1,
      },
    });
    expect(await changeReporting(assign)).toEqual({ ...assigned, replayed: true });
    const replayBaseline = await reportingSnapshot(workforceIds.tenantA, report.workerProfileId);
    for (const [state, code] of [
      ["actor", "POLICY_DENIED"],
      ["capability", "POLICY_DENIED"],
      ["service", "WORKFORCE_SERVICE_INACTIVE"],
    ] as const) {
      await setReplayDenial(state, true);
      try {
        await expect(changeReporting(assign)).rejects.toMatchObject({ code });
      } finally {
        await setReplayDenial(state, false);
      }
      expect(await reportingSnapshot(workforceIds.tenantA, report.workerProfileId)).toEqual(
        replayBaseline,
      );
    }
    await expect(
      changeReporting({
        ...assign,
        expectedVersion: before.version + 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_CONFLICT" });
    expect(await reportingSnapshot(workforceIds.tenantA, report.workerProfileId)).toEqual(
      replayBaseline,
    );
    await expect(
      changeReporting({
        ...assign,
        relationshipStatus: "unassigned",
        managerWorkerProfileId: null,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const unassigned = await changeReporting(
      reportingInput(report.workerProfileId, before.version + 1, null, "unassigned"),
    );
    expect(unassigned.relationship).toMatchObject({
      managerWorkerProfileId: null,
      relationshipStatus: "unassigned",
      relationshipVersion: 2,
      supersedesReportingRelationshipId: assigned.relationship.reportingRelationshipId,
      workerProfileVersion: before.version + 2,
    });
    const after = await reportingSnapshot(workforceIds.tenantA, report.workerProfileId);
    expect(after).toEqual({
      ...before,
      evidence: before.evidence + 4,
      head: unassigned.relationship.reportingRelationshipId,
      outbox: before.outbox + 2,
      relationships: before.relationships + 2,
      version: before.version + 2,
    });
    const proof = await tenantQuery<{ identity: string; payload: Record<string, unknown> }>(
      workforceIds.tenantA,
      `SELECT concat_ws('|', evidence.subject_id, evidence.subject_type, outbox.aggregate_id,
                        outbox.aggregate_type, outbox.aggregate_version,
                        (evidence.correlation_id=outbox.correlation_id)::text) identity,
              outbox.payload
       FROM evidence_events evidence JOIN outbox_events outbox
         ON outbox.tenant_id=evidence.tenant_id AND outbox.event_type=evidence.event_type
        AND outbox.aggregate_type=evidence.subject_type AND outbox.aggregate_id=evidence.subject_id
        AND outbox.correlation_id=evidence.correlation_id
       WHERE evidence.tenant_id=$1
         AND evidence.event_type='hr.workforce_profile.change_reporting_relationship'
         AND evidence.subject_type='hr.workforce_profile.reporting_relationship'
         AND evidence.subject_id=ANY($2::uuid[])`,
      [
        workforceIds.tenantA,
        [
          assigned.relationship.reportingRelationshipId,
          unassigned.relationship.reportingRelationshipId,
        ],
      ],
    );
    const proofIdentity = (relationship: typeof assigned.relationship) =>
      `${relationship.reportingRelationshipId}|hr.workforce_profile.reporting_relationship|${relationship.reportingRelationshipId}|hr.workforce_profile.reporting_relationship|${relationship.relationshipVersion}|true`;
    expect(proof.map(({ identity }) => identity).sort()).toEqual(
      [proofIdentity(assigned.relationship), proofIdentity(unassigned.relationship)].sort(),
    );
    const proofKeys =
      "action afterVersion beforeVersion managerAssigned receiptId relationshipStatus reportingRelationshipId workerProfileId workerProfileVersion";
    for (const { payload } of proof)
      expect(Object.keys(payload).sort()).toEqual(proofKeys.split(" "));
  });
  it("lists status-filtered workforce or current direct reports through current authority", async () => {
    const manager = await createActiveReportingProfile("manager");
    const [firstReport, secondReport, staleReport] = await Promise.all([
      createActiveReportingProfile("employee"),
      createActiveReportingProfile("employee"),
      createActiveReportingProfile("employee"),
    ]);
    await changeReporting(reportingInput(firstReport.workerProfileId, 3, manager.workerProfileId));
    await changeReporting(reportingInput(secondReport.workerProfileId, 3, manager.workerProfileId));
    await changeReporting(reportingInput(staleReport.workerProfileId, 3, manager.workerProfileId));
    await changeReporting(reportingInput(staleReport.workerProfileId, 4, null, "unassigned"));
    await tenantQuery(
      workforceIds.tenantA,
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       VALUES ($1, $2, 'hr.workforce.list_authorized'),
              ($1, $3, 'hr.workforce.list_authorized'),
              ($1, $4, 'hr.workforce.list_authorized')`,
      [
        workforceIds.tenantA,
        workforceIds.hrOperatorA,
        manager.principalId,
        workforceIds.tenantAdminA,
      ],
    );
    const before = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    try {
      const workforce = await listAuthorizedWorkforceProfiles(workforcePool, context(), {
        pageSize: 1,
        status: "active",
      });
      expect(workforce).toMatchObject({ kind: "workforce", items: expect.any(Array) });
      if (workforce.kind !== "workforce") {
        throw new Error("Expected a workforce page");
      }
      expect(workforce.items).toHaveLength(1);
      expect(workforce.items.every((item) => item.workforceStatus === "active")).toBe(true);
      expect(workforce.nextCursor).toEqual({
        createdAt: expect.any(String),
        workerProfileId: expect.any(String),
      });
      if (!workforce.nextCursor) throw new Error("Expected one workforce cursor");
      const nextWorkforce = await listAuthorizedWorkforceProfiles(workforcePool, context(), {
        cursor: workforce.nextCursor,
        pageSize: 1,
        status: "active",
      });
      if (nextWorkforce.kind !== "workforce") throw new Error("Expected a workforce page");
      expect(nextWorkforce.items).toHaveLength(1);
      expect(nextWorkforce.items[0]?.workerProfileId).not.toBe(workforce.items[0]?.workerProfileId);

      const firstPage = await listAuthorizedWorkforceProfiles(
        workforcePool,
        context(workforceIds.tenantA, manager.principalId),
        { pageSize: 1 },
      );
      expect(firstPage).toMatchObject({
        items: [
          { profile: { principalLinked: true }, relationship: { relationshipStatus: "assigned" } },
        ],
        kind: "direct_reports",
        nextCursor: {
          effectiveAt: expect.any(String),
          reportingRelationshipId: expect.any(String),
        },
      });
      if (firstPage.kind !== "direct_reports" || !firstPage.nextCursor) {
        throw new Error("Expected one direct-report cursor");
      }
      const secondPage = await listAuthorizedWorkforceProfiles(
        workforcePool,
        context(workforceIds.tenantA, manager.principalId),
        { cursor: firstPage.nextCursor, pageSize: 1 },
      );
      expect(secondPage.kind).toBe("direct_reports");
      if (secondPage.kind !== "direct_reports") {
        throw new Error("Expected a direct-report page");
      }
      expect(
        [...firstPage.items, ...secondPage.items]
          .map(({ profile }) => profile.workerProfileId)
          .sort(),
      ).toEqual([firstReport.workerProfileId, secondReport.workerProfileId].sort());
      const currentReports = await listAuthorizedWorkforceProfiles(
        workforcePool,
        context(workforceIds.tenantA, manager.principalId),
        { pageSize: 50 },
      );
      if (currentReports.kind !== "direct_reports") {
        throw new Error("Expected a direct-report page");
      }
      expect(currentReports.items.map(({ profile }) => profile.workerProfileId).sort()).toEqual(
        [firstReport.workerProfileId, secondReport.workerProfileId].sort(),
      );

      await expect(
        listAuthorizedWorkforceProfiles(
          workforcePool,
          context(workforceIds.tenantA, manager.principalId),
          { status: "active" },
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(listAuthorizedWorkforceProfiles(workforcePool, context())).rejects.toMatchObject(
        { code: "POLICY_DENIED" },
      );

      await setListCapability(manager.principalId, false);
      try {
        await expect(
          listAuthorizedWorkforceProfiles(
            workforcePool,
            context(workforceIds.tenantA, manager.principalId),
          ),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      } finally {
        await setListCapability(manager.principalId, true);
      }
      await setListCapability(workforceIds.hrOperatorA, false);
      try {
        await expect(
          listAuthorizedWorkforceProfiles(workforcePool, context(), { status: "active" }),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      } finally {
        await setListCapability(workforceIds.hrOperatorA, true);
      }

      await expect(
        listAuthorizedWorkforceProfiles(
          workforcePool,
          context(workforceIds.tenantA, workforceIds.tenantAdminA),
          { status: "active" },
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await setReportingRole(manager.principalId, "employee");
      await expect(
        listAuthorizedWorkforceProfiles(
          workforcePool,
          context(workforceIds.tenantA, manager.principalId),
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await setReportingRole(manager.principalId, "manager");
      await tenantQuery(
        workforceIds.tenantA,
        `INSERT INTO tenant_settings (tenant_id, setting_key, value_type, value)
         VALUES ($1, 'hr.workforce_profile.manager_visibility', 'enum', '"none"'::jsonb)`,
        [workforceIds.tenantA],
      );
      await expect(
        listAuthorizedWorkforceProfiles(
          workforcePool,
          context(workforceIds.tenantA, manager.principalId),
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await setReportingRole(manager.principalId, "manager");
      await tenantQuery(
        workforceIds.tenantA,
        `DELETE FROM tenant_settings
         WHERE tenant_id = $1 AND setting_key = 'hr.workforce_profile.manager_visibility'`,
        [workforceIds.tenantA],
      );
      await tenantQuery(
        workforceIds.tenantA,
        `DELETE FROM membership_capabilities
         WHERE tenant_id = $1 AND capability_id = 'hr.workforce.list_authorized'
           AND principal_id = ANY($2::uuid[])`,
        [
          workforceIds.tenantA,
          [workforceIds.hrOperatorA, manager.principalId, workforceIds.tenantAdminA],
        ],
      );
    }
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual(before);
  });
  it("table-drives authority, activation, manager-eligibility, and tenant denials", async () => {
    const report = await createActiveReportingProfile("employee");
    const manager = await createActiveReportingProfile("manager");
    const foreign = await createActiveReportingProfile(
      "employee",
      workforceIds.tenantB,
      workforceIds.hrOperatorB,
    );
    const foreignBefore = await reportingSnapshot(workforceIds.tenantB, foreign.workerProfileId);
    const before = await reportingSnapshot(workforceIds.tenantA, report.workerProfileId);
    const cases = [
      ["capability", "POLICY_DENIED", manager.workerProfileId],
      ["service", "WORKFORCE_SERVICE_INACTIVE", manager.workerProfileId],
      ["manager", "WORKFORCE_PROFILE_CONFLICT", manager.workerProfileId],
      ["manager-membership", "WORKFORCE_PROFILE_CONFLICT", manager.workerProfileId],
      ["manager-profile", "WORKFORCE_PROFILE_CONFLICT", manager.workerProfileId],
      ["tenant", "WORKFORCE_PROFILE_NOT_FOUND", foreign.workerProfileId],
    ] as const;
    for (const [state, code, managerId] of cases) {
      if (state === "capability")
        await setCapability("hr.workforce.change_reporting_relationship", false);
      if (state === "service") await setServiceState("inactive");
      if (state === "manager") await setReportingRole(manager.principalId, "employee");
      if (state === "manager-membership")
        await setReportingRole(manager.principalId, "manager", "suspended");
      if (state === "manager-profile")
        await setReportingStatus(manager.workerProfileId, "suspended");
      try {
        await expect(
          changeReporting(reportingInput(report.workerProfileId, before.version, managerId)),
        ).rejects.toMatchObject({ code });
      } finally {
        if (state === "capability")
          await setCapability("hr.workforce.change_reporting_relationship", true);
        if (state === "service") await setServiceState("active");
        if (state === "manager") await setReportingRole(manager.principalId, "manager");
        if (state === "manager-membership") await setReportingRole(manager.principalId, "manager");
        if (state === "manager-profile")
          await setReportingStatus(manager.workerProfileId, "active");
      }
      expect(await reportingSnapshot(workforceIds.tenantA, report.workerProfileId)).toEqual(before);
    }
    expect(await reportingSnapshot(workforceIds.tenantB, foreign.workerProfileId)).toEqual(
      foreignBefore,
    );
  });
  it("rejects self/indirect cycles and serializes reciprocal assignments", async () => {
    const [a, b, c, m1, m2] = await Promise.all([
      createActiveReportingProfile("manager"),
      createActiveReportingProfile("manager"),
      createActiveReportingProfile("manager"),
      createActiveReportingProfile("manager"),
      createActiveReportingProfile("manager"),
    ]);
    await expect(
      changeReporting(reportingInput(a.workerProfileId, 3, a.workerProfileId)),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_CONFLICT" });
    await changeReporting(reportingInput(a.workerProfileId, 3, b.workerProfileId));
    await changeReporting(reportingInput(b.workerProfileId, 3, c.workerProfileId));
    const c0 = await reportingSnapshot(workforceIds.tenantA, c.workerProfileId);
    await expect(
      changeReporting(reportingInput(c.workerProfileId, c0.version, a.workerProfileId)),
    ).rejects.toMatchObject({ code: "WORKFORCE_PROFILE_CONFLICT" });
    expect(await reportingSnapshot(workforceIds.tenantA, c.workerProfileId)).toEqual(c0);
    const before = await readWorkforceTenantSnapshot(workforceIds.tenantA);
    const results = await Promise.allSettled([
      changeReporting(reportingInput(m1.workerProfileId, 3, m2.workerProfileId)),
      changeReporting(reportingInput(m2.workerProfileId, 3, m1.workerProfileId)),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "WORKFORCE_PROFILE_CONFLICT" },
    });
    const heads = await tenantQuery<{ head: string | null; version: number }>(
      workforceIds.tenantA,
      `SELECT current_reporting_relationship_id head, row_version version
       FROM hr_worker_profiles WHERE tenant_id=$1 AND worker_profile_id=ANY($2::uuid[])`,
      [workforceIds.tenantA, [m1.workerProfileId, m2.workerProfileId]],
    );
    expect(heads.map(({ version }) => version).sort()).toEqual([3, 4]);
    expect(heads.filter(({ head }) => head !== null)).toHaveLength(1);
    expect(await readWorkforceTenantSnapshot(workforceIds.tenantA)).toEqual({
      ...before,
      evidence: before.evidence + 2,
      outbox: before.outbox + 1,
    });
  });
  it("rolls the relationship head and all proof back when outbox insert fails", async () => {
    const report = await createActiveReportingProfile("employee");
    const manager = await createActiveReportingProfile("manager");
    const before = await reportingSnapshot(workforceIds.tenantA, report.workerProfileId);
    await workforceMigrationPool.query(
      `REVOKE INSERT ON outbox_events FROM ${workforceApplicationRole}`,
    );
    try {
      await expect(
        changeReporting(
          reportingInput(report.workerProfileId, before.version, manager.workerProfileId),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await workforceMigrationPool.query(
        `GRANT INSERT ON outbox_events TO ${workforceApplicationRole}`,
      );
    }
    expect(await reportingSnapshot(workforceIds.tenantA, report.workerProfileId)).toEqual(before);
  });
});
