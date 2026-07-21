const runtimeEnvironment: "development" | "production" | "test" =
  process.env.NODE_ENV === "development"
    ? "development"
    : process.env.NODE_ENV === "test"
      ? "test"
      : "production";
if (runtimeEnvironment === "production") {
  throw new Error("Production identity verifier has not been selected or configured");
}
const databaseUrl = process.env.DATABASE_URL;
const migrationDatabaseUrl = process.env.DATABASE_MIGRATION_URL;
const authSecret = process.env.ESBLA_DEV_AUTH_SECRET;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!migrationDatabaseUrl) throw new Error("DATABASE_MIGRATION_URL is required");
if (!authSecret) throw new Error("ESBLA_DEV_AUTH_SECRET is required");

const port = Number.parseInt(process.env.PORT ?? "4000", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const [{ createDatabasePool }, { createDevelopmentAuthenticator }, { createServer }] =
  await Promise.all([import("@esbla/db"), import("./auth.js"), import("./server.js")]);

const pool = createDatabasePool(databaseUrl);
const migrationReadPool = createDatabasePool(migrationDatabaseUrl);
const server = createServer({
  authenticate: createDevelopmentAuthenticator({
    secret: authSecret,
    environment: runtimeEnvironment,
  }),
  migrationReadPool,
  pool,
  runtimeEnvironment,
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
