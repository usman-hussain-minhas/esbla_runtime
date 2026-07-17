export { createDatabase, createDatabasePool, type Database } from "./client.js";
export { defaultMigrationsFolder, migrateDatabase } from "./migrate.js";
export { acquireMigrationBarrierShared } from "./migration-coordination.js";
export * from "./schema/index.js";

export const databaseDialect = "postgresql" as const;
