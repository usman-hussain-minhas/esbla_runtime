import { acquireMigrationBarrierShared } from "@esbla/db";
import type { Pool, PoolClient } from "pg";
import { PlatformError } from "./errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OperationContext {
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly tenantId: string;
}

export interface TenantActor {
  readonly principalId: string;
  readonly roleKey: string;
}

export interface TenantTransaction {
  readonly actor: TenantActor;
  readonly client: PoolClient;
  readonly context: OperationContext;
  readonly lockedServiceActivation?: LockedServiceActivation | null;
}

export interface LockedServiceActivation {
  readonly serviceKey: string;
  readonly state: "active" | "inactive";
  readonly version: number;
}

export interface TenantTransactionOptions {
  readonly migrationBarrier?: "shared";
  readonly serviceActivationKey?: string;
  readonly serviceActivationLock?: "share" | "update";
}

function assertOperationContext(context: OperationContext): void {
  const invalidFields = Object.entries(context)
    .filter(([, value]) => !UUID_PATTERN.test(value))
    .map(([field]) => field);

  if (invalidFields.length > 0) {
    throw new PlatformError("INVALID_OPERATION_CONTEXT", "Operation context must contain UUIDs", {
      invalidFields,
    });
  }
}

export async function withTenantTransaction<T>(
  pool: Pool,
  context: OperationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  assertOperationContext(context);
  const client = await pool.connect();

  let discardClient = false;
  try {
    await client.query("BEGIN");
    if (options.migrationBarrier === "shared") {
      await acquireMigrationBarrierShared(client);
    }
    await client.query("SET LOCAL search_path TO pg_catalog, public, pg_temp");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [context.tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
      context.actorPrincipalId,
    ]);
    await client.query("SELECT set_config('app.correlation_id', $1, true)", [
      context.correlationId,
    ]);

    let lockedServiceActivation: LockedServiceActivation | null | undefined;
    if (options.serviceActivationKey !== undefined) {
      if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(options.serviceActivationKey)) {
        throw new PlatformError("INVALID_SERVICE_KEY", "Service activation lock key is invalid");
      }
      const activation = await client.query<{
        service_key: string;
        state: "active" | "inactive";
        version: number;
      }>(
        `SELECT service_key, state, version
         FROM service_activations
         WHERE tenant_id = $1 AND service_key = $2
         ${options.serviceActivationLock === "update" ? "FOR UPDATE" : "FOR SHARE"}`,
        [context.tenantId, options.serviceActivationKey],
      );
      const row = activation.rows[0];
      lockedServiceActivation = row
        ? { serviceKey: row.service_key, state: row.state, version: row.version }
        : null;
    } else if (options.serviceActivationLock !== undefined) {
      throw new PlatformError(
        "INVALID_SERVICE_KEY",
        "Service activation lock mode requires a service key",
      );
    }

    const membership = await client.query<{ role_key: string; status: string }>(
      `SELECT role_key, status
       FROM memberships
       WHERE tenant_id = $1 AND principal_id = $2
       FOR SHARE`,
      [context.tenantId, context.actorPrincipalId],
    );
    const actor = membership.rows[0];
    if (actor?.status !== "active") {
      throw new PlatformError(
        "ACTOR_NOT_ACTIVE_MEMBER",
        "Actor is not an active member of the tenant",
        { actorPrincipalId: context.actorPrincipalId, tenantId: context.tenantId },
      );
    }

    const transactionBase = {
      actor: { principalId: context.actorPrincipalId, roleKey: actor.role_key },
      client,
      context,
    };
    const transaction: TenantTransaction =
      options.serviceActivationKey === undefined
        ? transactionBase
        : { ...transactionBase, lockedServiceActivation: lockedServiceActivation ?? null };
    const result = await operation(transaction);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient ? true : undefined);
  }
}
