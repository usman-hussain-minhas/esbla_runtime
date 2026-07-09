import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client.js";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function migrateDatabase(
  database: Database,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  await migrate(database, { migrationsFolder });
}
