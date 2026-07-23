import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  throw new Error("Usage: node scripts/test/with-postgres.mjs <command> [...args]");
}

const setupForceAfterMs = 2_000;
const readinessTimeoutMs = 15_000;
const fastShutdownTimeoutMs = 5_000;
const immediateShutdownTimeoutMs = 2_000;
const hardShutdownTimeoutMs = 1_000;

let activeProcess;
let databaseProcess;
let interrupted;

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalTransient(active, signal, forceAfterMs = active?.forceAfterMs) {
  if (!active?.interruptible || !childIsRunning(active.child)) return;
  active.child.kill(signal);
  if (!forceAfterMs || active.forceTimer) return;
  active.forceTimer = setTimeout(() => {
    if (activeProcess !== active || !childIsRunning(active.child)) return;
    active.forced = true;
    active.child.kill("SIGKILL");
  }, forceAfterMs);
  active.forceTimer.unref();
}

const forward = (signal) => {
  interrupted = signal;
  process.exitCode = 1;
  signalTransient(activeProcess, signal);
};
const forwardInterrupt = () => forward("SIGINT");
const forwardTermination = () => forward("SIGTERM");

process.on("SIGINT", forwardInterrupt);
process.on("SIGTERM", forwardTermination);

function databaseExitError(receipt) {
  const exit = receipt.signal ?? `code ${receipt.code}`;
  return new Error(`PostgreSQL exited unexpectedly with ${exit}`);
}

async function run(commandPath, commandArgs, options = {}) {
  const {
    capture = false,
    forceAfterMs = setupForceAfterMs,
    interruptible = true,
    quiet = false,
    requireDatabase = false,
    timeoutMs,
    ...spawnOptions
  } = options;
  const commandName = basename(commandPath);
  if (interrupted) throw new Error(`${commandName} interrupted by ${interrupted}`);
  if (requireDatabase && databaseProcess?.closed) {
    throw databaseExitError(databaseProcess.receipt);
  }

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(commandPath, commandArgs, {
        stdio: capture
          ? ["ignore", "pipe", "pipe"]
          : quiet
            ? ["ignore", "ignore", "ignore"]
            : "inherit",
        ...spawnOptions,
      });
    } catch {
      reject(new Error(`${commandName} failed to start`));
      return;
    }
    const active = {
      child,
      databaseReceipt: undefined,
      forceAfterMs,
      forceTimer: undefined,
      forced: false,
      interruptible,
      timedOut: false,
      timeoutTimer: undefined,
    };
    activeProcess = active;
    let childError = false;
    let spawned = false;
    let stdout = "";

    if (capture) {
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", () => undefined);
    }
    child.once("spawn", () => (spawned = true));
    child.once("error", () => (childError = true));

    if (timeoutMs) {
      active.timeoutTimer = setTimeout(() => {
        if (!childIsRunning(child)) return;
        active.timedOut = true;
        signalTransient(active, "SIGTERM", 250);
      }, timeoutMs);
      active.timeoutTimer.unref();
    }

    if (requireDatabase) {
      databaseProcess.closePromise.then((receipt) => {
        if (activeProcess !== active || !childIsRunning(child)) return;
        active.databaseReceipt = receipt;
        signalTransient(active, "SIGTERM");
      });
    }

    child.once("close", (code, signal) => {
      if (active.forceTimer) clearTimeout(active.forceTimer);
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      if (activeProcess === active) activeProcess = undefined;
      const controlFailure =
        childError && spawned ? `; ${commandName} process control also failed` : "";
      if (childError && !spawned) {
        reject(new Error(`${commandName} failed to start`));
      } else if (active.databaseReceipt) {
        reject(new Error(`${databaseExitError(active.databaseReceipt).message}${controlFailure}`));
      } else if (interrupted) {
        reject(
          new Error(
            `${commandName} interrupted by ${interrupted}${active.forced ? " after bounded forced termination" : ""}${controlFailure}`,
          ),
        );
      } else if (active.timedOut) {
        reject(new Error(`${commandName} exceeded its bounded runtime${controlFailure}`));
      } else if (childError) {
        reject(new Error(`${commandName} process control failed`));
      } else if (code !== 0) {
        reject(new Error(`${commandName} failed with ${signal ?? `code ${code}`}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a PostgreSQL test port"));
        return;
      }

      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function sanitizedStep(message, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(message);
  }
}

function spawnDatabase(commandPath, commandArgs, logDescriptor, port) {
  const child = spawn(commandPath, commandArgs, {
    detached: false,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  let resolveClose;
  const record = {
    child,
    closePromise: new Promise((resolve) => (resolveClose = resolve)),
    closed: false,
    hardKilled: false,
    port,
    ready: false,
    receipt: undefined,
    spawnFailed: false,
  };
  databaseProcess = record;
  child.once("error", () => (record.spawnFailed = true));
  child.once("close", (code, signal) => {
    record.closed = true;
    record.receipt = { code, signal, spawnFailed: record.spawnFailed };
    resolveClose(record.receipt);
  });
  return record;
}

async function waitForDatabase(database, executable, connectionArgs, expectedDataDirectory) {
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error(`PostgreSQL setup interrupted by ${interrupted}`);
    if (database.closed) throw databaseExitError(database.receipt);
    try {
      const result = await run(
        executable("psql"),
        [
          ...connectionArgs,
          "--dbname",
          "postgres",
          "--no-password",
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--command",
          "SELECT current_setting('data_directory')",
        ],
        {
          capture: true,
          env: { ...process.env, PGCONNECT_TIMEOUT: "1" },
          requireDatabase: true,
          timeoutMs: 1_500,
        },
      );
      if (result === expectedDataDirectory) {
        database.ready = true;
        return;
      }
    } catch (error) {
      if (interrupted || database.closed) throw error;
    }

    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 100)),
      database.closePromise.then((receipt) => {
        throw databaseExitError(receipt);
      }),
    ]);
  }
  throw new Error("PostgreSQL readiness exceeded its bounded runtime");
}

async function runChild(childCommand, childArgs, env) {
  if (interrupted) throw new Error(`${basename(childCommand)} interrupted by ${interrupted}`);
  if (databaseProcess.closed) throw databaseExitError(databaseProcess.receipt);
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(childCommand, childArgs, { env, stdio: "inherit" });
    } catch {
      reject(new Error(`${basename(childCommand)} failed to start`));
      return;
    }
    const active = {
      child,
      forceAfterMs: undefined,
      forceTimer: undefined,
      forced: false,
      interruptible: true,
    };
    activeProcess = active;
    const commandName = basename(childCommand);
    let databaseReceipt;
    let childError = false;
    let spawned = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activeProcess === active) activeProcess = undefined;
      result();
    };
    databaseProcess.closePromise.then((receipt) => {
      if (settled || !childIsRunning(child)) return;
      databaseReceipt = receipt;
      child.kill("SIGTERM");
    });
    child.once("spawn", () => (spawned = true));
    child.once("error", () => (childError = true));
    child.once("close", (code, signal) => {
      const controlFailure =
        childError && spawned ? `; ${commandName} process control also failed` : "";
      if (childError && !spawned) {
        finish(() => reject(new Error(`${commandName} failed to start`)));
      } else if (databaseReceipt) {
        finish(() =>
          reject(new Error(`${databaseExitError(databaseReceipt).message}${controlFailure}`)),
        );
      } else if (interrupted) {
        finish(() =>
          reject(new Error(`${commandName} interrupted by ${interrupted}${controlFailure}`)),
        );
      } else if (childError) {
        finish(() => reject(new Error(`${commandName} process control failed`)));
      } else if (code === 0) {
        finish(resolve);
      } else {
        finish(() => reject(new Error(`${commandName} exited with ${signal ?? `code ${code}`}`)));
      }
    });
  });
}

async function waitForClose(database, timeoutMs) {
  if (database.closed) return true;
  return await Promise.race([
    database.closePromise.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function pathIsAbsent(path) {
  try {
    await access(path);
    return false;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

async function shutdownDatabase(database, dataDirectory, socketDirectory, port) {
  let emergencyShutdown = false;
  let failure = database.closed ? databaseExitError(database.receipt) : undefined;
  if (!database.closed) {
    if (!database.child.kill("SIGINT")) {
      failure = new Error("PostgreSQL fast shutdown request failed");
    }
    if (!(await waitForClose(database, fastShutdownTimeoutMs))) {
      emergencyShutdown = true;
      database.child.kill("SIGQUIT");
      if (!(await waitForClose(database, immediateShutdownTimeoutMs))) {
        database.hardKilled = true;
        database.child.kill("SIGKILL");
        await waitForClose(database, hardShutdownTimeoutMs);
      }
    }
  }

  if (!database.closed) {
    database.child.unref();
    throw new Error("PostgreSQL shutdown could not be proved; test root retained");
  }
  if (database.hardKilled) {
    throw new Error("PostgreSQL required forced shutdown; test root retained");
  }
  if (
    !emergencyShutdown &&
    (database.receipt.spawnFailed ||
      database.receipt.code !== 0 ||
      database.receipt.signal !== null)
  ) {
    failure ??= databaseExitError(database.receipt);
  }
  const absenceReceipts = await Promise.all([
    pathIsAbsent(join(dataDirectory, "postmaster.pid")),
    pathIsAbsent(join(socketDirectory, `.s.PGSQL.${port}`)),
    pathIsAbsent(join(socketDirectory, `.s.PGSQL.${port}.lock`)),
  ]);
  if (absenceReceipts.some((absent) => !absent)) {
    throw new Error("PostgreSQL absence could not be proved; test root retained");
  }
  return { emergencyShutdown, failure, removable: true };
}

let root;
let bodyError;
let cleanupError;

try {
  const pgBin = await run("pg_config", ["--bindir"], { capture: true });
  const executable = (name) => join(pgBin, name);
  const port = await sanitizedStep("Unable to reserve a PostgreSQL test port", reservePort);
  root = await sanitizedStep("PostgreSQL test root initialization failed", () =>
    mkdtemp(join(tmpdir(), "esbla-postgres-")),
  );
  const dataDirectory = join(root, "data");
  const socketDirectory = join(root, "socket");
  const logPath = join(root, "postgres.log");
  const databaseName = "esbla_test";
  const migrationRole = "esbla_migrator";
  const applicationRole = "esbla_app";

  await sanitizedStep("PostgreSQL socket initialization failed", () => mkdir(socketDirectory));
  await run(
    executable("initdb"),
    [
      "--auth=trust",
      "--data-checksums",
      "--encoding=UTF8",
      "--no-locale",
      "--username=postgres",
      "-D",
      dataDirectory,
    ],
    { quiet: true },
  );

  const log = await sanitizedStep("PostgreSQL log initialization failed", () =>
    open(logPath, "a", 0o600),
  );
  try {
    await sanitizedStep("postgres failed to start", async () =>
      spawnDatabase(
        executable("postgres"),
        ["-D", dataDirectory, "-h", "", "-p", String(port), "-k", socketDirectory],
        log.fd,
        port,
      ),
    );
  } finally {
    await sanitizedStep("PostgreSQL log handoff failed", () => log.close());
  }

  const connectionArgs = [
    "--host",
    socketDirectory,
    "--port",
    String(port),
    "--username",
    "postgres",
  ];
  await waitForDatabase(databaseProcess, executable, connectionArgs, dataDirectory);

  for (const role of [migrationRole, applicationRole]) {
    await run(
      executable("createuser"),
      [...connectionArgs, "--login", "--no-createdb", "--no-createrole", "--no-superuser", role],
      { quiet: true, requireDatabase: true },
    );
  }
  await run(executable("createdb"), [...connectionArgs, "--owner", migrationRole, databaseName], {
    quiet: true,
    requireDatabase: true,
  });
  await run(
    executable("psql"),
    [
      ...connectionArgs,
      "--dbname",
      databaseName,
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `ALTER SCHEMA public OWNER TO ${migrationRole}`,
    ],
    { quiet: true, requireDatabase: true },
  );

  await runChild(command, args, {
    ...process.env,
    DATABASE_MIGRATION_URL: `postgresql://${migrationRole}@/${databaseName}?host=${encodeURIComponent(socketDirectory)}&port=${port}`,
    DATABASE_URL: `postgresql://${applicationRole}@/${databaseName}?host=${encodeURIComponent(socketDirectory)}&port=${port}`,
    ESBLA_TEST_APPLICATION_ROLE: applicationRole,
  });
  if (databaseProcess.closed) throw databaseExitError(databaseProcess.receipt);
} catch (error) {
  bodyError = error;
}

try {
  if (activeProcess) {
    throw new Error("A transient test process remained unjoined; test root retained");
  }
  let emergencyShutdown = false;
  let shutdownFailure;
  let removable = Boolean(root);
  if (databaseProcess) {
    const outcome = await shutdownDatabase(
      databaseProcess,
      join(root, "data"),
      join(root, "socket"),
      databaseProcess.port,
    );
    emergencyShutdown = outcome.emergencyShutdown;
    shutdownFailure = outcome.failure;
    removable = outcome.removable;
  }
  if (removable) {
    try {
      await rm(root, { force: true, recursive: true });
    } catch {
      throw new Error("PostgreSQL test root cleanup failed");
    }
  }
  if (shutdownFailure) throw shutdownFailure;
  if (emergencyShutdown) {
    throw new Error("PostgreSQL required emergency shutdown");
  }
} catch (error) {
  cleanupError = error;
}

process.off("SIGINT", forwardInterrupt);
process.off("SIGTERM", forwardTermination);

if (cleanupError) {
  throw new Error(
    bodyError
      ? `${bodyError.message}; PostgreSQL cleanup failed: ${cleanupError.message}`
      : `PostgreSQL cleanup failed: ${cleanupError.message}`,
  );
}
if (bodyError) throw bodyError;
