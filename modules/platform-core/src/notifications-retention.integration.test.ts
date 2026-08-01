import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyNotificationRetentionOnce,
  listOwnNotifications,
  type NotificationTargetVerifier,
} from "./notifications.js";

const ids = {
  freshIntentA: "a1000000-0000-4000-8000-000000000005",
  freshNotificationA: "a2000000-0000-4000-8000-000000000005",
  freshSourceA: "a3000000-0000-4000-8000-000000000005",
  membershipA: "a4000000-0000-4000-8000-000000000001",
  membershipB: "a4000000-0000-4000-8000-000000000002",
  oldIntentA1: "a1000000-0000-4000-8000-000000000001",
  oldIntentA2: "a1000000-0000-4000-8000-000000000002",
  oldIntentB: "a1000000-0000-4000-8000-000000000003",
  oldNotificationA1: "a2000000-0000-4000-8000-000000000001",
  oldNotificationA2: "a2000000-0000-4000-8000-000000000002",
  oldNotificationB: "a2000000-0000-4000-8000-000000000003",
  oldSourceA1: "a3000000-0000-4000-8000-000000000001",
  oldSourceA2: "a3000000-0000-4000-8000-000000000002",
  oldSourceB: "a3000000-0000-4000-8000-000000000003",
  principalA: "a5000000-0000-4000-8000-000000000001",
  principalB: "a5000000-0000-4000-8000-000000000002",
  targetA1: "a6000000-0000-4000-8000-000000000001",
  targetA2: "a6000000-0000-4000-8000-000000000002",
  targetB: "a6000000-0000-4000-8000-000000000003",
  targetFreshA: "a6000000-0000-4000-8000-000000000005",
  tenantA: "a7000000-0000-4000-8000-000000000001",
  tenantB: "a7000000-0000-4000-8000-000000000002",
} as const;

let applicationPool: Pool;
let migrationPool: Pool;
let projectorPool: Pool;

const verifyTargets: NotificationTargetVerifier = async (_client, _tenantId, targets) =>
  targets.map(({ referenceId }) => ({ outcome: "allowed", referenceId }));

function explainRoot(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || typeof value[0] !== "object" || value[0] === null) {
    throw new Error("Notification retention query plan is unavailable");
  }
  const plan = (value[0] as Record<string, unknown>).Plan;
  if (typeof plan !== "object" || plan === null) {
    throw new Error("Notification retention query plan root is unavailable");
  }
  return plan as Record<string, unknown>;
}

function planBlocks(node: Record<string, unknown>): number {
  return [
    "Shared Hit Blocks",
    "Shared Read Blocks",
    "Local Hit Blocks",
    "Local Read Blocks",
    "Temp Read Blocks",
    "Temp Written Blocks",
  ].reduce((sum, key) => sum + Number(node[key] ?? 0), 0);
}

async function withTenantSeed(
  tenantId: string,
  seed: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await seed(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function tenantQuery<Row extends QueryResultRow>(
  tenantId: string,
  query: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  let rows: readonly Row[] = [];
  await withTenantSeed(tenantId, async (client) => {
    rows = (await client.query<Row>(query, [...values])).rows;
  });
  return rows;
}

async function insertProjectionFixture(input: {
  readonly ageDays: number;
  readonly sourceAgeDays: number;
  readonly intentId: string;
  readonly notificationId: string;
  readonly principalId: string;
  readonly sourceEventId: string;
  readonly targetResourceId: string;
  readonly tenantId: string;
}): Promise<void> {
  await withTenantSeed(input.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outbox_events
         (event_id,tenant_id,event_type,aggregate_type,aggregate_id,
          aggregate_version,correlation_id,payload,occurred_at)
       VALUES ($1,$2,'hr.leave_request.submitted','hr_leave_request',$3,1,$4,'{}'::jsonb,
               clock_timestamp() - ($5::text || ' days')::interval)`,
      [
        input.sourceEventId,
        input.tenantId,
        input.targetResourceId,
        input.intentId,
        input.sourceAgeDays,
      ],
    );
  });
  await projectorPool.query(
    `INSERT INTO notification_intents
       (intent_id,tenant_id,source_event_id,recipient_principal_id,source_service_key,
        state,intent_payload,occurred_at,terminal_at,payload_redacted_at,row_version)
     VALUES ($1,$2,$3,$4,'hr.leave_request','projected','{"redacted":true}'::jsonb,
             clock_timestamp() - ($5::text || ' days')::interval,
             clock_timestamp(),clock_timestamp(),2)`,
    [input.intentId, input.tenantId, input.sourceEventId, input.principalId, input.sourceAgeDays],
  );
  await projectorPool.query(
    `INSERT INTO notification_projections
       (notification_id,tenant_id,recipient_principal_id,intent_id,source_event_id,
        source_service_key,category,title,safe_summary,target_kind,target_resource_id,
        target_href,target_read_capability_id,occurred_at,read_at,retention_status,row_version)
     VALUES ($1,$2,$3,$4,$5,'hr.leave_request','hr.leave_request',
             'A leave request needs your review','Open the leave request for details.',
             'hr.leave_request.detail',$6::uuid,'/workspace/hr/leave/' || ($6::uuid)::text,
             'hr.leave.view',clock_timestamp() - ($7::text || ' days')::interval,
             clock_timestamp(),'active',1)`,
    [
      input.notificationId,
      input.tenantId,
      input.principalId,
      input.intentId,
      input.sourceEventId,
      input.targetResourceId,
      input.ageDays,
    ],
  );
  await projectorPool.query(
    `INSERT INTO notification_projection_receipts
       (tenant_id,consumer_key,consumer_version,source_event_id,
        recipient_principal_id,intent_id,notification_id,outcome)
     VALUES ($1,'platform.notifications.projector',1,$2,$3,$4,$5,'projected')`,
    [input.tenantId, input.sourceEventId, input.principalId, input.intentId, input.notificationId],
  );
}

beforeAll(async () => {
  const applicationUrl = process.env.DATABASE_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const projectorUrl = process.env.DATABASE_NOTIFICATION_PROJECTOR_URL;
  if (
    !applicationUrl ||
    !applicationRole ||
    !/^[a-z_][a-z0-9_]*$/.test(applicationRole) ||
    !migrationUrl ||
    !projectorUrl
  ) {
    throw new Error("PostgreSQL notification-retention fixture is unavailable");
  }
  migrationPool = createDatabasePool(migrationUrl, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `GRANT SELECT ON service_activations,membership_capabilities TO ${applicationRole}`,
  );
  applicationPool = createDatabasePool(applicationUrl, { max: 2 });
  projectorPool = createDatabasePool(projectorUrl, { max: 2 });
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id,name)
     VALUES ($1,'Retention A'),($2,'Retention B')`,
    [ids.tenantA, ids.tenantB],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id,display_name)
     VALUES ($1,'Recipient A'),($2,'Recipient B')`,
    [ids.principalA, ids.principalB],
  );
  await withTenantSeed(ids.tenantA, async (client) => {
    await client.query(
      `INSERT INTO memberships
         (membership_id,tenant_id,principal_id,role_key,status)
       VALUES ($1,$2,$3,'manager','active')`,
      [ids.membershipA, ids.tenantA, ids.principalA],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       VALUES ($1,$2,'platform.notifications.list_own'),($1,$2,'hr.leave.view')`,
      [ids.tenantA, ids.principalA],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'hr.leave_request','active',1)`,
      [ids.tenantA],
    );
  });
  await withTenantSeed(ids.tenantB, async (client) => {
    await client.query(
      `INSERT INTO memberships
         (membership_id,tenant_id,principal_id,role_key,status)
       VALUES ($1,$2,$3,'manager','active')`,
      [ids.membershipB, ids.tenantB, ids.principalB],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id,service_key,state,version)
       VALUES ($1,'hr.leave_request','active',1)`,
      [ids.tenantB],
    );
  });
  await insertProjectionFixture({
    ageDays: 94,
    intentId: ids.oldIntentA1,
    notificationId: ids.oldNotificationA1,
    principalId: ids.principalA,
    sourceAgeDays: 70,
    sourceEventId: ids.oldSourceA1,
    targetResourceId: ids.targetA1,
    tenantId: ids.tenantA,
  });
  await insertProjectionFixture({
    ageDays: 92,
    intentId: ids.oldIntentA2,
    notificationId: ids.oldNotificationA2,
    principalId: ids.principalA,
    sourceAgeDays: 68,
    sourceEventId: ids.oldSourceA2,
    targetResourceId: ids.targetA2,
    tenantId: ids.tenantA,
  });
  await insertProjectionFixture({
    ageDays: 93,
    intentId: ids.oldIntentB,
    notificationId: ids.oldNotificationB,
    principalId: ids.principalB,
    sourceAgeDays: 69,
    sourceEventId: ids.oldSourceB,
    targetResourceId: ids.targetB,
    tenantId: ids.tenantB,
  });
  await insertProjectionFixture({
    ageDays: 89,
    intentId: ids.freshIntentA,
    notificationId: ids.freshNotificationA,
    principalId: ids.principalA,
    sourceAgeDays: 95,
    sourceEventId: ids.freshSourceA,
    targetResourceId: ids.targetFreshA,
    tenantId: ids.tenantA,
  });
});

afterAll(async () => {
  await applicationPool?.end();
  await projectorPool?.end();
  await migrationPool?.end();
});

describe("notification derivative retention", () => {
  it("redacts one tenant-bounded indexed batch at a time and preserves receipts", async () => {
    const sourceBefore = [
      ...(await tenantQuery<{ event_id: string; occurred_at: Date; payload: unknown }>(
        ids.tenantA,
        `SELECT event_id,occurred_at,payload
         FROM outbox_events
         WHERE event_id = ANY($1::uuid[])
         ORDER BY event_id`,
        [[ids.oldSourceA1, ids.oldSourceA2]],
      )),
      ...(await tenantQuery<{ event_id: string; occurred_at: Date; payload: unknown }>(
        ids.tenantB,
        `SELECT event_id,occurred_at,payload
         FROM outbox_events
         WHERE event_id=$1`,
        [ids.oldSourceB],
      )),
    ];
    const intentsBefore = await projectorPool.query<{
      intent_id: string;
      intent_payload: unknown;
      occurred_at: Date;
      state: string;
    }>(
      `SELECT intent_id,intent_payload,occurred_at,state
       FROM notification_intents
       WHERE intent_id = ANY($1::uuid[])
       ORDER BY intent_id`,
      [[ids.oldIntentA1, ids.oldIntentA2, ids.oldIntentB]],
    );

    await expect(applyNotificationRetentionOnce(projectorPool, 100)).resolves.toEqual({
      redacted: 2,
      tenantId: ids.tenantA,
    });
    await expect(applyNotificationRetentionOnce(projectorPool, 100)).resolves.toEqual({
      redacted: 1,
      tenantId: ids.tenantB,
    });
    await expect(applyNotificationRetentionOnce(projectorPool, 100)).resolves.toEqual({
      redacted: 0,
      tenantId: null,
    });
    await expect(applyNotificationRetentionOnce(projectorPool, 0)).rejects.toThrow(
      "Notification retention batch size is invalid",
    );
    await expect(applyNotificationRetentionOnce(projectorPool, 101)).rejects.toThrow(
      "Notification retention batch size is invalid",
    );

    const expired = await projectorPool.query<{
      category: string | null;
      notification_id: string;
      read_at: Date | null;
      receipt_notification_id: string | null;
      retention_redacted_at: Date | null;
      retention_status: string;
      safe_summary: string | null;
      target_href: string | null;
      target_kind: string | null;
      target_read_capability_id: string | null;
      target_resource_id: string | null;
      title: string | null;
    }>(
      `SELECT projection.notification_id,projection.category,projection.title,
              projection.safe_summary,projection.target_kind,projection.target_resource_id,
              projection.target_href,projection.target_read_capability_id,
              projection.read_at,projection.retention_status,
              projection.retention_redacted_at,receipt.notification_id AS receipt_notification_id
       FROM notification_projections projection
       JOIN notification_projection_receipts receipt
         ON receipt.tenant_id=projection.tenant_id
        AND receipt.intent_id=projection.intent_id
       WHERE projection.notification_id = ANY($1::uuid[])
       ORDER BY projection.notification_id`,
      [[ids.oldNotificationA1, ids.oldNotificationA2, ids.oldNotificationB]],
    );
    expect(expired.rows).toHaveLength(3);
    for (const row of expired.rows) {
      expect(row).toMatchObject({
        category: null,
        read_at: null,
        receipt_notification_id: row.notification_id,
        retention_redacted_at: expect.any(Date),
        retention_status: "expired",
        safe_summary: null,
        target_href: null,
        target_kind: null,
        target_read_capability_id: null,
        target_resource_id: null,
        title: null,
      });
    }
    const evidence = await projectorPool.query<{
      event_type: string;
      result_code: string;
      tenant_id: string;
    }>(
      `SELECT tenant_id,event_type,result_code
       FROM notification_projector_evidence
       WHERE intent_id = ANY($1::uuid[])
       ORDER BY tenant_id,intent_id`,
      [[ids.oldIntentA1, ids.oldIntentA2, ids.oldIntentB]],
    );
    expect(evidence.rows).toEqual([
      {
        event_type: "platform.notifications.retention_redacted",
        result_code: "PROJECTION_RETENTION_EXPIRED",
        tenant_id: ids.tenantA,
      },
      {
        event_type: "platform.notifications.retention_redacted",
        result_code: "PROJECTION_RETENTION_EXPIRED",
        tenant_id: ids.tenantA,
      },
      {
        event_type: "platform.notifications.retention_redacted",
        result_code: "PROJECTION_RETENTION_EXPIRED",
        tenant_id: ids.tenantB,
      },
    ]);
    const sourceAfter = [
      ...(await tenantQuery<{ event_id: string; occurred_at: Date; payload: unknown }>(
        ids.tenantA,
        `SELECT event_id,occurred_at,payload
         FROM outbox_events
         WHERE event_id = ANY($1::uuid[])
         ORDER BY event_id`,
        [[ids.oldSourceA1, ids.oldSourceA2]],
      )),
      ...(await tenantQuery<{ event_id: string; occurred_at: Date; payload: unknown }>(
        ids.tenantB,
        `SELECT event_id,occurred_at,payload
         FROM outbox_events
         WHERE event_id=$1`,
        [ids.oldSourceB],
      )),
    ];
    const intentsAfter = await projectorPool.query<{
      intent_id: string;
      intent_payload: unknown;
      occurred_at: Date;
      state: string;
    }>(
      `SELECT intent_id,intent_payload,occurred_at,state
       FROM notification_intents
       WHERE intent_id = ANY($1::uuid[])
       ORDER BY intent_id`,
      [[ids.oldIntentA1, ids.oldIntentA2, ids.oldIntentB]],
    );
    expect(sourceAfter).toEqual(sourceBefore);
    expect(intentsAfter.rows).toEqual(intentsBefore.rows);
  });

  it("keeps the 89-day projection active and absent rows stay idempotently absent", async () => {
    const fresh = await projectorPool.query<{
      retention_redacted_at: Date | null;
      retention_status: string;
      title: string | null;
    }>(
      `SELECT retention_status,retention_redacted_at,title
       FROM notification_projections
       WHERE tenant_id=$1 AND notification_id=$2`,
      [ids.tenantA, ids.freshNotificationA],
    );
    expect(fresh.rows).toEqual([
      {
        retention_redacted_at: null,
        retention_status: "active",
        title: "A leave request needs your review",
      },
    ]);
    const page = await listOwnNotifications(
      applicationPool,
      {
        actorPrincipalId: ids.principalA,
        correlationId: ids.freshIntentA,
        tenantId: ids.tenantA,
      },
      {},
      verifyTargets,
    );
    expect(page.items.map(({ notificationId }) => notificationId)).toEqual([
      ids.freshNotificationA,
    ]);
  });

  it("keeps direct mutation and tenant-user execution closed", async () => {
    const projectorClient = await projectorPool.connect();
    try {
      await projectorClient.query("BEGIN");
      await projectorClient.query(
        "SELECT set_config('app.notification_retention_executor','v1',true)",
      );
      await expect(
        projectorClient.query(
          `UPDATE notification_projections SET title='tampered' WHERE notification_id=$1`,
          [ids.freshNotificationA],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await projectorClient.query("ROLLBACK").catch(() => undefined);
      projectorClient.release();
    }
    await expect(
      applicationPool.query(
        `UPDATE notification_projections SET title='tampered' WHERE notification_id=$1`,
        [ids.freshNotificationA],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      applicationPool.query("SELECT * FROM public.esbla_apply_notification_retention_v1(1)"),
    ).rejects.toThrow(/permission denied/i);
  });

  it("uses bounded retention indexes at representative cardinality", async () => {
    await withTenantSeed(ids.tenantA, async (client) => {
      await client.query(
        `INSERT INTO outbox_events
           (event_id,tenant_id,event_type,aggregate_type,aggregate_id,
            aggregate_version,correlation_id,payload,occurred_at)
         SELECT md5('retention-source:' || sequence)::uuid,$1,
                'hr.leave_request.submitted','hr_leave_request',
                md5('retention-target:' || sequence)::uuid,1,
                md5('retention-correlation:' || sequence)::uuid,'{}'::jsonb,
                clock_timestamp() - interval '30 days' + sequence * interval '1 second'
         FROM generate_series(1,5000) sequence`,
        [ids.tenantA],
      );
    });
    await projectorPool.query(
      `INSERT INTO notification_intents
         (intent_id,tenant_id,source_event_id,recipient_principal_id,source_service_key,
          state,intent_payload,occurred_at,terminal_at,payload_redacted_at,row_version)
       SELECT md5('retention-intent:' || sequence)::uuid,$1,
              md5('retention-source:' || sequence)::uuid,$2,'hr.leave_request',
              'projected','{"redacted":true}'::jsonb,
              clock_timestamp() - interval '30 days' + sequence * interval '1 second',
              clock_timestamp(),clock_timestamp(),2
       FROM generate_series(1,5000) sequence`,
      [ids.tenantA, ids.principalA],
    );
    await projectorPool.query(
      `INSERT INTO notification_projections
         (notification_id,tenant_id,recipient_principal_id,intent_id,source_event_id,
          source_service_key,category,title,safe_summary,target_kind,target_resource_id,
          target_href,target_read_capability_id,occurred_at,retention_status,row_version)
       SELECT md5('retention-notification:' || sequence)::uuid,$1,$2,
              md5('retention-intent:' || sequence)::uuid,
              md5('retention-source:' || sequence)::uuid,
              'hr.leave_request','hr.leave_request','Retention fixture',
              'Bounded query-plan fixture.','hr.leave_request.detail',
              md5('retention-target:' || sequence)::uuid,
              '/workspace/hr/leave/' || md5('retention-target:' || sequence)::uuid::text,
              'hr.leave.view',
              clock_timestamp() - interval '120 days' + sequence * interval '1 second',
              'active',1
       FROM generate_series(1,5000) sequence`,
      [ids.tenantA, ids.principalA],
    );
    await migrationPool.query("ANALYZE notification_projections");

    const executorClient = await migrationPool.connect();
    try {
      await executorClient.query("BEGIN");
      await executorClient.query(
        "SELECT set_config('app.notification_retention_executor','v1',true)",
      );
      const cutoff = await executorClient.query<{ cutoff: Date }>(
        "SELECT clock_timestamp() - interval '90 days' AS cutoff",
      );
      const retentionCutoff = cutoff.rows[0]?.cutoff;
      if (!retentionCutoff) throw new Error("Notification retention cutoff is unavailable");
      const schedulePlan = await executorClient.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
         SELECT tenant_id
         FROM notification_projections
         WHERE retention_status='active' AND occurred_at < $1::timestamptz
         ORDER BY occurred_at,tenant_id,notification_id
         LIMIT 1`,
        [retentionCutoff],
      );
      const scheduleRoot = explainRoot(schedulePlan.rows[0]?.["QUERY PLAN"]);
      const scheduleRendered = JSON.stringify(scheduleRoot);
      expect(scheduleRendered).toContain("notification_projections_retention_schedule_idx");
      expect(scheduleRendered).not.toContain('"Node Type":"Seq Scan"');
      expect(Number(scheduleRoot["Actual Rows"] ?? 0)).toBeLessThanOrEqual(1);
      expect(planBlocks(scheduleRoot)).toBeLessThanOrEqual(16);

      const tenantPlan = await executorClient.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
         SELECT tenant_id,notification_id,intent_id,source_event_id
         FROM notification_projections
         WHERE tenant_id=$1 AND retention_status='active'
           AND occurred_at < $2::timestamptz
         ORDER BY occurred_at,notification_id
         FOR UPDATE SKIP LOCKED
         LIMIT 100`,
        [ids.tenantA, retentionCutoff],
      );
      const tenantRoot = explainRoot(tenantPlan.rows[0]?.["QUERY PLAN"]);
      const tenantRendered = JSON.stringify(tenantRoot);
      expect(tenantRendered).toMatch(/notification_projections_retention(?:_schedule)?_idx/);
      expect(tenantRendered).not.toContain('"Node Type":"Seq Scan"');
      expect(Number(tenantRoot["Actual Rows"] ?? 0)).toBeLessThanOrEqual(100);
      expect(planBlocks(tenantRoot)).toBeLessThanOrEqual(128);
      await executorClient.query("ROLLBACK");
    } catch (error) {
      await executorClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      executorClient.release();
    }
  }, 15_000);
});
