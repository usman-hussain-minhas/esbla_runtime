import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export function createDatabasePool(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString"> = {},
): Pool {
  return new Pool({ ...options, connectionString });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
