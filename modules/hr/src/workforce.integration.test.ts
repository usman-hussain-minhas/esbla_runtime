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
  changeWorkforceStatus,
  createWorkforceProfile,
  linkWorkforcePrincipal,
} from "./workforce-commands.js";
import { getOwnWorkforceProfile } from "./workforce-queries.js";

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
});
