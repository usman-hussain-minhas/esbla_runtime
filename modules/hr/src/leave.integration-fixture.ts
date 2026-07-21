import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import { evaluatePolicy, setServiceActivation, withTenantTransaction } from "@esbla/platform-core";
import type { Pool, PoolClient } from "pg";
import { expect } from "vitest";

export const ids = {
  adminA: "10000000-0000-4000-8000-000000000001",
  adminB: "10000000-0000-4000-8000-000000000008",
  correlationActivateA: "50000000-0000-4000-8000-000000000001",
  correlationActivateB: "50000000-0000-4000-8000-000000000002",
  correlationApprove1: "50000000-0000-4000-8000-000000000011",
  correlationApproveRetry: "50000000-0000-4000-8000-000000000012",
  correlationConcurrentSubmit: "50000000-0000-4000-8000-000000000015",
  correlationDecisionApprove: "50000000-0000-4000-8000-000000000016",
  correlationDecisionReject: "50000000-0000-4000-8000-000000000017",
  correlationDeactivateB: "50000000-0000-4000-8000-000000000018",
  correlationDemotionApprove: "50000000-0000-4000-8000-000000000031",
  correlationDemotionReject: "50000000-0000-4000-8000-000000000032",
  correlationDemotionSnapshot: "50000000-0000-4000-8000-000000000033",
  correlationDemotionSubmitApprove: "50000000-0000-4000-8000-000000000027",
  correlationDemotionSubmitReject: "50000000-0000-4000-8000-000000000028",
  correlationDemotionSubmitReplayApprove: "50000000-0000-4000-8000-000000000029",
  correlationDemotionSubmitReplayReject: "50000000-0000-4000-8000-000000000030",
  correlationDemotionSubmitView: "50000000-0000-4000-8000-000000000026",
  correlationDemotionUpdate: "50000000-0000-4000-8000-000000000034",
  correlationDetailFirstApprove: "50000000-0000-4000-8000-000000000037",
  correlationDetailFirstRead: "50000000-0000-4000-8000-000000000036",
  correlationDetailFirstSubmit: "50000000-0000-4000-8000-000000000035",
  correlationDecisionFirstRead: "50000000-0000-4000-8000-000000000040",
  correlationDecisionFirstReject: "50000000-0000-4000-8000-000000000039",
  correlationDecisionFirstSubmit: "50000000-0000-4000-8000-000000000038",
  correlationReject2: "50000000-0000-4000-8000-000000000013",
  correlationRejectOptional: "50000000-0000-4000-8000-000000000042",
  correlationRollback: "50000000-0000-4000-8000-000000000014",
  correlationSubmit1: "50000000-0000-4000-8000-000000000021",
  correlationSubmit2: "50000000-0000-4000-8000-000000000022",
  correlationSubmit3: "50000000-0000-4000-8000-000000000023",
  correlationSubmitB: "50000000-0000-4000-8000-000000000024",
  correlationSubmitSelf: "50000000-0000-4000-8000-000000000025",
  correlationSubmitOptional: "50000000-0000-4000-8000-000000000041",
  employeeA: "10000000-0000-4000-8000-000000000004",
  employeeA2: "10000000-0000-4000-8000-000000000005",
  employeeB: "10000000-0000-4000-8000-000000000010",
  managerA: "10000000-0000-4000-8000-000000000002",
  managerA2: "10000000-0000-4000-8000-000000000003",
  managerB: "10000000-0000-4000-8000-000000000009",
  membershipAdminA: "20000000-0000-4000-8000-000000000001",
  membershipAdminB: "20000000-0000-4000-8000-000000000008",
  membershipEmployeeA: "20000000-0000-4000-8000-000000000004",
  membershipEmployeeA2: "20000000-0000-4000-8000-000000000005",
  membershipEmployeeB: "20000000-0000-4000-8000-000000000010",
  membershipManagerA: "20000000-0000-4000-8000-000000000002",
  membershipManagerA2: "20000000-0000-4000-8000-000000000003",
  membershipManagerB: "20000000-0000-4000-8000-000000000009",
  request1: "30000000-0000-4000-8000-000000000001",
  request2: "30000000-0000-4000-8000-000000000002",
  request3: "30000000-0000-4000-8000-000000000003",
  requestB: "30000000-0000-4000-8000-000000000004",
  requestConcurrent: "30000000-0000-4000-8000-000000000005",
  requestDecision: "30000000-0000-4000-8000-000000000006",
  requestDemotionApprove: "30000000-0000-4000-8000-000000000009",
  requestDemotionReject: "30000000-0000-4000-8000-000000000010",
  requestDemotionReplayApprove: "30000000-0000-4000-8000-000000000011",
  requestDemotionReplayReject: "30000000-0000-4000-8000-000000000012",
  requestDemotionView: "30000000-0000-4000-8000-000000000008",
  requestDetailFirstApprove: "30000000-0000-4000-8000-000000000013",
  requestDecisionFirstReject: "30000000-0000-4000-8000-000000000014",
  requestMissing: "30000000-0000-4000-8000-000000000098",
  requestOptionalReject: "30000000-0000-4000-8000-000000000015",
  requestRlsProbe: "30000000-0000-4000-8000-000000000007",
  tenantA: "00000000-0000-4000-8000-000000000001",
  tenantB: "00000000-0000-4000-8000-000000000002",
} as const;

export let migrationPool: Pool;
export let pool: Pool;

export function context(tenantId: string, actorPrincipalId: string, correlationId: string) {
  return { actorPrincipalId, correlationId, tenantId };
}

export async function seedTenantRow(
  client: PoolClient,
  tenantId: string,
  query: string,
  values: readonly unknown[],
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(query, [...values]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function activateLeaveService(
  tenantId: string,
  adminPrincipalId: string,
  correlationId: string,
): Promise<void> {
  await withTenantTransaction(
    pool,
    context(tenantId, adminPrincipalId, correlationId),
    async (transaction) => {
      const authorization = evaluatePolicy(
        {
          actionKey: "platform.service_activation.activate",
          input: { serviceKey: "hr.leave_request" },
          resourceKey: "hr.leave_request",
          transaction,
        },
        [
          {
            effect: "allow",
            id: "tenant_admin_activate_service",
            matches: (_input, actor) => actor.roleKey === "tenant_admin",
          },
        ],
      );
      await setServiceActivation(transaction, {
        authorization,
        evidenceEventType: "evidence.hr.leave_service.activated",
        expectedVersion: null,
        outboxEventType: "hr.leave_service.activated",
        preflight: async () => ({ current: true, reasons: [] }),
        serviceKey: "hr.leave_request",
        targetState: "active",
      });
    },
  );
}

export async function setBooleanSetting(
  tenantId: string,
  key: string,
  value: boolean,
): Promise<void> {
  await withTenantTransaction(
    pool,
    context(tenantId, ids.adminA, ids.correlationSubmit2),
    async ({ client }) => {
      await client.query(
        `INSERT INTO tenant_settings (tenant_id, setting_key, value_type, value)
         VALUES ($1, $2, 'boolean', $3::jsonb)
         ON CONFLICT (tenant_id, setting_key)
         DO UPDATE SET value_type = 'boolean', value = EXCLUDED.value, version = tenant_settings.version + 1`,
        [tenantId, key, JSON.stringify(value)],
      );
    },
  );
}

export async function deleteSetting(tenantId: string, key: string): Promise<void> {
  await withTenantTransaction(
    pool,
    context(tenantId, ids.adminA, ids.correlationSubmit2),
    async ({ client }) => {
      await client.query("DELETE FROM tenant_settings WHERE tenant_id = $1 AND setting_key = $2", [
        tenantId,
        key,
      ]);
    },
  );
}

interface LeavePersistenceSnapshot {
  readonly evidence: readonly Record<string, unknown>[];
  readonly outbox: readonly Record<string, unknown>[];
  readonly requests: readonly Record<string, unknown>[];
  readonly work: readonly Record<string, unknown>[];
}

export async function setManagerAState(
  roleKey: string,
  status: "active" | "suspended",
): Promise<void> {
  await withTenantTransaction(
    pool,
    context(ids.tenantA, ids.adminA, ids.correlationDemotionUpdate),
    async ({ client }) => {
      const updated = await client.query(
        `UPDATE memberships
         SET role_key = $3, status = $4
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenantA, ids.managerA, roleKey, status],
      );
      if (updated.rowCount !== 1) throw new Error("Manager A membership was not updated");
    },
  );
}

export async function snapshotLeavePersistence(
  leaveRequestIds: readonly string[],
): Promise<LeavePersistenceSnapshot> {
  return await withTenantTransaction(
    pool,
    context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSnapshot),
    async ({ client }) => {
      const requests = await client.query<{ value: Record<string, unknown> }>(
        `SELECT to_jsonb(request_row) AS value
         FROM (
           SELECT * FROM hr_leave_requests
           WHERE tenant_id = $1 AND leave_request_id = ANY($2::uuid[])
           ORDER BY leave_request_id
         ) request_row`,
        [ids.tenantA, leaveRequestIds],
      );
      const work = await client.query<{ value: Record<string, unknown> }>(
        `SELECT to_jsonb(work_row) AS value
         FROM (
           SELECT * FROM work_items
           WHERE tenant_id = $1 AND subject_type = 'hr.leave_request'
             AND subject_id = ANY($2::uuid[])
           ORDER BY work_item_id
         ) work_row`,
        [ids.tenantA, leaveRequestIds],
      );
      const evidence = await client.query<{ value: Record<string, unknown> }>(
        `SELECT to_jsonb(evidence_row) AS value
         FROM (
           SELECT * FROM evidence_events
           WHERE tenant_id = $1 AND subject_type = 'hr.leave_request'
             AND subject_id = ANY($2::uuid[])
           ORDER BY evidence_event_id
         ) evidence_row`,
        [ids.tenantA, leaveRequestIds],
      );
      const outbox = await client.query<{ value: Record<string, unknown> }>(
        `SELECT to_jsonb(outbox_row) AS value
         FROM (
           SELECT * FROM outbox_events
           WHERE tenant_id = $1 AND aggregate_type = 'hr.leave_request'
             AND aggregate_id = ANY($2::uuid[])
           ORDER BY event_id
         ) outbox_row`,
        [ids.tenantA, leaveRequestIds],
      );
      return {
        evidence: evidence.rows.map((row) => row.value),
        outbox: outbox.rows.map((row) => row.value),
        requests: requests.rows.map((row) => row.value),
        work: work.rows.map((row) => row.value),
      };
    },
  );
}

export async function expectDeniedWithoutPersistenceChange(
  operation: () => Promise<unknown>,
  expectedCode: "ACTOR_NOT_ACTIVE_MEMBER" | "POLICY_DENIED",
  leaveRequestIds: readonly string[],
  baseline: LeavePersistenceSnapshot,
): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code: expectedCode });
  expect(await snapshotLeavePersistence(leaveRequestIds)).toEqual(baseline);
}

export async function expectBackendBlockedBy(
  observer: PoolClient,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked`,
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Backend ${blockedPid} was not blocked by backend ${blockerPid}`);
}

export async function expectAnyBackendBlockedBy(
  observer: PoolClient,
  blockerPid: number,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked_pid: number }>(
      `SELECT activity.pid AS blocked_pid
       FROM pg_stat_activity activity
       WHERE activity.pid <> pg_backend_pid()
         AND $1::integer = ANY(pg_blocking_pids(activity.pid))
       ORDER BY activity.pid
       LIMIT 1`,
      [blockerPid],
    );
    const blockedPid = result.rows[0]?.blocked_pid;
    if (blockedPid !== undefined) return blockedPid;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`No backend was blocked by backend ${blockerPid}`);
}

interface ControlledPool {
  readonly connected: Promise<number>;
  readonly isPaused: () => boolean;
  readonly paused: Promise<{ readonly pid: number; readonly statement: string }>;
  readonly pool: Pool;
  readonly release: () => void;
}

type PausePredicate = (statement: string, values: readonly unknown[]) => boolean;

export function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

export function createControlledPool(
  targetPool: Pool,
  shouldPause?: PausePredicate,
): ControlledPool {
  let connectionClaimed = false;
  let matched = false;
  let paused = false;
  let released = false;
  let signalConnected: ((pid: number) => void) | undefined;
  let signalPaused:
    | ((value: { readonly pid: number; readonly statement: string }) => void)
    | undefined;
  let signalRelease: (() => void) | undefined;
  const connected = new Promise<number>((resolve) => {
    signalConnected = resolve;
  });
  const pausedPromise = new Promise<{ readonly pid: number; readonly statement: string }>(
    (resolve) => {
      signalPaused = resolve;
    },
  );
  const hold = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });

  const controlledPool = new Proxy(targetPool, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async () => {
          if (connectionClaimed) throw new Error("Controlled pool supports exactly one connection");
          connectionClaimed = true;
          const client = await target.connect();
          let pid: number;
          try {
            pid = Number(
              (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
            );
            if (!Number.isSafeInteger(pid)) throw new Error("Controlled backend PID is invalid");
          } catch (error) {
            client.release();
            throw error;
          }
          signalConnected?.(pid);
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") {
                return async (...args: Parameters<PoolClient["query"]>) => {
                  const result = await clientTarget.query(...args);
                  const statement =
                    typeof args[0] === "string" ? normalizeStatement(args[0]) : undefined;
                  const values = Array.isArray(args[1]) ? args[1] : [];
                  if (!matched && statement !== undefined && shouldPause?.(statement, values)) {
                    matched = true;
                    paused = true;
                    signalPaused?.({ pid, statement });
                    await hold;
                  }
                  return result;
                };
              }
              return Reflect.get(clientTarget, clientProperty, clientReceiver);
            },
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Pool;

  return {
    connected,
    isPaused: () => paused,
    paused: pausedPromise,
    pool: controlledPool,
    release: () => {
      if (released) return;
      released = true;
      signalRelease?.();
    },
  };
}

export async function awaitControlledSignal<T>(
  label: string,
  signal: Promise<T>,
  operation: Promise<unknown>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operationSettled = operation.then<never>(
    () => {
      throw new Error(`${label} operation completed before its control signal`);
    },
    (error: unknown) => {
      throw error;
    },
  );
  const infrastructureDeadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} control signal was not reached within 5 seconds`));
    }, 5_000);
  });
  try {
    return await Promise.race([signal, operationSettled, infrastructureDeadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function matchesLeaveSelector(
  statement: string,
  values: readonly unknown[],
  leaveRequestId: string,
  lock: "detail" | "update",
): boolean {
  return (
    statement.startsWith("SELECT ") &&
    statement.includes(" FROM hr_leave_requests ") &&
    statement.includes(" WHERE tenant_id = $1 AND leave_request_id = $2") &&
    (lock === "update" ? statement.endsWith(" FOR UPDATE") : !statement.endsWith(" FOR UPDATE")) &&
    values[0] === ids.tenantA &&
    values[1] === leaveRequestId
  );
}

export async function observeDirectBlockerUntil(
  observer: PoolClient,
  blockedPid: number,
  blockerPid: number,
  stopped: () => boolean,
): Promise<boolean> {
  const directlyBlocked = async (): Promise<boolean> => {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked",
      [blockedPid, blockerPid],
    );
    return result.rows[0]?.blocked === true;
  };
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await directlyBlocked()) return true;
    if (stopped()) return await directlyBlocked();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Neither direct blocking nor the deterministic stop occurred for backend ${blockedPid}`,
  );
}

export async function setupLeaveIntegration(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!connectionString || !migrationConnectionString || !applicationRole) {
    throw new Error("PostgreSQL harness environment is required");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("Application role is not a safe PostgreSQL identifier");
  }

  migrationPool = createDatabasePool(migrationConnectionString, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrationPool.query(`GRANT SELECT, INSERT ON tenants, principals TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
     ON memberships, service_activations, tenant_settings, work_items,
        outbox_events, hr_leave_requests
     TO ${applicationRole}`,
  );
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);

  pool = createDatabasePool(connectionString, { max: 8 });
  await pool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Admin A'), ($2, 'Manager A'), ($3, 'Manager A2'),
            ($4, 'Employee A'), ($5, 'Employee A2'),
            ($6, 'Admin B'), ($7, 'Manager B'), ($8, 'Employee B')`,
    [
      ids.adminA,
      ids.managerA,
      ids.managerA2,
      ids.employeeA,
      ids.employeeA2,
      ids.adminB,
      ids.managerB,
      ids.employeeB,
    ],
  );

  const client = await pool.connect();
  try {
    await seedTenantRow(
      client,
      ids.tenantA,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'tenant_admin', NULL),
              ($4, $2, $5, 'manager', $6),
              ($7, $2, $6, 'manager', $6),
              ($8, $2, $9, 'employee', $5),
              ($10, $2, $11, 'employee', $5)`,
      [
        ids.membershipAdminA,
        ids.tenantA,
        ids.adminA,
        ids.membershipManagerA,
        ids.managerA,
        ids.managerA2,
        ids.membershipManagerA2,
        ids.membershipEmployeeA,
        ids.employeeA,
        ids.membershipEmployeeA2,
        ids.employeeA2,
      ],
    );
    await seedTenantRow(
      client,
      ids.tenantB,
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
       VALUES ($1, $2, $3, 'tenant_admin', NULL),
              ($4, $2, $5, 'manager', NULL),
              ($6, $2, $7, 'employee', $5)`,
      [
        ids.membershipAdminB,
        ids.tenantB,
        ids.adminB,
        ids.membershipManagerB,
        ids.managerB,
        ids.membershipEmployeeB,
        ids.employeeB,
      ],
    );
  } finally {
    client.release();
  }
  await activateLeaveService(ids.tenantA, ids.adminA, ids.correlationActivateA);
  await activateLeaveService(ids.tenantB, ids.adminB, ids.correlationActivateB);
}
