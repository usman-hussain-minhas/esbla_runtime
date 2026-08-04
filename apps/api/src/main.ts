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
const notificationProjectorDatabaseUrl = process.env.DATABASE_NOTIFICATION_PROJECTOR_URL;
const authSecret = process.env.ESBLA_DEV_AUTH_SECRET;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!migrationDatabaseUrl) throw new Error("DATABASE_MIGRATION_URL is required");
if (!notificationProjectorDatabaseUrl) {
  throw new Error("DATABASE_NOTIFICATION_PROJECTOR_URL is required");
}
if (!authSecret) throw new Error("ESBLA_DEV_AUTH_SECRET is required");

const port = Number.parseInt(process.env.PORT ?? "4000", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const [
  { createDatabasePool },
  { verifyHrNotificationTargets },
  { assertPresentationSurfaceRegistryCurrent, createNotificationProjector },
  { createDevelopmentAuthenticator },
  { createServer },
] = await Promise.all([
  import("@esbla/db"),
  import("@esbla/hr"),
  import("@esbla/platform-core"),
  import("./auth.js"),
  import("./server.js"),
]);

const pool = createDatabasePool(databaseUrl);
const migrationReadPool = createDatabasePool(migrationDatabaseUrl);
const notificationProjectorPool = createDatabasePool(notificationProjectorDatabaseUrl, { max: 2 });
try {
  await assertPresentationSurfaceRegistryCurrent(pool);
} catch (error) {
  await Promise.all([pool.end(), migrationReadPool.end(), notificationProjectorPool.end()]);
  throw error;
}
const notificationProjector = createNotificationProjector(
  notificationProjectorPool,
  verifyHrNotificationTargets,
  {
    onDiagnostic: ({ code }) => {
      process.stderr.write(`${code}\n`);
    },
  },
);
const server = createServer({
  authenticate: createDevelopmentAuthenticator({
    secret: authSecret,
    environment: runtimeEnvironment,
  }),
  migrationReadPool,
  notificationProjectorWake: notificationProjector.wake,
  pool,
  runtimeEnvironment,
});
server.addHook("onClose", async () => {
  await notificationProjector.stop();
  await Promise.all([pool.end(), migrationReadPool.end(), notificationProjectorPool.end()]);
});

const shutdown = async () => {
  await server.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

notificationProjector.start();
try {
  await server.listen({ host: "0.0.0.0", port });
} catch (error) {
  await server.close();
  throw error;
}
