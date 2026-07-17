import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { createDatabase, type Database } from "./client.js";
import {
  acquireMigrationBarrierExclusive,
  releaseMigrationBarrierExclusive,
} from "./migration-coordination.js";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function migrateDatabase(
  database: Database<Pool>,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  const client = await database.$client.connect();
  let reusable = false;
  try {
    await client.query("SET search_path TO public, pg_catalog, pg_temp");
    await acquireMigrationBarrierExclusive(client);
    await migrate(createDatabase(client), { migrationsFolder });
    await releaseMigrationBarrierExclusive(client);
    await client.query("RESET search_path");
    reusable = true;
  } finally {
    client.release(reusable ? undefined : true);
  }
}
