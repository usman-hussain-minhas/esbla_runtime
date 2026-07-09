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
): Promise<T> {
  assertOperationContext(context);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [context.tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
      context.actorPrincipalId,
    ]);
    await client.query("SELECT set_config('app.correlation_id', $1, true)", [
      context.correlationId,
    ]);

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

    const result = await operation({
      actor: { principalId: context.actorPrincipalId, roleKey: actor.role_key },
      client,
      context,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
