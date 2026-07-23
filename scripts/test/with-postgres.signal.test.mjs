import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const wrapperPath = fileURLToPath(new URL("with-postgres.mjs", import.meta.url));
const fakePostgres = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { createConnection, createServer } = require("node:net");
const { basename, join } = require("node:path");

const command = basename(process.argv[1]);
const receipt = process.env.ESBLA_FAKE_PG_RECEIPT;
const record = (value) => appendFileSync(receipt, value + "\\n");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];

if (command === "pg_config") {
  process.stdout.write(process.env.ESBLA_FAKE_PG_BIN);
} else if (command === "initdb") {
  record("initdb:start");
  mkdirSync(argument("-D"), { recursive: true });
} else if (command === "postgres") {
  const dataDirectory = argument("-D");
  const port = Number(argument("-p"));
  const socketPath = join(argument("-k"), ".s.PGSQL." + port);
  const pidFile = join(dataDirectory, "postmaster.pid");
  const mode = process.env.ESBLA_FAKE_DB_MODE;
  const ownerPid = process.ppid;
  let finished = false;
  let server;
  let stopping = false;
  writeFileSync(pidFile, String(process.pid));
  record("postgres:start");

  const finish = (receipt = "postgres:close", code = 0) => {
    if (finished) return;
    finished = true;
    clearInterval(ownerCheck);
    clearTimeout(selfExpiry);
    const complete = () => {
      rmSync(pidFile, { force: true });
      record(receipt);
      process.exit(code);
    };
    if (server) server.close(complete);
    else complete();
  };
  const ownerCheck = setInterval(() => {
    if (process.ppid !== ownerPid) finish("postgres:owner-lost-close");
  }, 100);
  const selfExpiry = setTimeout(() => finish("postgres:self-expiry-close"), 20000);

  const close = (signal) => {
    record("postgres:" + signal);
    if (mode === "abnormal-fast-close" && signal === "SIGINT") {
      stopping = true;
      setTimeout(() => finish("postgres:abnormal-close", 7), 25);
      return;
    }
    if (mode === "ignore-all" || (mode === "ignore-int" && signal === "SIGINT")) return;
    if (stopping) return;
    stopping = true;
    setTimeout(
      () => finish(),
      Number(process.env.ESBLA_FAKE_SHUTDOWN_DELAY_MS || "25"),
    );
  };
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGQUIT", () => close("SIGQUIT"));
  process.on("SIGTERM", () => close("SIGTERM"));

  if (mode === "early-exit") {
    setTimeout(() => {
      rmSync(pidFile, { force: true });
      record("postgres:early-exit");
      process.exit(7);
    }, 25);
  } else if (mode === "never-ready") {
    setInterval(() => undefined, 1000);
  } else {
    server = createServer((socket) =>
      socket.end(mode === "wrong-identity" ? "/not-the-owned-data-directory" : dataDirectory),
    );
    server.listen(socketPath, () => record("postgres:ready"));
  }
} else if (command === "psql") {
  const socket = createConnection(
    join(argument("--host"), ".s.PGSQL." + Number(argument("--port"))),
  );
  let settled = false;
  let identity = "";
  const finish = (code, value = "") => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (code === 0) {
      record("psql:identity");
      process.stdout.write(value + "\\n");
    }
    process.exit(code);
  };
  socket.setTimeout(1000);
  socket.on("data", (chunk) => (identity += chunk));
  socket.once("end", () => finish(0, identity));
  socket.once("error", () => finish(1));
  socket.once("timeout", () => finish(1));
} else if (command === "createuser" && process.env.ESBLA_FAKE_SLOW_BOOTSTRAP === "true") {
  process.on("SIGTERM", () => record("createuser:SIGTERM-ignored"));
  record("createuser:start");
  setTimeout(() => process.exit(0), 5000);
  setInterval(() => undefined, 1000);
} else {
  record(command + ":start");
}
`;

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "esbla-signal-proof-"));
  const fakeBin = join(root, "bin");
  const wrapperTemp = await mkdtemp("/tmp/esbla-wrapper-");
  const receiptPath = join(root, "pg-receipt.txt");
  await mkdir(fakeBin);
  for (const command of ["pg_config", "initdb", "postgres", "createuser", "createdb", "psql"]) {
    const path = join(fakeBin, command);
    await writeFile(path, fakePostgres, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  return { fakeBin, options, receiptPath, root, wrapperTemp };
}

function launch(
  subject,
  payload = `console.log("PAYLOAD_COMPLETE")`,
  childCommand = process.execPath,
  childArgs = ["-e", payload],
) {
  const child = spawn(process.execPath, [wrapperPath, childCommand, ...childArgs], {
    env: {
      ...process.env,
      ESBLA_FAKE_DB_MODE: subject.options.databaseMode ?? "normal",
      ESBLA_FAKE_PG_BIN: subject.fakeBin,
      ESBLA_FAKE_PG_RECEIPT: subject.receiptPath,
      ESBLA_FAKE_SHUTDOWN_DELAY_MS: String(subject.options.shutdownDelayMs ?? 25),
      ESBLA_FAKE_SLOW_BOOTSTRAP: subject.options.slowBootstrap ? "true" : "false",
      PATH: `${subject.fakeBin}${delimiter}${process.env.PATH}`,
      TMPDIR: subject.wrapperTemp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = { value: "" };
  const stderr = { value: "" };
  child.stdout.on("data", (chunk) => (stdout.value += chunk));
  child.stderr.on("data", (chunk) => (stderr.value += chunk));
  const closePromise = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return { child, closePromise, stderr, stdout };
}

const childIsRunning = (child) => child.exitCode === null && child.signalCode === null;

function assertSanitized(run, subject) {
  assert.equal(run.stderr.value.includes(subject.root), false);
  assert.equal(run.stderr.value.includes(subject.wrapperTemp), false);
}

async function waitUntil(read, predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForOutput(run, marker) {
  return await waitUntil(
    async () => run.stdout.value,
    (value) => value.includes(marker),
    marker,
  );
}

async function receipt(subject) {
  try {
    return await readFile(subject.receiptPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function waitForReceipt(subject, marker) {
  return await waitUntil(
    async () => await receipt(subject),
    (value) => value.includes(marker),
    marker,
  );
}

async function closeWithin(run, timeoutMs = 9_000) {
  let timer;
  try {
    return await Promise.race([
      run.closePromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Wrapper exceeded its internal shutdown bounds")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanup(subject, run) {
  let rescueUsed = false;
  if (run && childIsRunning(run.child)) {
    rescueUsed = true;
    run.child.kill("SIGTERM");
    try {
      await closeWithin(run);
    } catch {
      run.child.stdout.destroy();
      run.child.stderr.destroy();
      run.child.unref();
      throw new Error("Wrapper cleanup remained unproved; fixture root retained");
    }
  }
  const proof = await receipt(subject);
  const databaseStarted = proof.includes("postgres:start");
  const databaseClosed =
    /postgres:(?:close|early-exit|abnormal-close|owner-lost-close|self-expiry-close)/.test(proof);
  const exactHardShutdown = run?.stderr.value.includes("PostgreSQL required forced shutdown");
  if (databaseStarted && !databaseClosed && !exactHardShutdown) {
    throw new Error("Database absence remained unproved; fixture root retained");
  }
  await Promise.all([
    rm(subject.root, { force: true, recursive: true }),
    rm(subject.wrapperTemp, { force: true, recursive: true }),
  ]);
  return rescueUsed;
}

async function verifyWithCleanup(subject, run, proof) {
  let proofError;
  try {
    await proof();
  } catch (error) {
    proofError = error;
  }

  let cleanupError;
  let rescueUsed;
  try {
    rescueUsed = await cleanup(subject, run);
  } catch (error) {
    cleanupError = error;
  }

  if (rescueUsed) {
    const rescueError = new Error("Cooperative external rescue was required");
    cleanupError = cleanupError
      ? new AggregateError([cleanupError, rescueError], "Cleanup required rescue and also failed")
      : rescueError;
  }

  if (proofError && cleanupError) {
    throw new AggregateError([proofError, cleanupError], "Lifecycle proof and cleanup both failed");
  }
  if (cleanupError) throw cleanupError;
  if (proofError) throw proofError;
  assert.equal(rescueUsed, false, "external rescue must remain unused");
}

async function proveRepeatedProductSignal(signal) {
  const subject = await fixture();
  const payload = `
    let received = 0;
    process.on("${signal}", () => {
      received += 1;
      console.log("CHILD_SIGNAL_" + received);
      if (received === 1) setTimeout(() => process.exit(0), 1500);
      if (received === 2) setTimeout(() => process.exit(0), 25);
    });
    console.log("PROBE_READY");
    setInterval(() => undefined, 1000);
  `;
  const run = launch(subject, payload);
  await verifyWithCleanup(subject, run, async () => {
    await waitForOutput(run, "PROBE_READY");
    assert.equal(run.child.kill(signal), true);
    await waitForOutput(run, "CHILD_SIGNAL_1");
    assert.equal(run.child.kill(signal), true);
    await waitForOutput(run, "CHILD_SIGNAL_2");
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(run.stderr.value, new RegExp(`Error: node interrupted by ${signal}`));
    assertSanitized(run, subject);
    assert.match(await receipt(subject), /postgres:SIGINT\npostgres:close\n/);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
    assert.equal(childIsRunning(run.child), false);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(
    `with-postgres retains exact cleanup ownership after repeated ${signal}`,
    { timeout: 20_000 },
    async () => await proveRepeatedProductSignal(signal),
  );
}

test("with-postgres bounds an interrupted setup utility", { timeout: 20_000 }, async () => {
  const subject = await fixture({ slowBootstrap: true });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    await waitForReceipt(subject, "createuser:start");
    assert.equal(run.child.kill("SIGTERM"), true);
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(
      run.stderr.value,
      /Error: createuser interrupted by SIGTERM after bounded forced termination/,
    );
    assertSanitized(run, subject);
    assert.match(
      await receipt(subject),
      /createuser:start\ncreateuser:SIGTERM-ignored\npostgres:SIGINT\npostgres:close\n/,
    );
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres cancels readiness and joins the foreground database", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture({ databaseMode: "never-ready" });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    await waitForReceipt(subject, "postgres:start");
    assert.equal(run.child.kill("SIGTERM"), true);
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(run.stderr.value, /interrupted by SIGTERM/);
    assertSanitized(run, subject);
    assert.match(await receipt(subject), /postgres:SIGINT\npostgres:close\n/);
    assert.equal(run.stdout.value.includes("PAYLOAD_COMPLETE"), false);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres aborts on an early foreground database exit", { timeout: 20_000 }, async () => {
  const subject = await fixture({ databaseMode: "early-exit" });
  const marker = join(subject.root, "payload-ran");
  const run = launch(
    subject,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected")`,
  );
  await verifyWithCleanup(subject, run, async () => {
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(
      run.stderr.value,
      /PostgreSQL cleanup failed: PostgreSQL exited unexpectedly with code 7/,
    );
    assertSanitized(run, subject);
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres joins an exact payload spawn failure before database cleanup", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture();
  const missingPayload = join(subject.root, "missing-payload");
  const run = launch(subject, undefined, missingPayload, []);
  await verifyWithCleanup(subject, run, async () => {
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(run.stderr.value, /Error: missing-payload failed to start/);
    assertSanitized(run, subject);
    assert.match(await receipt(subject), /postgres:SIGINT\npostgres:close\n/);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres fails closed before setup on a wrong server identity", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture({ databaseMode: "wrong-identity" });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    await waitForReceipt(subject, "psql:identity");
    assert.equal(run.child.kill("SIGTERM"), true);
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    const proof = await receipt(subject);
    assert.doesNotMatch(proof, /createuser:start|createdb:start/);
    assert.equal(run.stdout.value.includes("PAYLOAD_COMPLETE"), false);
    assertSanitized(run, subject);
    assert.match(proof, /postgres:SIGINT\npostgres:close\n/);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres rejects an abnormal close at the shutdown boundary", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture({ databaseMode: "abnormal-fast-close" });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(
      run.stderr.value,
      /PostgreSQL cleanup failed: PostgreSQL exited unexpectedly with code 7/,
    );
    assertSanitized(run, subject);
    assert.match(await receipt(subject), /postgres:SIGINT\npostgres:abnormal-close\n/);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres uses exact SIGQUIT fallback and then removes a clean root", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture({ databaseMode: "ignore-int" });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(await receipt(subject), /postgres:SIGINT\npostgres:SIGQUIT\npostgres:close\n/);
    assert.match(
      run.stderr.value,
      /PostgreSQL cleanup failed: PostgreSQL required emergency shutdown/,
    );
    assertSanitized(run, subject);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres retains the root after exact hard shutdown", { timeout: 20_000 }, async () => {
  const subject = await fixture({ databaseMode: "ignore-all" });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    assert.deepEqual(await closeWithin(run), { code: 1, signal: null });
    assert.match(await receipt(subject), /postgres:SIGINT\npostgres:SIGQUIT\n/);
    assert.doesNotMatch(await receipt(subject), /postgres:close/);
    assert.match(
      run.stderr.value,
      /PostgreSQL cleanup failed: PostgreSQL required forced shutdown; test root retained/,
    );
    assertSanitized(run, subject);
    assert.equal((await readdir(subject.wrapperTemp)).length, 1);
    assert.equal(childIsRunning(run.child), false);
  });
});

test("with-postgres deletes the root only after foreground close", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture({ shutdownDelayMs: 400 });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    await waitForReceipt(subject, "postgres:SIGINT");
    assert.equal((await readdir(subject.wrapperTemp)).length, 1);
    assert.deepEqual(await closeWithin(run), { code: 0, signal: null });
    assert.match(await receipt(subject), /postgres:SIGINT\npostgres:close\n/);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("with-postgres allows a bounded cooperative fast shutdown before emergency escalation", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture({ shutdownDelayMs: 2_500 });
  const run = launch(subject);
  await verifyWithCleanup(subject, run, async () => {
    assert.deepEqual(await closeWithin(run), { code: 0, signal: null });
    const proof = await receipt(subject);
    assert.match(proof, /postgres:SIGINT\npostgres:close\n/);
    assert.doesNotMatch(proof, /postgres:SIGQUIT/);
    assertSanitized(run, subject);
    assert.deepEqual(await readdir(subject.wrapperTemp), []);
  });
});

test("fake database closes itself after exact wrapper ownership is lost", {
  timeout: 20_000,
}, async () => {
  const subject = await fixture();
  const run = launch(
    subject,
    `console.log("PROBE_READY"); setTimeout(() => process.exit(0), 1000)`,
  );
  await verifyWithCleanup(subject, run, async () => {
    await waitForOutput(run, "PROBE_READY");
    assert.equal(run.child.kill("SIGKILL"), true);
    assert.deepEqual(await closeWithin(run), { code: null, signal: "SIGKILL" });
    await waitForReceipt(subject, "postgres:owner-lost-close");
    const [databaseRoot] = await readdir(subject.wrapperTemp);
    assert.ok(databaseRoot);
    await assert.rejects(
      access(join(subject.wrapperTemp, databaseRoot, "data", "postmaster.pid")),
      { code: "ENOENT" },
    );
    assert.deepEqual(await readdir(join(subject.wrapperTemp, databaseRoot, "socket")), []);
  });
});

test("with-postgres never uses PID, PGID, or detached signaling", async () => {
  const source = await readFile(wrapperPath, "utf8");
  assert.doesNotMatch(source, /process\.kill\s*\(/);
  assert.doesNotMatch(source, /detached:\s*true/);
});
