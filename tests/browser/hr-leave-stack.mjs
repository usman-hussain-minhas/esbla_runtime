import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const testControlToken = randomBytes(32).toString("hex");
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

const seededFixture = await seedHrLeaveFixture();

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
const webPersonas = new Map();
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
    if (unexpectedExit && !closing && !record.expectedStop) {
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

function startWeb(origin, principalId, label, projectRoot, tenantId = fixture.tenantId) {
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
        ESBLA_DEV_TENANT_ID: tenantId,
        NODE_ENV: "development",
      },
    },
    true,
  );
}

function startWebPersona(
  persona,
  origin,
  principalId,
  label,
  projectRoot,
  tenantId = fixture.tenantId,
) {
  const record = startWeb(origin, principalId, label, projectRoot, tenantId);
  record.restartSpec = { label, origin, principalId, projectRoot, tenantId };
  webPersonas.set(persona, record);
  return record;
}

async function requireActorReady(origin, label, web, pathname = "/workspace/hr/leave/new") {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !web.settled) {
    try {
      const response = await fetch(new URL(pathname, origin), {
        signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, deadline - Date.now()))),
      });
      if (
        response.status === 200 &&
        (await response.text()).includes('class="esbla-shell"') &&
        !web.settled
      ) {
        return;
      }
    } catch {}
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(1_000, remaining));
  }
  throw new Error(`Web persona ${label} did not become ready`);
}

async function restartWebPersona(persona) {
  const current = webPersonas.get(persona);
  if (!current?.restartSpec || current.settled || closing) {
    throw new Error("Web restart target is unavailable");
  }
  current.expectedStop = true;
  current.requestedSignal = "SIGTERM";
  if (!current.child.kill("SIGTERM")) {
    current.terminationRequestFailed = true;
    throw new Error("Web restart stop request failed");
  }
  const receipt = await Promise.race([
    current.closed,
    delay(10_000).then(() => {
      throw new Error("Web restart stop exceeded its bounded runtime");
    }),
  ]);
  if (
    receipt.error ||
    !(receipt.signal === "SIGTERM" || (receipt.signal === null && [0, 143].includes(receipt.code)))
  ) {
    throw new Error("Web restart stop receipt is invalid");
  }
  const { label, origin, principalId, projectRoot, tenantId } = current.restartSpec;
  const replacement = startWebPersona(persona, origin, principalId, label, projectRoot, tenantId);
  await requireActorReady(origin, label, replacement);
}

function hasExactKeys(value, keys) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function testControlAuthorized(request) {
  return request.headers["x-esbla-test-control"] === testControlToken;
}

server.post("/__esbla-test-control/restart-web", async (request, reply) => {
  if (!testControlAuthorized(request)) return await reply.code(404).send({ status: "not_found" });
  if (!hasExactKeys(request.body, ["persona"]) || request.body.persona !== "employee") {
    return await reply.code(400).send({ status: "invalid" });
  }
  await restartWebPersona(request.body.persona);
  return { status: "restarted" };
});

server.post("/__esbla-test-control/leave-presentation-eligibility", async (request, reply) => {
  if (!testControlAuthorized(request)) return await reply.code(404).send({ status: "not_found" });
  if (
    !hasExactKeys(request.body, ["active", "capabilities"]) ||
    typeof request.body.active !== "boolean" ||
    !Array.isArray(request.body.capabilities) ||
    request.body.capabilities.some(
      (capability) =>
        capability !== "hr.leave.list_own" &&
        capability !== "hr.leave.submit" &&
        capability !== "hr.leave.view",
    ) ||
    new Set(request.body.capabilities).size !== request.body.capabilities.length
  ) {
    return await reply.code(400).send({ status: "invalid" });
  }
  const client = await migrationReadPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
      fixture.employeePrincipalId,
    ]);
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'hr.leave_request', $2, 1)
       ON CONFLICT (tenant_id, service_key)
       DO UPDATE SET state = EXCLUDED.state, version = service_activations.version + 1`,
      [fixture.tenantId, request.body.active ? "active" : "inactive"],
    );
    await client.query(
      `DELETE FROM membership_capabilities
       WHERE tenant_id = $1 AND principal_id = $2
         AND capability_id = ANY($3::text[])`,
      [
        fixture.tenantId,
        fixture.employeePrincipalId,
        ["hr.leave.list_own", "hr.leave.submit", "hr.leave.view"],
      ],
    );
    if (request.body.capabilities.length > 0) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1, $2, capability_id
         FROM unnest($3::text[]) AS capability(capability_id)`,
        [fixture.tenantId, fixture.employeePrincipalId, request.body.capabilities],
      );
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return await reply.code(500).send({ status: "failed" });
  } finally {
    client.release();
  }
  return { status: "updated" };
});

server.post("/__esbla-test-control/workforce-presentation-eligibility", async (request, reply) => {
  if (!testControlAuthorized(request)) return await reply.code(404).send({ status: "not_found" });
  if (!hasExactKeys(request.body, ["eligible"]) || typeof request.body.eligible !== "boolean") {
    return await reply.code(400).send({ status: "invalid" });
  }
  const client = await migrationReadPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
      fixture.employeePrincipalId,
    ]);
    await client.query(
      `DELETE FROM membership_capabilities
       WHERE tenant_id = $1 AND principal_id = $2
         AND capability_id = ANY($3::text[])`,
      [
        fixture.tenantId,
        fixture.employeePrincipalId,
        ["hr.workforce.view_own", "hr.workforce.view_authorized_detail"],
      ],
    );
    if (request.body.eligible) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1, $2, capability_id
         FROM unnest($3::text[]) AS capability(capability_id)`,
        [
          fixture.tenantId,
          fixture.employeePrincipalId,
          ["hr.workforce.view_own", "hr.workforce.view_authorized_detail"],
        ],
      );
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return await reply.code(500).send({ status: "failed" });
  } finally {
    client.release();
  }
  return { status: "updated" };
});

server.post("/__esbla-test-control/presentation-layout-write", async (request, reply) => {
  if (!testControlAuthorized(request)) return await reply.code(404).send({ status: "not_found" });
  if (!hasExactKeys(request.body, ["enabled"]) || typeof request.body.enabled !== "boolean") {
    return await reply.code(400).send({ status: "invalid" });
  }
  const client = await migrationReadPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
      fixture.employeePrincipalId,
    ]);
    await client.query(
      request.body.enabled
        ? `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
           VALUES ($1,$2,'platform.presentation.layouts.write_own')
           ON CONFLICT DO NOTHING`
        : `DELETE FROM membership_capabilities
           WHERE tenant_id=$1 AND principal_id=$2
             AND capability_id='platform.presentation.layouts.write_own'`,
      [fixture.tenantId, fixture.employeePrincipalId],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return await reply.code(500).send({ status: "failed" });
  } finally {
    client.release();
  }
  return { status: "updated" };
});

const studioSurfaceBaseCapabilities = new Set([
  "platform.studio.surface_base.draft",
  "platform.studio.surface_base.publish",
  "platform.studio.surface_base.read",
  "platform.studio.surface_base.rollback",
  "platform.studio.surface_base.validate",
]);

server.post("/__esbla-test-control/studio-surface-base-capability", async (request, reply) => {
  if (!testControlAuthorized(request)) return await reply.code(404).send({ status: "not_found" });
  if (
    !hasExactKeys(request.body, ["capabilityId", "enabled"]) ||
    typeof request.body.capabilityId !== "string" ||
    !studioSurfaceBaseCapabilities.has(request.body.capabilityId) ||
    typeof request.body.enabled !== "boolean"
  ) {
    return await reply.code(400).send({ status: "invalid" });
  }
  const client = await migrationReadPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
      fixture.adminPrincipalId,
    ]);
    await client.query(
      request.body.enabled
        ? `INSERT INTO membership_capabilities (tenant_id,principal_id,capability_id)
           VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`
        : `DELETE FROM membership_capabilities
           WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
      [fixture.tenantId, fixture.adminPrincipalId, request.body.capabilityId],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return await reply.code(500).send({ status: "failed" });
  } finally {
    client.release();
  }
  return { status: "updated" };
});

server.post(
  "/__esbla-test-control/presentation-surface-personalization",
  async (request, reply) => {
    if (!testControlAuthorized(request)) return await reply.code(404).send({ status: "not_found" });
    if (!hasExactKeys(request.body, ["enabled"]) || typeof request.body.enabled !== "boolean") {
      return await reply.code(400).send({ status: "invalid" });
    }
    const client = await migrationReadPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE presentation_surface_settings NO FORCE ROW LEVEL SECURITY");
      await client.query(
        `INSERT INTO presentation_surface_settings
         (tenant_id,surface_id,personalization_enabled,version,updated_by_principal_id)
       VALUES ($1,'surface.mission-control',$2,1,$3)
       ON CONFLICT (tenant_id,surface_id)
       DO UPDATE SET personalization_enabled=EXCLUDED.personalization_enabled,
                     version=presentation_surface_settings.version+1,
                     updated_at=now(),
                     updated_by_principal_id=EXCLUDED.updated_by_principal_id`,
        [fixture.tenantId, request.body.enabled, fixture.employeePrincipalId],
      );
      await client.query("ALTER TABLE presentation_surface_settings FORCE ROW LEVEL SECURITY");
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return await reply.code(500).send({ status: "failed" });
    } finally {
      client.release();
    }
    return { status: "updated" };
  },
);

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
    const personas = [
      {
        label: fixture.employeeLabel,
        origin: fixture.employeeOrigin,
        persona: "employee",
        principalId: fixture.employeePrincipalId,
        projectRoot: nextRuntimeRoot.projects.employee,
      },
      {
        label: fixture.employmentEmployeeLabel,
        origin: fixture.employmentEmployeeOrigin,
        persona: "employmentEmployee",
        principalId: fixture.employmentEmployeePrincipalId,
        projectRoot: nextRuntimeRoot.projects.employmentEmployee,
      },
      {
        label: fixture.employmentActionOperatorLabel,
        origin: fixture.employmentActionOperatorOrigin,
        persona: "employmentActionOperator",
        principalId: fixture.employmentActionOperatorPrincipalId,
        projectRoot: nextRuntimeRoot.projects.employmentActionOperator,
      },
      {
        label: fixture.employmentActionAdminLabel,
        origin: fixture.employmentActionAdminOrigin,
        pathname: "/workspace/hr/employment/settings",
        persona: "employmentActionAdmin",
        principalId: fixture.employmentActionAdminPrincipalId,
        projectRoot: nextRuntimeRoot.projects.employmentActionAdmin,
        tenantId: fixture.employmentActionAdminTenantId,
      },
      {
        label: fixture.employmentViewAdminLabel,
        origin: fixture.employmentViewAdminOrigin,
        persona: "employmentViewAdmin",
        principalId: fixture.employmentViewAdminPrincipalId,
        projectRoot: nextRuntimeRoot.projects.employmentViewAdmin,
      },
      {
        label: fixture.employmentListOperatorLabel,
        origin: fixture.employmentListOperatorOrigin,
        persona: "employmentListOperator",
        principalId: fixture.employmentListOperatorPrincipalId,
        projectRoot: nextRuntimeRoot.projects.employmentListOperator,
      },
      {
        label: fixture.managerLabel,
        origin: fixture.managerOrigin,
        persona: "manager",
        principalId: fixture.managerPrincipalId,
        projectRoot: nextRuntimeRoot.projects.manager,
      },
      {
        label: fixture.operatorLabel,
        origin: fixture.operatorOrigin,
        persona: "operator",
        principalId: fixture.operatorPrincipalId,
        projectRoot: nextRuntimeRoot.projects.operator,
      },
      {
        label: fixture.adminLabel,
        origin: fixture.adminOrigin,
        persona: "admin",
        principalId: fixture.adminPrincipalId,
        projectRoot: nextRuntimeRoot.projects.admin,
      },
    ];
    for (const persona of personas) {
      if (closing) throw new Error("Browser stack closing during Web startup");
      const origin = new URL(persona.origin);
      const web = startWebPersona(
        persona.persona,
        origin,
        persona.principalId,
        persona.label,
        persona.projectRoot,
        persona.tenantId ?? fixture.tenantId,
      );
      await requireActorReady(origin, persona.label, web, persona.pathname);
    }
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
            ESBLA_TEST_EMPLOYMENT_ACTION_WORKER_PROFILE_ID:
              seededFixture.employmentActionWorkerProfileId,
            ESBLA_TEST_SHIFT_EMPLOYEE_WORKER_PROFILE_ID: seededFixture.shiftEmployeeWorkerProfileId,
            ESBLA_TEST_CONTROL_ORIGIN: `http://127.0.0.1:${ports.api}`,
            ESBLA_TEST_CONTROL_TOKEN: testControlToken,
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
} catch (error) {
  console.error(
    `BROWSER_STACK_FAILURE:${error instanceof Error ? error.message : "unknown harness error"}`,
  );
  process.exitCode = 1;
  await close();
  throw new Error("Browser stack failed");
}
