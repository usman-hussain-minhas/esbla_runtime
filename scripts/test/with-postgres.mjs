import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  throw new Error("Usage: node scripts/test/with-postgres.mjs <command> [...args]");
}

function run(commandPath, commandArgs, options = {}) {
  const { capture = false, ...spawnOptions } = options;
  const result = spawnSync(commandPath, commandArgs, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    ...spawnOptions,
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${commandPath} failed with exit code ${result.status}${details ? `\n${details}` : ""}`,
    );
  }

  return result.stdout?.trim() ?? "";
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

async function runChild(childCommand, childArgs, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(childCommand, childArgs, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${childCommand} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

const pgBin = run("pg_config", ["--bindir"], { capture: true });
const executable = (name) => join(pgBin, name);
const root = await mkdtemp(join(tmpdir(), "esbla-postgres-"));
const dataDirectory = join(root, "data");
const socketDirectory = join(root, "socket");
const logPath = join(root, "postgres.log");
const port = await reservePort();
const databaseName = "esbla_test";
const migrationRole = "esbla_migrator";
const applicationRole = "esbla_app";
let started = false;

try {
  await mkdir(socketDirectory);
  run(executable("initdb"), [
    "--auth=trust",
    "--data-checksums",
    "--encoding=UTF8",
    "--no-locale",
    "--username=postgres",
    "-D",
    dataDirectory,
  ]);
  run(executable("pg_ctl"), [
    "-D",
    dataDirectory,
    "-l",
    logPath,
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`,
    "-w",
    "start",
  ]);
  started = true;

  const connectionArgs = ["--host", "127.0.0.1", "--port", String(port), "--username", "postgres"];
  for (const role of [migrationRole, applicationRole]) {
    run(executable("createuser"), [
      ...connectionArgs,
      "--login",
      "--no-createdb",
      "--no-createrole",
      "--no-superuser",
      role,
    ]);
  }
  run(executable("createdb"), [...connectionArgs, "--owner", migrationRole, databaseName]);
  run(executable("psql"), [
    ...connectionArgs,
    "--dbname",
    databaseName,
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    `ALTER SCHEMA public OWNER TO ${migrationRole}`,
  ]);

  await runChild(command, args, {
    ...process.env,
    DATABASE_MIGRATION_URL: `postgresql://${migrationRole}@127.0.0.1:${port}/${databaseName}`,
    DATABASE_URL: `postgresql://${applicationRole}@127.0.0.1:${port}/${databaseName}`,
    ESBLA_TEST_APPLICATION_ROLE: applicationRole,
  });
} finally {
  if (started) {
    run(executable("pg_ctl"), ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
  }
  await rm(root, { force: true, recursive: true });
}
