import type { PoolClient } from "pg";

const MIGRATION_BARRIER_NAMESPACE = 1163084364;
const MIGRATION_BARRIER_RESOURCE = 1296648018;

export async function acquireMigrationBarrierShared(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_catalog.pg_advisory_xact_lock_shared($1::integer, $2::integer)`, [
    MIGRATION_BARRIER_NAMESPACE,
    MIGRATION_BARRIER_RESOURCE,
  ]);
}

export async function acquireMigrationBarrierExclusive(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_catalog.pg_advisory_lock($1::integer, $2::integer)`, [
    MIGRATION_BARRIER_NAMESPACE,
    MIGRATION_BARRIER_RESOURCE,
  ]);
}

export async function releaseMigrationBarrierExclusive(client: PoolClient): Promise<void> {
  const result = await client.query<{ unlocked: boolean }>(
    `SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer) AS unlocked`,
    [MIGRATION_BARRIER_NAMESPACE, MIGRATION_BARRIER_RESOURCE],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new Error("Migration coordination lock ownership was lost");
  }
}
