import { randomUUID } from "node:crypto";
import { createDatabasePool } from "@esbla/db";
import {
  createNotificationProjector,
  listOwnNotifications,
  markAllOwnNotificationsRead,
  markOwnNotificationRead,
  projectPendingNotificationIntentsOnce,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveLeaveRequest,
  rejectLeaveRequest,
  submitLeaveRequest,
  verifyHrNotificationTargets,
} from "./index.js";
import {
  context,
  ids,
  migrationPool,
  pool,
  seedTenantRow,
  setupLeaveIntegration,
} from "./leave.integration-fixture.js";

const notificationIds = {
  requestApproved: "30000000-0000-4000-8000-000000000071",
  requestCapability: "30000000-0000-4000-8000-000000000075",
  requestDemoted: "30000000-0000-4000-8000-000000000073",
  requestInactive: "30000000-0000-4000-8000-000000000076",
  requestPoisoned: "30000000-0000-4000-8000-000000000078",
  requestRejected: "30000000-0000-4000-8000-000000000072",
  requestRetry: "30000000-0000-4000-8000-000000000077",
  requestStop: "30000000-0000-4000-8000-000000000079",
  requestSuspended: "30000000-0000-4000-8000-000000000074",
} as const;

const notificationCapabilities = [
  "hr.leave.view",
  "platform.notifications.list_own",
  "platform.notifications.mark_all_read_own",
  "platform.notifications.mark_read_own",
] as const;

let projectorPool: Pool;
const intentIds = new Map<string, string>();

async function seedCapabilities(tenantId: string, principalIds: readonly string[]): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await seedTenantRow(
      client,
      tenantId,
      `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
       SELECT $1,principal_id,capability_id
       FROM unnest($2::uuid[]) AS principal(principal_id)
       CROSS JOIN unnest($3::text[]) AS capability(capability_id)`,
      [tenantId, principalIds, notificationCapabilities],
    );
  } finally {
    client.release();
  }
}

async function mutateTenant(
  tenantId: string,
  query: string,
  values: readonly unknown[],
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await seedTenantRow(client, tenantId, query, values);
  } finally {
    client.release();
  }
}

async function projectorQuery<Row extends QueryResultRow>(
  query: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  const result = await projectorPool.query<Row>(query, [...values]);
  return result.rows;
}

async function waitFor(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${description} did not become true`);
}

async function submit(leaveRequestId: string, correlationId = randomUUID()): Promise<void> {
  await submitLeaveRequest(pool, context(ids.tenantA, ids.employeeA, correlationId), {
    categoryCode: "annual",
    endDate: "2027-08-14",
    idempotencyKey: leaveRequestId,
    leaveRequestId,
    reason: "Private source detail that must not enter notification copy",
    startDate: "2027-08-14",
  });
  if (!intentIds.has(leaveRequestId)) {
    const rows = await projectorQuery<{ intent_id: string }>(
      `SELECT intent_id
       FROM notification_intents
       WHERE intent_payload->>'targetResourceId'=$1`,
      [leaveRequestId],
    );
    const intentId = rows[0]?.intent_id;
    if (!intentId || rows.length !== 1) {
      throw new Error("Exact submitted notification intent was not found");
    }
    intentIds.set(leaveRequestId, intentId);
  }
}

async function receiptOutcome(leaveRequestId: string): Promise<string | undefined> {
  const rows = await projectorQuery<{ outcome: string }>(
    `SELECT outcome
     FROM notification_projection_receipts
     WHERE intent_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [intentIds.get(leaveRequestId)],
  );
  return rows[0]?.outcome;
}

beforeAll(async () => {
  await setupLeaveIntegration();
  const projectorUrl = process.env.DATABASE_NOTIFICATION_PROJECTOR_URL;
  if (!projectorUrl) throw new Error("Notification projector database URL is required");
  projectorPool = createDatabasePool(projectorUrl, { max: 2 });
  await seedCapabilities(ids.tenantA, [ids.employeeA, ids.employeeA2, ids.managerA, ids.managerA2]);
  await seedCapabilities(ids.tenantB, [ids.employeeB, ids.managerB]);
});

afterAll(async () => {
  await projectorPool.end();
  await pool.end();
  await migrationPool.end();
});

describe.sequential("HR notification Core and Leave slice", () => {
  it("uses a dedicated non-impersonable database principal", async () => {
    expect(
      (await projectorPool.query<{ role: string }>("SELECT current_user AS role")).rows[0]?.role,
    ).toBe("esbla_notification_projector");
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.employeeA, randomUUID()),
        async ({ client }) => {
          await client.query(
            "SELECT set_config('app.notification_projector_identity','platform.notifications.projector',true)",
          );
          const rows = await client.query("SELECT intent_id FROM notification_intents");
          expect(rows.rowCount).toBe(0);
          await client.query("SET LOCAL ROLE esbla_notification_projector");
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("freezes, deduplicates, projects, lists and reads the exact Leave journey", async () => {
    const submitCorrelation = randomUUID();
    await submit(notificationIds.requestApproved, submitCorrelation);
    await submit(notificationIds.requestApproved, submitCorrelation);

    const intents = await projectorQuery<{
      intent_payload: Record<string, unknown>;
      recipient_principal_id: string;
      source_service_key: string;
    }>(
      `SELECT recipient_principal_id,source_service_key,intent_payload
       FROM notification_intents
       WHERE intent_id=$1`,
      [intentIds.get(notificationIds.requestApproved)],
    );
    expect(intents).toEqual([
      {
        intent_payload: {
          category: "hr.leave_request",
          safeSummary: "Open the leave request for details.",
          targetHref: `/workspace/hr/leave/${notificationIds.requestApproved}`,
          targetKind: "hr.leave_request.detail",
          targetReadCapabilityId: "hr.leave.view",
          targetResourceId: notificationIds.requestApproved,
          title: "A leave request needs your review",
        },
        recipient_principal_id: ids.managerA,
        source_service_key: "hr.leave_request",
      },
    ]);
    expect(JSON.stringify(intents)).not.toContain("Private source detail");

    expect(
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets),
    ).toMatchObject({ poisoned: 0, projected: 1, retried: 0, withheld: 0 });
    expect(
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets),
    ).toEqual({ claimed: 0, poisoned: 0, projected: 0, retried: 0, withheld: 0 });

    const managerPage = await listOwnNotifications(
      pool,
      context(ids.tenantA, ids.managerA, randomUUID()),
      {},
      verifyHrNotificationTargets,
    );
    const submittedNotification = managerPage.items.find(
      ({ target }) => target.available && target.resourceId === notificationIds.requestApproved,
    );
    expect(submittedNotification).toMatchObject({
      readAt: null,
      rowVersion: 1,
      sourceService: "hr.leave_request",
      summary: "Open the leave request for details.",
      title: "A leave request needs your review",
    });
    expect(managerPage.unreadCount).toBe(1);
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.managerA, randomUUID()),
        async ({ client }) =>
          await client.query(
            `UPDATE notification_projections
             SET title='Application role must not rewrite projector copy'
             WHERE tenant_id=$1 AND notification_id=$2`,
            [ids.tenantA, submittedNotification?.notificationId],
          ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const readCorrelation = randomUUID();
    const read = await markOwnNotificationRead(
      pool,
      context(ids.tenantA, ids.managerA, readCorrelation),
      submittedNotification?.notificationId ?? "",
      { expectedVersion: 1 },
      verifyHrNotificationTargets,
    );
    expect(read).toMatchObject({
      billingState: "non_billable",
      notification: { readAt: expect.any(String), rowVersion: 2 },
      replayed: false,
    });
    expect(
      await markOwnNotificationRead(
        pool,
        context(ids.tenantA, ids.managerA, readCorrelation),
        submittedNotification?.notificationId ?? "",
        { expectedVersion: 1 },
        verifyHrNotificationTargets,
      ),
    ).toMatchObject({ evidenceEventId: read.evidenceEventId, replayed: true });
    await expect(
      markOwnNotificationRead(
        pool,
        context(ids.tenantA, ids.managerA, readCorrelation),
        submittedNotification?.notificationId ?? "",
        { expectedVersion: 2 },
        verifyHrNotificationTargets,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await approveLeaveRequest(pool, context(ids.tenantA, ids.managerA, randomUUID()), {
      expectedVersion: 1,
      leaveRequestId: notificationIds.requestApproved,
    });
    expect(
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets),
    ).toMatchObject({ projected: 1 });
    const employeePage = await listOwnNotifications(
      pool,
      context(ids.tenantA, ids.employeeA, randomUUID()),
      {},
      verifyHrNotificationTargets,
    );
    expect(employeePage.items).toContainEqual(
      expect.objectContaining({
        title: "Your leave request was approved",
        target: expect.objectContaining({
          available: true,
          resourceId: notificationIds.requestApproved,
        }),
      }),
    );

    const tenantB = await listOwnNotifications(
      pool,
      context(ids.tenantB, ids.employeeB, randomUUID()),
      {},
      verifyHrNotificationTargets,
    );
    expect(tenantB).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
  });

  it("excludes rejection notes and applies bounded mark-all evidence", async () => {
    await submit(notificationIds.requestRejected);
    await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets);
    await rejectLeaveRequest(pool, context(ids.tenantA, ids.managerA, randomUUID()), {
      decisionNote: "Restricted rejection rationale",
      expectedVersion: 1,
      leaveRequestId: notificationIds.requestRejected,
    });
    const payloads = await projectorQuery<{ intent_payload: Record<string, unknown> }>(
      `SELECT intent_payload
       FROM notification_intents
       WHERE intent_payload->>'targetResourceId'=$1
         AND intent_payload->>'title'='Your leave request was rejected'`,
      [notificationIds.requestRejected],
    );
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads)).not.toContain("Restricted rejection rationale");
    await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets);

    const before = await listOwnNotifications(
      pool,
      context(ids.tenantA, ids.employeeA, randomUUID()),
      {},
      verifyHrNotificationTargets,
    );
    const beforeOccurredAt = new Date().toISOString();
    const markAllCorrelation = randomUUID();
    const result = await markAllOwnNotificationsRead(
      pool,
      context(ids.tenantA, ids.employeeA, markAllCorrelation),
      {
        beforeOccurredAt,
        expectedUnreadCount: before.unreadCount,
      },
    );
    expect(result).toMatchObject({
      billingState: "non_billable",
      remainingUnreadCount: 0,
      replayed: false,
      updatedCount: before.unreadCount,
    });
    expect(
      await markAllOwnNotificationsRead(
        pool,
        context(ids.tenantA, ids.employeeA, markAllCorrelation),
        { beforeOccurredAt, expectedUnreadCount: before.unreadCount },
      ),
    ).toEqual({ ...result, replayed: true });
    await expect(
      markAllOwnNotificationsRead(pool, context(ids.tenantA, ids.employeeA, markAllCorrelation), {
        beforeOccurredAt,
        expectedUnreadCount: before.unreadCount + 1,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("withholds frozen recipients for every terminal currentness outcome", async () => {
    await submit(notificationIds.requestDemoted);
    await mutateTenant(
      ids.tenantA,
      "UPDATE memberships SET role_key='employee' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenantA, ids.managerA],
    );
    try {
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets);
      expect(await receiptOutcome(notificationIds.requestDemoted)).toBe("withheld_target_denied");
    } finally {
      await mutateTenant(
        ids.tenantA,
        "UPDATE memberships SET role_key='manager' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenantA, ids.managerA],
      );
    }

    await submit(notificationIds.requestSuspended);
    await mutateTenant(
      ids.tenantA,
      "UPDATE memberships SET status='suspended' WHERE tenant_id=$1 AND principal_id=$2",
      [ids.tenantA, ids.managerA],
    );
    try {
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets);
      expect(await receiptOutcome(notificationIds.requestSuspended)).toBe("withheld_membership");
    } finally {
      await mutateTenant(
        ids.tenantA,
        "UPDATE memberships SET status='active' WHERE tenant_id=$1 AND principal_id=$2",
        [ids.tenantA, ids.managerA],
      );
    }

    await submit(notificationIds.requestCapability);
    await mutateTenant(
      ids.tenantA,
      `DELETE FROM membership_capabilities
       WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='hr.leave.view'`,
      [ids.tenantA, ids.managerA],
    );
    try {
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets);
      expect(await receiptOutcome(notificationIds.requestCapability)).toBe(
        "withheld_target_denied",
      );
    } finally {
      await mutateTenant(
        ids.tenantA,
        `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
         VALUES ($1,$2,'hr.leave.view')`,
        [ids.tenantA, ids.managerA],
      );
    }

    await submit(notificationIds.requestInactive);
    await mutateTenant(
      ids.tenantA,
      `UPDATE service_activations
       SET state='inactive',version=version+1
       WHERE tenant_id=$1 AND service_key='hr.leave_request'`,
      [ids.tenantA],
    );
    try {
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets);
      expect(await receiptOutcome(notificationIds.requestInactive)).toBe(
        "withheld_service_inactive",
      );
    } finally {
      await mutateTenant(
        ids.tenantA,
        `UPDATE service_activations
         SET state='active',version=version+1
         WHERE tenant_id=$1 AND service_key='hr.leave_request'`,
        [ids.tenantA],
      );
    }
  });

  it("retries transient failures, isolates poison and resumes through controller restart", async () => {
    await submit(notificationIds.requestRetry);
    const sensitiveFailure = async () => {
      throw new Error("private recipient and database diagnostic");
    };
    expect(
      await projectPendingNotificationIntentsOnce(projectorPool, sensitiveFailure),
    ).toMatchObject({ poisoned: 0, retried: 1 });
    const retry = await projectorQuery<{
      attempt_count: number;
      last_failure_code: string;
      state: string;
    }>(
      `SELECT attempt_count,last_failure_code,state
       FROM notification_intents
       WHERE intent_id=$1`,
      [intentIds.get(notificationIds.requestRetry)],
    );
    expect(retry).toEqual([
      {
        attempt_count: 1,
        last_failure_code: "PROJECTOR_TARGET_CHECK_FAILED",
        state: "retrying",
      },
    ]);
    expect(JSON.stringify(retry)).not.toContain("private recipient");
    await projectorPool.query(
      `UPDATE notification_intents
       SET next_attempt_at=clock_timestamp()
       WHERE intent_id=$1`,
      [intentIds.get(notificationIds.requestRetry)],
    );

    const projector = createNotificationProjector(projectorPool, verifyHrNotificationTargets);
    projector.start();
    await waitFor(
      "retry projection",
      async () => (await receiptOutcome(notificationIds.requestRetry)) === "projected",
    );
    await projector.stop();
    projector.start();
    await projector.stop();

    await submit(notificationIds.requestPoisoned);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const result = await projectPendingNotificationIntentsOnce(projectorPool, sensitiveFailure);
      expect(result[attempt === 8 ? "poisoned" : "retried"]).toBe(1);
      if (attempt < 8) {
        await projectorPool.query(
          `UPDATE notification_intents
           SET next_attempt_at=clock_timestamp()
           WHERE intent_id=$1`,
          [intentIds.get(notificationIds.requestPoisoned)],
        );
      }
    }
    const poisoned = await projectorQuery<{
      attempt_count: number;
      last_failure_code: string;
      state: string;
    }>(
      `SELECT attempt_count,last_failure_code,state
       FROM notification_intents
       WHERE intent_id=$1`,
      [intentIds.get(notificationIds.requestPoisoned)],
    );
    expect(poisoned).toEqual([
      {
        attempt_count: 8,
        last_failure_code: "PROJECTOR_TARGET_CHECK_FAILED",
        state: "poisoned",
      },
    ]);
  });

  it("returns from a timed-out cooperative stop when target verification never settles", async () => {
    await submit(notificationIds.requestStop);
    let verificationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    let releaseVerification: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const diagnostics: string[] = [];
    const projector = createNotificationProjector(
      projectorPool,
      async (_client, _tenantId, targets) => {
        verificationStarted?.();
        await blocked;
        return targets.map(({ referenceId }) => ({ outcome: "allowed" as const, referenceId }));
      },
      {
        onDiagnostic: ({ code }) => diagnostics.push(code),
        shutdownJoinMs: 50,
      },
    );
    projector.start();
    await started;
    const stop = projector.stop();
    const completedWithinBound = await Promise.race([
      stop.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    releaseVerification?.();
    await stop;
    expect(completedWithinBound).toBe(true);
    expect(diagnostics).toContain("NOTIFICATION_PROJECTOR_STOP_TIMEOUT");
    await waitFor("forced-stop rollback", async () => {
      const rows = await projectorQuery<{ state: string }>(
        "SELECT state FROM notification_intents WHERE intent_id=$1",
        [intentIds.get(notificationIds.requestStop)],
      );
      return (
        rows[0]?.state === "pending" &&
        (await receiptOutcome(notificationIds.requestStop)) === undefined
      );
    });
    expect(
      await projectPendingNotificationIntentsOnce(projectorPool, verifyHrNotificationTargets),
    ).toMatchObject({ projected: 1 });
  });
});
