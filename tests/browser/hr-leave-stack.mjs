import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDevelopmentAuthenticator } from "../../apps/api/dist/auth.js";
import { createServer } from "../../apps/api/dist/server.js";
import { createDatabasePool } from "../../packages/db/dist/index.js";
import {
  closePrivateNextRuntimeRoots,
  closePrivatePlaywrightRoot,
  createFixtureEnvironment,
  createPrivateNextRuntimeRoots,
  createPrivatePlaywrightRoot,
  fixture,
  ports,
  requiredEnvironment,
  seedHrLeaveFixture,
} from "./hr-leave-fixture.mjs";

const fixtureEnvironment = createFixtureEnvironment();
const childRuntimeEnvironment = Object.fromEntries(
  ["HOME", "LANG", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "TERM", "TZ", "XDG_CACHE_HOME"].flatMap(
    (name) => (process.env[name] ? [[name, process.env[name]]] : []),
  ),
);
const artifactPath = process.env.ESBLA_BROWSER_ARTIFACT_DIR?.trim();
const runnerTemp = process.env.RUNNER_TEMP?.trim();
const artifactRelative =
  artifactPath && runnerTemp ? relative(resolve(runnerTemp), resolve(artifactPath)) : undefined;
if (
  artifactPath &&
  (process.env.CI !== "true" ||
    !artifactRelative ||
    artifactRelative.startsWith("..") ||
    isAbsolute(artifactRelative))
) {
  throw new Error("Invalid browser artifact directory");
}
const playwrightArtifactEnvironment = artifactPath
  ? { ESBLA_BROWSER_ARTIFACT_DIR: resolve(artifactPath) }
  : {};

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

await seedHrLeaveFixture();

const applicationPool = createDatabasePool(requiredEnvironment("DATABASE_URL"), { max: 8 });
const migrationReadPool = createDatabasePool(requiredEnvironment("DATABASE_MIGRATION_URL"), {
  max: 2,
});
const server = createServer({
  authenticate: createDevelopmentAuthenticator({
    environment: "test",
    secret: fixtureEnvironment.ESBLA_DEV_AUTH_SECRET,
  }),
  logger: false,
  migrationReadPool,
  pool: applicationPool,
  runtimeEnvironment: "test",
});
server.addHook("onClose", async () => {
  await Promise.all([applicationPool.end(), migrationReadPool.end()]);
});

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const nextCli = fileURLToPath(
  new URL("../../apps/web/node_modules/next/dist/bin/next", import.meta.url),
);
const children = [];
let closing;
let interrupted = false;
let listening;
let nextRuntimeRootPromise;
let playwrightRootPromise;

async function closeApi() {
  if (listening) await listening.catch(() => undefined);
  if (server.server.listening) await server.close();
  else await Promise.all([applicationPool.end(), migrationReadPool.end()]);
}

async function close() {
  if (closing) return closing;
  closing = (async () => {
    for (const processRecord of children) {
      const { child, name } = processRecord;
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const signal = name === "playwright" ? "SIGINT" : "SIGTERM";
        if (child.kill(signal)) processRecord.requestedSignal = signal;
        else processRecord.terminationRequestFailed = true;
      }
    }
    const childReceipts = await Promise.all(children.map((processRecord) => processRecord.closed));
    const infrastructureReceipts = await Promise.allSettled([closeApi()]);
    const rootReceipts = await Promise.allSettled([
      closePrivateNextRuntimeRoots(
        nextRuntimeRootPromise,
        children.filter((processRecord) => processRecord.name !== "playwright"),
      ),
      closePrivatePlaywrightRoot(
        playwrightRootPromise,
        children.find((processRecord) => processRecord.name === "playwright"),
      ),
    ]);
    const abnormalChild = childReceipts.some((receipt, index) => {
      const record = children[index];
      if (record.unexpected || record.terminationRequestFailed || receipt.error) return true;
      if (record.name === "playwright") {
        return receipt.signal !== null || (!interrupted && receipt.code !== 0);
      }
      if (!record.requestedSignal) return receipt.signal !== null || receipt.code !== 0;
      const requestedExitCode = record.requestedSignal === "SIGTERM" ? 143 : 130;
      return !(
        receipt.signal === record.requestedSignal ||
        (receipt.signal === null && [0, requestedExitCode].includes(receipt.code))
      );
    });
    if (
      abnormalChild ||
      [...infrastructureReceipts, ...rootReceipts].some((receipt) => receipt.status === "rejected")
    ) {
      throw new Error("Browser stack cleanup failed");
    }
    console.log("STACK_CLOSED_WITH_VALIDATED_RECEIPTS");
  })();
  return closing;
}

function startChild(name, command, args, options, unexpectedExit) {
  const child = spawn(command, args, {
    ...options,
    detached: false,
    shell: false,
    stdio: "inherit",
  });
  let settle;
  let settled = false;
  const closed = new Promise((resolve) => (settle = resolve));
  const record = { child, closed, name };
  const finish = (receipt) => {
    if (settled) return;
    settled = true;
    record.settled = true;
    record.receipt = receipt;
    settle(receipt);
    if (unexpectedExit && !closing) {
      record.unexpected = true;
      process.exitCode = 1;
      queueMicrotask(() => void close().catch(() => (process.exitCode = 1)));
    }
  };
  let spawnError = false;
  child.once("error", () => (spawnError = true));
  child.once("close", (code, signal) => finish({ code, error: spawnError, signal }));
  children.push(record);
  return record;
}

function startWeb(origin, principalId, label, projectRoot) {
  return startChild(
    label,
    process.execPath,
    [nextCli, "start", projectRoot, "--hostname", "127.0.0.1", "--port", origin.port],
    {
      cwd: projectRoot,
      env: {
        ...childRuntimeEnvironment,
        ...fixtureEnvironment,
        ESBLA_DEV_PRINCIPAL_ID: principalId,
        ESBLA_DEV_SESSION_LABEL: label,
        ESBLA_DEV_TENANT_ID: fixture.tenantId,
        NODE_ENV: "development",
      },
    },
    true,
  );
}

async function requireActorReady(origin, label, web) {
  for (let attempt = 0; attempt < 100 && !web.settled; attempt += 1) {
    try {
      const response = await fetch(new URL("/workspace/hr/leave/new", origin), {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200 && (await response.text()).includes(label) && !web.settled)
        return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Web identity ${label} did not become ready`);
}

const handleSignal = () => {
  interrupted = true;
  process.exitCode = 1;
  void close().catch(() => (process.exitCode = 1));
};
process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);

try {
  if ((await Promise.all(Object.values(ports).map(portOpen))).some(Boolean)) {
    throw new Error("Browser fixture port occupied");
  }
  if (!closing) {
    listening = server.listen({ host: "127.0.0.1", port: ports.api });
    await listening;
  }
  if (!closing) {
    nextRuntimeRootPromise = createPrivateNextRuntimeRoots(webRoot);
    const nextRuntimeRoot = await nextRuntimeRootPromise;
    if (closing) throw new Error("Browser stack closing before web startup");
    const employee = startWeb(
      new URL(fixture.employeeOrigin),
      fixture.employeePrincipalId,
      fixture.employeeLabel,
      nextRuntimeRoot.projects.employee,
    );
    const manager = startWeb(
      new URL(fixture.managerOrigin),
      fixture.managerPrincipalId,
      fixture.managerLabel,
      nextRuntimeRoot.projects.manager,
    );
    const operator = startWeb(
      new URL(fixture.operatorOrigin),
      fixture.operatorPrincipalId,
      fixture.operatorLabel,
      nextRuntimeRoot.projects.operator,
    );
    const admin = startWeb(
      new URL(fixture.adminOrigin),
      fixture.adminPrincipalId,
      fixture.adminLabel,
      nextRuntimeRoot.projects.admin,
    );
    await Promise.all([
      requireActorReady(new URL(fixture.employeeOrigin), fixture.employeeLabel, employee),
      requireActorReady(new URL(fixture.managerOrigin), fixture.managerLabel, manager),
      requireActorReady(new URL(fixture.operatorOrigin), fixture.operatorLabel, operator),
      requireActorReady(new URL(fixture.adminOrigin), fixture.adminLabel, admin),
    ]);
  }
  if (!closing) {
    playwrightRootPromise = createPrivatePlaywrightRoot();
    const playwrightRoot = await playwrightRootPromise;
    if (!closing) {
      const playwright = startChild(
        "playwright",
        process.execPath,
        ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
        {
          cwd: repoRoot,
          env: {
            ...childRuntimeEnvironment,
            ...playwrightArtifactEnvironment,
            TMPDIR: playwrightRoot.path,
          },
        },
        false,
      );
      const result = await playwright.closed;
      if (!closing && (result.error || result.signal || result.code !== 0)) process.exitCode = 1;
    }
  }
  await close();
} catch {
  process.exitCode = 1;
  await close();
  throw new Error("Browser stack failed");
}
