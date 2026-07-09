export { createDatabase, createDatabasePool, type Database } from "./client.js";
export { defaultMigrationsFolder, migrateDatabase } from "./migrate.js";
export * from "./schema/index.js";

export const databaseDialect = "postgresql" as const;
