import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import * as schema from "./schema/index.js";

type DatabaseClient = Pool | PoolClient;

export type Database<TClient extends DatabaseClient = Pool> = NodePgDatabase<typeof schema> & {
  readonly $client: TClient;
};

export function createDatabasePool(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString"> = {},
): Pool {
  return new Pool({ ...options, connectionString });
}

export function createDatabase<TClient extends DatabaseClient>(client: TClient): Database<TClient> {
  return drizzle(client, { schema }) as Database<TClient>;
}
