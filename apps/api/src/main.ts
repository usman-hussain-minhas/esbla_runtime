import { createDatabasePool } from "@esbla/db";
import { createDevelopmentAuthenticator } from "./auth.js";
import { createServer } from "./server.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationDatabaseUrl = process.env.DATABASE_MIGRATION_URL;
if (process.env.NODE_ENV === "production") {
  throw new Error("Production identity verifier has not been selected or configured");
}
const authSecret = process.env.ESBLA_DEV_AUTH_SECRET;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!migrationDatabaseUrl) throw new Error("DATABASE_MIGRATION_URL is required");
if (!authSecret) throw new Error("ESBLA_DEV_AUTH_SECRET is required");

const port = Number.parseInt(process.env.PORT ?? "4000", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const pool = createDatabasePool(databaseUrl);
const migrationReadPool = createDatabasePool(migrationDatabaseUrl, { max: 2 });
const server = createServer({
  authenticate: createDevelopmentAuthenticator({
    secret: authSecret,
    ...(process.env.NODE_ENV ? { environment: process.env.NODE_ENV } : {}),
  }),
  migrationReadPool,
  pool,
});
server.addHook("onClose", async () => {
  await Promise.all([pool.end(), migrationReadPool.end()]);
});

const shutdown = async () => {
  await server.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await server.listen({ host: "0.0.0.0", port });
