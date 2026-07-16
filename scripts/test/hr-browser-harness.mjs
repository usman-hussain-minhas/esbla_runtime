import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const redacted = "[REDACTED]";
const processStopTimeoutMs = 2_000;
const readinessTimeoutMs = 45_000;
const cleanupStepTimeoutMs = 5_000;
const exactShaPattern = /^[0-9a-f]{40}$/;
const artifactLeafPattern = /^esbla-(?:browser-artifacts|hr-browser-evidence)(?:-[a-z0-9._-]+)?$/i;
const browserControlEnvironmentKeys = Object.freeze([
  "ESBLA_BROWSER_CONTROL_NONCE",
  "ESBLA_BROWSER_CONTROL_ROOT",
  "ESBLA_BROWSER_LAUNCHER",
  "ESBLA_BROWSER_OWNERSHIP_TOKEN",
  "ESBLA_BROWSER_PROFILE_ROOT",
  "ESBLA_BROWSER_SUPERVISOR_PID",
]);
const runtimeSensitiveValues = new Set();
const managedChildCloseReceipts = new WeakMap();

const fixture = Object.freeze({
  adminPrincipalId: "10000000-0000-4000-8000-000000000101",
  categoryCode: "annual",
  correlationActivateHr: "50000000-0000-4000-8000-000000000101",
  correlationActivateWorkspace: "50000000-0000-4000-8000-000000000102",
  correlationSubmit: "50000000-0000-4000-8000-000000000103",
  employeeDisplayName: "Synthetic Employee A",
  employeeLabel: "Synthetic Employee A",
  employeeMembershipId: "20000000-0000-4000-8000-000000000103",
  employeePrincipalId: "10000000-0000-4000-8000-000000000103",
  endDate: "2026-08-18",
  leaveReason: "Synthetic browser harness leave",
  leaveRequestId: "30000000-0000-4000-8000-000000000101",
  managerDisplayName: "Synthetic Manager A",
  managerLabel: "Synthetic Manager A",
  managerMembershipId: "20000000-0000-4000-8000-000000000102",
  managerPrincipalId: "10000000-0000-4000-8000-000000000102",
  startDate: "2026-08-18",
  submitIdempotencyKey: "40000000-0000-4000-8000-000000000101",
  tenantId: "00000000-0000-4000-8000-000000000101",
  tenantAdminMembershipId: "20000000-0000-4000-8000-000000000101",
});

const lifecycle = Object.freeze([
  "build",
  "migrate",
  "seed",
  "api-ready",
  "employee-web-ready",
  "manager-web-ready",
  "chromium",
  "evidence",
]);

const teardown = Object.freeze([
  "chromium",
  "employee-web",
  "manager-web",
  "api",
  "database-pools",
  "postgresql",
  "temporary-state",
]);

export function lifecycleStages() {
  return [...lifecycle];
}

export function teardownStages() {
  return [...teardown];
}

export function assertSafeTrackedPaths(paths) {
  for (const candidate of paths) {
    const normalized = candidate.replaceAll("\\", "/");
    const segments = normalized.split("/");
    const unsafe =
      !normalized ||
      isAbsolute(candidate) ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      segments.some((segment) =>
        [".env", ".next", "coverage", "dist", "node_modules"].includes(segment),
      );
    if (unsafe) throw new Error(`${candidate} is not a safe Git-indexed path`);
  }
}

export function createProcessPlan() {
  return {
    api: { command: "built createServer", host: "127.0.0.1" },
    commands: ["pnpm run build", "next start", "playwright test"],
    employee: { host: "127.0.0.1", label: fixture.employeeLabel },
    manager: { host: "127.0.0.1", label: fixture.managerLabel },
  };
}

export function assertSourceQualification({ expectedSourceSha, head, status }) {
  if (expectedSourceSha !== undefined && expectedSourceSha !== null && expectedSourceSha !== "") {
    if (!exactShaPattern.test(expectedSourceSha)) {
      throw new Error("ESBLA_EXPECTED_SOURCE_SHA must be an exact lowercase 40-character SHA");
    }
    if (expectedSourceSha !== head) {
      throw new Error(
        `Checked-out source ${head} does not match expected source ${expectedSourceSha}`,
      );
    }
    if (status.length > 0) {
      throw new Error("Exact-source browser evidence requires a clean index and worktree");
    }
    return { exactSourceQualified: true };
  }
  return { exactSourceQualified: false };
}

export async function createArtifactDirectory(configuredArtifactDirectory) {
  if (!configuredArtifactDirectory) {
    return await mkdtemp(join(tmpdir(), "esbla-hr-browser-evidence-"));
  }
  if (!isAbsolute(configuredArtifactDirectory)) {
    throw new Error("ESBLA_E2E_ARTIFACT_DIR must be an absolute path");
  }
  const requestedArtifactDirectory = resolve(configuredArtifactDirectory);
  if (!artifactLeafPattern.test(basename(requestedArtifactDirectory))) {
    throw new Error("Browser artifact directory must be a dedicated esbla browser-evidence leaf");
  }
  const canonicalParent = await realpath(dirname(requestedArtifactDirectory));
  const artifactDirectory = join(canonicalParent, basename(requestedArtifactDirectory));
  const artifactRelative = relative(repositoryRoot, artifactDirectory);
  if (!artifactRelative.startsWith("..") && !isAbsolute(artifactRelative)) {
    throw new Error("Browser artifacts must be written outside the repository");
  }
  try {
    await mkdir(artifactDirectory, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("ESBLA_E2E_ARTIFACT_DIR must not already exist");
    }
    throw error;
  }
  return artifactDirectory;
}

export function isExactActorRequest(value, method, actorOrigin) {
  try {
    const url = new URL(value);
    return (
      ["GET", "HEAD"].includes(method) &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin === actorOrigin
    );
  } catch {
    return false;
  }
}

export async function runCleanupSteps(steps) {
  const errors = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push(
        new Error(`${step.name}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        }),
      );
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Browser harness cleanup failed");
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/authorization|secret|signature/i.test(key)) {
      output[key] = redacted;
    } else {
      output[key] = sanitizeValue(entry);
    }
  }
  return output;
}

export function sanitizeEvidence(value) {
  const output = sanitizeValue(value);
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  for (const flag of [
    "accessibilityConformance",
    "backupRestore",
    "crossTenant",
    "fullJourney",
    "performanceQualification",
    "productionAuthentication",
    "restart",
    "visualAcceptance",
  ]) {
    if (Object.hasOwn(output, flag)) output[flag] = false;
  }
  return output;
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

async function worktreeFingerprint() {
  const listed = runSync("git", ["ls-files", "-co", "--exclude-standard", "-z"]);
  const paths = listed.split("\0").filter(Boolean).sort();
  assertSafeTrackedPaths(paths);
  const hash = createHash("sha256");
  for (const path of paths) {
    const absolutePath = join(repositoryRoot, path);
    const metadata = await lstat(absolutePath);
    hash.update(path);
    hash.update("\0");
    if (metadata.isSymbolicLink()) {
      hash.update(`symlink:${await readlink(absolutePath)}`);
    } else if (metadata.isFile()) {
      hash.update(await readFile(absolutePath));
    }
    hash.update("\0");
  }
  hash.update(runSync("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  return hash.digest("hex");
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolveExit) => {
    let timer;
    const settle = (exited) => {
      if (timer) clearTimeout(timer);
      child.off("exit", handleExit);
      resolveExit(exited);
    };
    const handleExit = () => settle(true);
    child.once("exit", handleExit);
    timer = setTimeout(() => settle(false), timeoutMs);
  });
}

export async function stopChild(child, timeoutMs = processStopTimeoutMs) {
  if (!child) return;
  const receipt = managedChildCloseReceipt(child);
  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, "SIGTERM");
    if (!(await waitForExit(child, timeoutMs))) {
      signalChild(child, "SIGKILL");
      if (!(await waitForExit(child, timeoutMs))) {
        throw new Error(`Child process ${child.pid ?? "unknown"} survived SIGKILL`);
      }
    }
  }
  await withTimeout("child close", async () => await receipt.promise, timeoutMs);
  if (!receipt.closed) throw new Error("Child close was not observed");
}

function normalizedSecrets(value) {
  const values = Array.isArray(value) ? value : [value];
  const secrets = [
    ...new Set(values.filter((entry) => typeof entry === "string" && entry.length)),
  ].sort((left, right) => right.length - left.length);
  if (secrets.length === 0) throw new Error("At least one nonempty redaction secret is required");
  return secrets;
}

export function redactSensitiveText(value, secrets = [...runtimeSensitiveValues]) {
  let output = String(value);
  if (!Array.isArray(secrets) || secrets.length === 0) return output;
  for (const secret of normalizedSecrets(secrets)) output = output.replaceAll(secret, redacted);
  return output;
}

export function createStreamingRedactor(secret, emit) {
  const secrets = normalizedSecrets(secret);
  let pending = "";
  const flushSafeContent = () => {
    while (pending) {
      let match;
      for (const candidate of secrets) {
        const index = pending.indexOf(candidate);
        if (
          index >= 0 &&
          (!match ||
            index < match.index ||
            (index === match.index && candidate.length > match.secret.length))
        ) {
          match = { index, secret: candidate };
        }
      }
      if (match) {
        const output = `${pending.slice(0, match.index)}${redacted}`;
        pending = pending.slice(match.index + match.secret.length);
        if (output) emit(output);
        continue;
      }
      let retainedCharacters = 0;
      for (const candidate of secrets) {
        const candidateLength = Math.min(candidate.length - 1, pending.length);
        for (let length = candidateLength; length > retainedCharacters; length -= 1) {
          if (candidate.startsWith(pending.slice(pending.length - length))) {
            retainedCharacters = length;
            break;
          }
        }
      }
      const safeLength = pending.length - retainedCharacters;
      if (safeLength > 0) emit(pending.slice(0, safeLength));
      pending = pending.slice(safeLength);
      break;
    }
  };
  return {
    end() {
      if (pending) emit(redactSensitiveText(pending, secrets));
      pending = "";
    },
    write(value) {
      pending += String(value);
      flushSafeContent();
    },
  };
}

function collectOutput(child, label, secret) {
  const chunks = [];
  const completions = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const redactor = createStreamingRedactor(secret, (output) => {
      chunks.push(output);
      process.stdout.write(`[${label}] ${output}`);
    });
    stream.on("data", (chunk) => redactor.write(chunk));
    completions.push(
      new Promise((resolveCompletion) => {
        stream.once("close", () => {
          redactor.end();
          resolveCompletion();
        });
      }),
    );
  }
  return { chunks, done: Promise.all(completions) };
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a loopback browser-harness port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolutePath)));
    else if (entry.isFile()) files.push(relative(root, absolutePath).split(sep).join("/"));
    else throw new Error(`Browser artifact ${absolutePath} is not a regular file or directory`);
  }
  return files;
}

function replaceBufferValue(bytes, secret) {
  const needle = Buffer.from(secret);
  if (needle.length === 0 || bytes.indexOf(needle) < 0) return bytes;
  const replacement = Buffer.from(redacted);
  const parts = [];
  let offset = 0;
  let index = bytes.indexOf(needle, offset);
  while (index >= 0) {
    parts.push(bytes.subarray(offset, index), replacement);
    offset = index + needle.length;
    index = bytes.indexOf(needle, offset);
  }
  parts.push(bytes.subarray(offset));
  return Buffer.concat(parts);
}

export async function scrubAndAssertArtifactSecrets(artifactDirectory, sensitiveValues) {
  const secrets = normalizedSecrets(sensitiveValues);
  const files = await listFiles(artifactDirectory);
  for (const path of files) {
    if (secrets.some((secret) => path.includes(secret))) {
      throw new Error("Browser artifact filename contains a sensitive value");
    }
    const absolutePath = join(artifactDirectory, path);
    let bytes = await readFile(absolutePath);
    for (const secret of secrets) bytes = replaceBufferValue(bytes, secret);
    await writeFile(absolutePath, bytes, { mode: 0o600 });
  }
  await assertArtifactSecretsAbsent(artifactDirectory, secrets);
}

async function assertArtifactSecretsAbsent(artifactDirectory, sensitiveValues) {
  const secrets = normalizedSecrets(sensitiveValues);
  for (const path of await listFiles(artifactDirectory)) {
    if (secrets.some((secret) => path.includes(secret))) {
      throw new Error("Browser artifact filename contains a sensitive value");
    }
    const bytes = await readFile(join(artifactDirectory, path));
    for (const secret of secrets) {
      if (bytes.indexOf(Buffer.from(secret)) >= 0) {
        throw new Error("Browser artifact content contains a sensitive value after scrubbing");
      }
    }
  }
}

async function writeArtifactManifest(artifactDirectory) {
  const manifestName = "artifact-manifest.json";
  const files = (await listFiles(artifactDirectory)).filter((path) => path !== manifestName);
  const entries = [];
  for (const path of files) {
    const bytes = await readFile(join(artifactDirectory, path));
    entries.push({
      bytes: bytes.length,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeJson(join(artifactDirectory, manifestName), {
    entries,
    entryCount: entries.length,
    hiddenFilesExcluded: false,
    manifestSelfHashExcluded: true,
  });
}

async function waitForHttp200(url, child, logs, signalState) {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastStatus;
  let lastError;
  while (Date.now() < deadline) {
    throwIfInterrupted(signalState);
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      await logs.done;
      throw new Error(
        `Process exited before ${url} became ready\n${logs.chunks.slice(-20).join("")}`,
      );
    }
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5_000) });
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `${url} did not return HTTP 200 within ${readinessTimeoutMs}ms (last status ${lastStatus ?? "none"}; ${lastError?.message ?? "no transport error"})`,
  );
}

async function signedApiProbe({ apiOrigin, path, principalId, secret }) {
  const contractsModule = await import(
    pathToFileURL(join(repositoryRoot, "packages/contracts/dist/development-principal.js")).href
  );
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = contractsModule.signDevelopmentPrincipal(secret, {
    method: "GET",
    principalId,
    requestId,
    tenantId: fixture.tenantId,
    timestamp,
    url: path,
  });
  const response = await fetch(new URL(path, apiOrigin), {
    headers: {
      accept: "application/json",
      "x-esbla-auth-signature": signature,
      "x-esbla-auth-timestamp": timestamp,
      "x-esbla-principal-id": principalId,
      "x-esbla-request-id": requestId,
      "x-esbla-tenant-id": fixture.tenantId,
    },
  });
  const body = await response.text();
  if (response.status !== 200) {
    throw new Error(`Signed loopback API probe ${path} returned ${response.status}: ${body}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Signed loopback API probe ${path} did not return JSON`);
  }
}

async function seedTenantRow(client, tenantId, query, values) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(query, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function prepareDatabase() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  const applicationUrl = process.env.DATABASE_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!migrationUrl || !applicationUrl || !applicationRole) {
    throw new Error("The ephemeral PostgreSQL harness environment is required");
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("The PostgreSQL application role is not a safe identifier");
  }

  const dbModule = await import(
    pathToFileURL(join(repositoryRoot, "packages/db/dist/index.js")).href
  );
  const platformModule = await import(
    pathToFileURL(join(repositoryRoot, "modules/platform-core/dist/index.js")).href
  );
  const hrModule = await import(
    pathToFileURL(join(repositoryRoot, "modules/hr/dist/index.js")).href
  );
  const workspaceModule = await import(
    pathToFileURL(join(repositoryRoot, "modules/workspace/dist/index.js")).href
  );

  const migrationPool = dbModule.createDatabasePool(migrationUrl, {
    allowExitOnIdle: true,
    max: 2,
  });
  let applicationPool;
  try {
    await dbModule.migrateDatabase(dbModule.createDatabase(migrationPool));
    await migrationPool.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
    await migrationPool.query(`GRANT SELECT, INSERT ON tenants, principals TO ${applicationRole}`);
    await migrationPool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE
       ON memberships, service_activations, tenant_settings, work_items,
          outbox_events, hr_leave_requests, workspace_tasks
       TO ${applicationRole}`,
    );
    await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);
    const serverVersion = (await migrationPool.query("SHOW server_version")).rows[0]
      ?.server_version;

    applicationPool = dbModule.createDatabasePool(applicationUrl, {
      allowExitOnIdle: true,
      max: 12,
    });
    await applicationPool.query(
      "INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Synthetic Browser Tenant')",
      [fixture.tenantId],
    );
    await applicationPool.query(
      `INSERT INTO principals (principal_id, display_name)
       VALUES ($1, 'Synthetic Tenant Admin'), ($2, $3), ($4, $5)`,
      [
        fixture.adminPrincipalId,
        fixture.managerPrincipalId,
        fixture.managerDisplayName,
        fixture.employeePrincipalId,
        fixture.employeeDisplayName,
      ],
    );
    const client = await applicationPool.connect();
    try {
      await seedTenantRow(
        client,
        fixture.tenantId,
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ($1, $2, $3, 'tenant_admin', NULL),
                ($4, $2, $5, 'manager', NULL),
                ($6, $2, $7, 'employee', $5)`,
        [
          fixture.tenantAdminMembershipId,
          fixture.tenantId,
          fixture.adminPrincipalId,
          fixture.managerMembershipId,
          fixture.managerPrincipalId,
          fixture.employeeMembershipId,
          fixture.employeePrincipalId,
        ],
      );
    } finally {
      client.release();
    }

    const context = (actorPrincipalId, correlationId) => ({
      actorPrincipalId,
      correlationId,
      tenantId: fixture.tenantId,
    });
    const activateService = async ({
      actionKey,
      correlationId,
      evidenceEventType,
      outboxEventType,
      policyId,
      serviceKey,
    }) => {
      await platformModule.withTenantTransaction(
        applicationPool,
        context(fixture.adminPrincipalId, correlationId),
        async (transaction) => {
          const authorization = platformModule.evaluatePolicy(
            { actionKey, input: { serviceKey }, resourceKey: serviceKey, transaction },
            [
              {
                effect: "allow",
                id: policyId,
                matches: (_input, actor) => actor.roleKey === "tenant_admin",
              },
            ],
          );
          await platformModule.setServiceActivation(transaction, {
            authorization,
            evidenceEventType,
            expectedVersion: null,
            outboxEventType,
            preflight: async () => ({ current: true, reasons: [] }),
            serviceKey,
            targetState: "active",
          });
        },
      );
    };

    await activateService({
      actionKey: "platform.service_activation.activate",
      correlationId: fixture.correlationActivateHr,
      evidenceEventType: "evidence.hr.leave_service.activated",
      outboxEventType: "hr.leave_service.activated",
      policyId: "browser_tenant_admin_activate_hr",
      serviceKey: hrModule.HR_LEAVE_SERVICE_KEY,
    });
    await activateService({
      actionKey: "platform.service_activation.activate",
      correlationId: fixture.correlationActivateWorkspace,
      evidenceEventType: "evidence.workspace.task_service.activated",
      outboxEventType: "workspace.task_service.activated",
      policyId: "browser_tenant_admin_activate_workspace",
      serviceKey: workspaceModule.WORKSPACE_TASK_SERVICE_KEY,
    });

    await hrModule.submitLeaveRequest(
      applicationPool,
      context(fixture.employeePrincipalId, fixture.correlationSubmit),
      {
        categoryCode: fixture.categoryCode,
        endDate: fixture.endDate,
        idempotencyKey: fixture.submitIdempotencyKey,
        leaveRequestId: fixture.leaveRequestId,
        reason: fixture.leaveReason,
        startDate: fixture.startDate,
      },
    );
    return { applicationPool, serverVersion };
  } catch (error) {
    if (applicationPool) await applicationPool.end();
    throw error;
  } finally {
    await migrationPool.end();
  }
}

async function prepareWebCopy(root, name) {
  const destination = join(root, name);
  await mkdir(destination, { recursive: true });
  await cp(join(repositoryRoot, "apps/web/.next"), join(destination, ".next"), {
    recursive: true,
  });
  await copyFile(join(repositoryRoot, "apps/web/package.json"), join(destination, "package.json"));
  await copyFile(
    join(repositoryRoot, "apps/web/next.config.ts"),
    join(destination, "next.config.ts"),
  );
  await symlink(join(repositoryRoot, "apps/web/node_modules"), join(destination, "node_modules"));
  return destination;
}

function managedChildCloseReceipt(child) {
  const existing = managedChildCloseReceipts.get(child);
  if (existing) return existing;
  let resolveClose;
  const receipt = { closed: false, promise: undefined };
  receipt.promise = new Promise((resolveReceipt) => {
    resolveClose = resolveReceipt;
  });
  child.once("close", () => {
    receipt.closed = true;
    resolveClose();
  });
  managedChildCloseReceipts.set(child, receipt);
  return receipt;
}

function registerManagedChild(child, signalState) {
  managedChildCloseReceipt(child);
  signalState.children.add(child);
  return child;
}

function throwIfInterrupted(signalState) {
  if (signalState.signal) throw new Error(`Harness interrupted by ${signalState.signal}`);
}

function startNext({ apiOrigin, directory, label, port, principalId, secret, signalState }) {
  throwIfInterrupted(signalState);
  const nextBinary = join(repositoryRoot, "apps/web/node_modules/next/dist/bin/next");
  const child = registerManagedChild(
    spawn(
      process.execPath,
      [nextBinary, "start", directory, "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: repositoryRoot,
        detached: false,
        env: {
          ...process.env,
          ESBLA_API_BASE_URL: apiOrigin,
          ESBLA_DEV_AUTH_SECRET: secret,
          ESBLA_DEV_PRINCIPAL_ID: principalId,
          ESBLA_DEV_SESSION_LABEL: label,
          ESBLA_DEV_TENANT_ID: fixture.tenantId,
          NEXT_TELEMETRY_DISABLED: "1",
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
    signalState,
  );
  return { child, logs: collectOutput(child, basename(directory), secret) };
}

async function runCommand(command, args, { env = process.env, label, secret, signalState }) {
  throwIfInterrupted(signalState);
  const child = registerManagedChild(
    spawn(command, args, {
      cwd: repositoryRoot,
      detached: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    signalState,
  );
  signalState.activeChild = child;
  const logs = collectOutput(child, label, secret);
  try {
    let commandError;
    let result;
    try {
      result = await new Promise((resolveResult, reject) => {
        let settled = false;
        const settle = (callback) => {
          if (settled) return;
          settled = true;
          callback();
        };
        child.once("error", (error) => settle(() => reject(error)));
        child.once("exit", (code, signal) => settle(() => resolveResult({ code, signal })));
      });
    } catch (error) {
      commandError = error;
    }
    let outputError;
    try {
      await withTimeout(`${label} output drain`, async () => await logs.done, 2_000);
    } catch (error) {
      outputError = error;
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    if (commandError && outputError) throw new AggregateError([commandError, outputError]);
    if (commandError) throw commandError;
    if (outputError) throw outputError;
    return { ...result, child, logs };
  } finally {
    if (signalState.activeChild === child) signalState.activeChild = undefined;
  }
}

export async function withTimeout(label, operation, timeoutMs = cleanupStepTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readProcessGroupMembers(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error("Process-group membership subject is invalid");
  }
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.error || result.status !== 0 || !Number.isSafeInteger(result.pid) || result.pid <= 0) {
    throw new Error("Process-group membership scan failed");
  }
  const lines = result.stdout.trim() ? result.stdout.trim().split("\n") : [];
  const members = lines.map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("Process-group membership scan was ambiguous");
    const pid = Number(match[1]);
    const observedPgid = Number(match[2]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(observedPgid) ||
      observedPgid <= 0
    ) {
      throw new Error("Process-group membership scan contained invalid identities");
    }
    return { pgid: observedPgid, pid };
  });
  return members.filter((member) => member.pgid === pgid && member.pid !== result.pid);
}

async function stopManagedChildren(signalState) {
  const children = [...signalState.children];
  const results = await Promise.allSettled(children.map((child) => stopChild(child)));
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, "One or more child processes survived");
  if (!children.every((child) => managedChildCloseReceipt(child).closed)) {
    throw new Error("Managed child close proof is incomplete");
  }
  const members = readProcessGroupMembers(process.pid);
  if (!members.some((member) => member.pid === process.pid)) {
    throw new Error("Harness process-group leadership is unproved");
  }
  if (members.some((member) => member.pid !== process.pid)) {
    throw new Error("Managed child process-group absence is unproved");
  }
  for (const child of children) signalState.children.delete(child);
  return true;
}

async function captureTemporaryRoot(path) {
  const canonicalPath = await realpath(path);
  const metadata = await lstat(canonicalPath, { bigint: true });
  if (
    canonicalPath !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    Number(metadata.uid) !== process.getuid() ||
    Number(metadata.mode & 0o777n) !== 0o700
  ) {
    throw new Error("Temporary root ownership is invalid");
  }
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    path: canonicalPath,
    uid: Number(metadata.uid),
  });
}

async function assertTemporaryRootOwned(path, owned) {
  const canonicalPath = await realpath(path);
  const metadata = await lstat(path, { bigint: true });
  if (
    !owned ||
    canonicalPath !== path ||
    owned.path !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    Number(metadata.uid) !== process.getuid() ||
    Number(metadata.uid) !== owned.uid ||
    Number(metadata.mode & 0o777n) !== 0o700 ||
    String(metadata.dev) !== owned.dev ||
    String(metadata.ino) !== owned.ino
  ) {
    throw new Error("Temporary root identity changed");
  }
  return true;
}

function appendFailure(failure, error) {
  if (!failure) return error;
  return new AggregateError([failure, error], "Browser harness execution and cleanup failed");
}

export function assertLoopbackBrowserEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("BrowserServer returned an invalid endpoint");
  }
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    Number(endpoint.port) < 1 ||
    Number(endpoint.port) > 65_535 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^\/[0-9a-f]{32}$/.test(endpoint.pathname)
  ) {
    throw new Error("BrowserServer endpoint must be an exact tokenized IPv4 loopback WebSocket");
  }
  return endpoint.href;
}

export async function withTemporaryEnvironment(overrides, operation) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function captureBrowserControl() {
  const values = Object.fromEntries(
    browserControlEnvironmentKeys.map((key) => [key, process.env[key]?.trim()]),
  );
  for (const key of browserControlEnvironmentKeys) delete process.env[key];
  const root = values.ESBLA_BROWSER_CONTROL_ROOT;
  const launcherPath = values.ESBLA_BROWSER_LAUNCHER;
  const ownershipPath = values.ESBLA_BROWSER_OWNERSHIP_TOKEN;
  const profileRoot = values.ESBLA_BROWSER_PROFILE_ROOT;
  const nonce = values.ESBLA_BROWSER_CONTROL_NONCE;
  const supervisorPid = values.ESBLA_BROWSER_SUPERVISOR_PID;
  if (
    !root ||
    !launcherPath ||
    !ownershipPath ||
    !profileRoot ||
    !nonce ||
    !supervisorPid ||
    !isAbsolute(root) ||
    !isAbsolute(launcherPath) ||
    !isAbsolute(ownershipPath) ||
    !isAbsolute(profileRoot) ||
    !/^[0-9a-f]{64}$/.test(nonce) ||
    !/^[1-9][0-9]*$/.test(supervisorPid) ||
    Number(supervisorPid) !== process.ppid ||
    dirname(launcherPath) !== root ||
    dirname(ownershipPath) !== root ||
    ownershipPath === launcherPath ||
    profileRoot === root
  ) {
    throw new Error("The exact outer browser-supervision environment is required");
  }
  const control = {
    launcherPath,
    nonce,
    ownershipPath,
    profileRoot,
    root,
    supervisorPid,
  };
  for (const value of [
    nonce,
    root,
    launcherPath,
    ownershipPath,
    profileRoot,
    join(root, "browser.registration"),
    join(root, "browser.ack"),
    join(root, "browser.intent"),
    join(root, "browser.cancelled"),
    join(root, "harness.retained"),
  ]) {
    runtimeSensitiveValues.add(value);
  }
  const [canonicalRoot, canonicalLauncher, canonicalOwnership, canonicalProfileRoot] =
    await Promise.all([
      realpath(root),
      realpath(launcherPath),
      realpath(ownershipPath),
      realpath(profileRoot),
    ]);
  if (
    canonicalRoot !== root ||
    canonicalLauncher !== launcherPath ||
    canonicalOwnership !== ownershipPath ||
    canonicalProfileRoot !== profileRoot
  ) {
    throw new Error("Browser supervision paths must be canonical");
  }
  const [rootMetadata, launcherMetadata, ownershipMetadata, profileMetadata] = await Promise.all([
    lstat(root),
    lstat(launcherPath),
    lstat(ownershipPath),
    lstat(profileRoot),
  ]);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== process.getuid() ||
    (rootMetadata.mode & 0o777) !== 0o700 ||
    !launcherMetadata.isFile() ||
    launcherMetadata.isSymbolicLink() ||
    launcherMetadata.uid !== process.getuid() ||
    (launcherMetadata.mode & 0o777) !== 0o700 ||
    !ownershipMetadata.isFile() ||
    ownershipMetadata.isSymbolicLink() ||
    ownershipMetadata.uid !== process.getuid() ||
    (ownershipMetadata.mode & 0o777) !== 0o600 ||
    ownershipMetadata.nlink !== 1 ||
    !profileMetadata.isDirectory() ||
    profileMetadata.isSymbolicLink() ||
    profileMetadata.uid !== process.getuid() ||
    (profileMetadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("Browser supervision paths have invalid type or permissions");
  }
  return control;
}

function parseControlRecord(contents) {
  const fields = new Map();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Browser control record is malformed");
    const key = line.slice(0, separator);
    if (fields.has(key)) throw new Error("Browser control record duplicates a field");
    fields.set(key, line.slice(separator + 1));
  }
  return fields;
}

async function acknowledgedBrowserPid(control) {
  const [ack, registration] = await Promise.all([
    readFile(join(control.root, "browser.ack"), "utf8"),
    readFile(join(control.root, "browser.registration"), "utf8"),
  ]);
  const ackFields = parseControlRecord(ack);
  const registrationFields = parseControlRecord(registration);
  if (
    ackFields.size !== 2 ||
    ackFields.get("nonce") !== control.nonce ||
    registrationFields.get("nonce") !== control.nonce ||
    ackFields.get("pid") !== registrationFields.get("pid") ||
    !/^[1-9][0-9]*$/.test(ackFields.get("pid") ?? "")
  ) {
    throw new Error("Browser ACK does not bind the exact registered process");
  }
  return Number(ackFields.get("pid"));
}

async function publishBrowserLaunchIntent(control) {
  const intentPath = join(control.root, "browser.intent");
  const temporaryPath = join(
    control.root,
    `.intent.${process.pid}.${randomBytes(8).toString("hex")}`,
  );
  await writeFile(temporaryPath, `nonce=${control.nonce}\npid=${process.pid}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporaryPath, intentPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function launchOwnedBrowser(control) {
  const playwrightRequire = createRequire(
    join(repositoryRoot, "scripts/test/browser-tooling/package.json"),
  );
  const { chromium } = playwrightRequire("@playwright/test");
  const realExecutable = await realpath(chromium.executablePath());
  runtimeSensitiveValues.add(realExecutable);
  const launchEnvironment = {
    ESBLA_BROWSER_CONTROL_NONCE: control.nonce,
    ESBLA_BROWSER_CONTROL_ROOT: control.root,
    ESBLA_BROWSER_LAUNCHER: control.launcherPath,
    ESBLA_BROWSER_OWNERSHIP_TOKEN: control.ownershipPath,
    ESBLA_BROWSER_PROFILE_ROOT: control.profileRoot,
    ESBLA_BROWSER_REAL_EXECUTABLE: realExecutable,
    ESBLA_BROWSER_SUPERVISOR_PID: control.supervisorPid,
    TMPDIR: control.profileRoot,
  };
  await publishBrowserLaunchIntent(control);
  const browserServer = await withTemporaryEnvironment(
    launchEnvironment,
    async () =>
      await chromium.launchServer({
        executablePath: control.launcherPath,
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        headless: true,
        host: "127.0.0.1",
        port: 0,
      }),
  );
  const browserProcess = browserServer.process();
  if (!browserProcess?.pid || browserProcess.pid !== (await acknowledgedBrowserPid(control))) {
    await browserServer.kill().catch(() => {});
    throw new Error("BrowserServer PID does not equal the outer acknowledged browser PID");
  }
  const endpoint = assertLoopbackBrowserEndpoint(browserServer.wsEndpoint());
  runtimeSensitiveValues.add(endpoint);
  runtimeSensitiveValues.add(new URL(endpoint).pathname.slice(1));
  return { browserServer, endpoint, realExecutable };
}

async function stopBrowserServer(browserServer) {
  if (!browserServer) return;
  try {
    await withTimeout("BrowserServer close", async () => await browserServer.close());
  } catch (closeError) {
    try {
      await withTimeout("BrowserServer kill", async () => await browserServer.kill());
    } catch (killError) {
      throw new AggregateError([closeError, killError], "BrowserServer close and kill failed");
    }
  }
}

async function runHarness() {
  if (process.version.split(".")[0] !== "v24") {
    throw new Error(`Node 24 is required; observed ${process.version}`);
  }

  const signalState = { activeChild: undefined, children: new Set(), signal: undefined };
  const handleSignal = (signal) => {
    if (signalState.signal) return;
    signalState.signal = signal;
    for (const child of signalState.children) signalChild(child, signal);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  const secret = randomBytes(48).toString("base64url");
  runtimeSensitiveValues.add(secret);
  const browserControl = await captureBrowserControl();
  let artifactDirectory;
  let apiServer;
  let applicationPool;
  let browserServer;
  let browserResult = { code: null, signal: null };
  let exactSourceQualified = false;
  let failure;
  let head;
  let initialFingerprint;
  let initialStatus = "UNABLE_TO_VERIFY";
  let managedChildrenClosed = false;
  let serverVersion;
  let temporaryRoot;
  let temporaryRootOwned;
  let tree;
  const expectedSourceSha = process.env.ESBLA_EXPECTED_SOURCE_SHA?.trim() || undefined;

  try {
    head = runSync("git", ["rev-parse", "HEAD"]);
    tree = runSync("git", ["rev-parse", "HEAD^{tree}"]);
    initialStatus = runSync("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    exactSourceQualified = assertSourceQualification({
      expectedSourceSha,
      head,
      status: initialStatus,
    }).exactSourceQualified;
    initialFingerprint = await worktreeFingerprint();
    artifactDirectory = await createArtifactDirectory(process.env.ESBLA_E2E_ARTIFACT_DIR?.trim());
    temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "esbla-hr-browser-")));
    temporaryRootOwned = await captureTemporaryRoot(temporaryRoot);

    const build = await runCommand("pnpm", ["run", "build"], {
      label: "build",
      secret,
      signalState,
    });
    if (build.code !== 0) throw new Error(`Build failed with ${build.code ?? build.signal}`);
    throwIfInterrupted(signalState);
    const postBuildFingerprint = await worktreeFingerprint();
    if (postBuildFingerprint !== initialFingerprint) {
      throw new Error("Build changed the authoritative tracked-worktree fingerprint");
    }

    const database = await prepareDatabase();
    applicationPool = database.applicationPool;
    serverVersion = database.serverVersion;
    throwIfInterrupted(signalState);

    const apiModule = await import(
      pathToFileURL(join(repositoryRoot, "apps/api/dist/server.js")).href
    );
    const authModule = await import(
      pathToFileURL(join(repositoryRoot, "apps/api/dist/auth.js")).href
    );
    apiServer = apiModule.createServer({
      authenticate: authModule.createDevelopmentAuthenticator({ secret }),
      logger: false,
      pool: applicationPool,
    });
    const apiOrigin = await apiServer.listen({ host: "127.0.0.1", port: 0 });
    await waitForHttp200(`${apiOrigin}/health`, undefined, [], signalState);
    const [ownPage, assignedPage] = await Promise.all([
      signedApiProbe({
        apiOrigin,
        path: "/v1/hr/leave-requests?pageSize=50",
        principalId: fixture.employeePrincipalId,
        secret,
      }),
      signedApiProbe({
        apiOrigin,
        path: "/v1/hr/leave-requests/assigned?pageSize=50",
        principalId: fixture.managerPrincipalId,
        secret,
      }),
    ]);
    const hrContractModule = await import(
      pathToFileURL(join(repositoryRoot, "packages/contracts/dist/hr-leave-api.js")).href
    );
    hrContractModule.parseHrLeaveRequestPage(ownPage);
    hrContractModule.parseHrAssignedLeaveRequestPage(assignedPage);
    for (const [actor, page] of [
      ["employee", ownPage],
      ["manager", assignedPage],
    ]) {
      if (
        !Array.isArray(page?.items) ||
        page.items.length !== 1 ||
        page.items[0]?.leaveRequestId !== fixture.leaveRequestId
      ) {
        throw new Error(`${actor} signed API probe did not return the deterministic request`);
      }
    }
    throwIfInterrupted(signalState);

    const [employeePort, managerPort] = await Promise.all([reservePort(), reservePort()]);
    const [employeeDirectory, managerDirectory] = await Promise.all([
      prepareWebCopy(temporaryRoot, "employee-web"),
      prepareWebCopy(temporaryRoot, "manager-web"),
    ]);
    throwIfInterrupted(signalState);
    const employeeWeb = startNext({
      apiOrigin,
      directory: employeeDirectory,
      label: fixture.employeeLabel,
      port: employeePort,
      principalId: fixture.employeePrincipalId,
      secret,
      signalState,
    });
    const managerWeb = startNext({
      apiOrigin,
      directory: managerDirectory,
      label: fixture.managerLabel,
      port: managerPort,
      principalId: fixture.managerPrincipalId,
      secret,
      signalState,
    });
    const employeeOrigin = `http://127.0.0.1:${employeePort}`;
    const managerOrigin = `http://127.0.0.1:${managerPort}`;
    await Promise.all([
      waitForHttp200(
        `${employeeOrigin}/workspace/hr/leave`,
        employeeWeb.child,
        employeeWeb.logs,
        signalState,
      ),
      waitForHttp200(
        `${managerOrigin}/workspace/my-work`,
        managerWeb.child,
        managerWeb.logs,
        signalState,
      ),
    ]);
    throwIfInterrupted(signalState);

    const ownedBrowser = await launchOwnedBrowser(browserControl);
    browserServer = ownedBrowser.browserServer;
    throwIfInterrupted(signalState);
    const browserEnvironment = {
      ...process.env,
      ESBLA_E2E_ARTIFACT_DIR: artifactDirectory,
      ESBLA_E2E_BROWSER_WS_ENDPOINT: ownedBrowser.endpoint,
      ESBLA_E2E_EMPLOYEE_DISPLAY_NAME: fixture.employeeDisplayName,
      ESBLA_E2E_EMPLOYEE_LABEL: fixture.employeeLabel,
      ESBLA_E2E_EMPLOYEE_ORIGIN: employeeOrigin,
      ESBLA_E2E_LEAVE_REASON: fixture.leaveReason,
      ESBLA_E2E_LEAVE_REQUEST_ID: fixture.leaveRequestId,
      ESBLA_E2E_MANAGER_LABEL: fixture.managerLabel,
      ESBLA_E2E_MANAGER_ORIGIN: managerOrigin,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    for (const key of [...browserControlEnvironmentKeys, "ESBLA_BROWSER_REAL_EXECUTABLE"]) {
      delete browserEnvironment[key];
    }
    const playwrightRequire = createRequire(
      join(repositoryRoot, "scripts/test/browser-tooling/package.json"),
    );
    const playwrightCli = playwrightRequire.resolve("@playwright/test/cli");
    const browser = await runCommand(
      process.execPath,
      [playwrightCli, "test", "--config", "playwright.config.mjs"],
      {
        env: browserEnvironment,
        label: "chromium",
        secret: [...runtimeSensitiveValues],
        signalState,
      },
    );
    browserResult = { code: browser.code, signal: browser.signal };
    throwIfInterrupted(signalState);
    if (browser.code !== 0) {
      throw new Error(`Chromium smoke failed with ${browser.code ?? browser.signal}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await runCleanupSteps([
        {
          name: "browser-server",
          run: async () => await stopBrowserServer(browserServer),
        },
        {
          name: "child-processes",
          run: async () => {
            const closed = await stopManagedChildren(signalState);
            if (closed !== true)
              throw new Error("Managed child cleanup did not produce an exact receipt");
            managedChildrenClosed = true;
          },
        },
        {
          name: "api",
          run: async () => {
            if (!apiServer) return;
            const closePromise = apiServer.close();
            try {
              await withTimeout("API close", async () => await closePromise);
            } catch (closeError) {
              apiServer.server?.closeAllConnections?.();
              try {
                await withTimeout("forced API close", async () => await closePromise, 2_000);
              } catch (forcedCloseError) {
                throw new AggregateError([closeError, forcedCloseError]);
              }
            }
          },
        },
        {
          name: "database-pools",
          run: async () => {
            if (applicationPool) {
              await withTimeout("database pool close", async () => await applicationPool.end());
            }
          },
        },
        {
          name: "temporary-state",
          run: async () => {
            if (!temporaryRoot) return;
            if (!managedChildrenClosed) throw new Error("Managed child cleanup is unproved");
            await assertTemporaryRootOwned(temporaryRoot, temporaryRootOwned);
            const members = readProcessGroupMembers(process.pid);
            if (
              !members.some((member) => member.pid === process.pid) ||
              members.some((member) => member.pid !== process.pid)
            ) {
              throw new Error("Harness process-group absence is unproved");
            }
            await assertTemporaryRootOwned(temporaryRoot, temporaryRootOwned);
            await rm(temporaryRoot, { force: false, recursive: true });
          },
        },
      ]);
    } catch (cleanupError) {
      failure = appendFailure(failure, cleanupError);
    }

    let finalFingerprint;
    if (initialFingerprint) {
      try {
        finalFingerprint = await worktreeFingerprint();
      } catch (fingerprintError) {
        failure = appendFailure(failure, fingerprintError);
      }
      if (finalFingerprint && finalFingerprint !== initialFingerprint) {
        failure = appendFailure(
          failure,
          new Error("Browser harness changed the authoritative tracked-worktree fingerprint"),
        );
      }
    }

    if (artifactDirectory) {
      try {
        const playwrightPackage = JSON.parse(
          await readFile(
            join(
              repositoryRoot,
              "scripts/test/browser-tooling/node_modules/@playwright/test/package.json",
            ),
            "utf8",
          ),
        );
        let chromiumVersion = "UNABLE_TO_VERIFY";
        try {
          const playwrightRequire = createRequire(
            join(repositoryRoot, "scripts/test/browser-tooling/package.json"),
          );
          const { chromium } = playwrightRequire("@playwright/test");
          const version = spawnSync(chromium.executablePath(), ["--version"], {
            encoding: "utf8",
          });
          if (version.status === 0 && version.stdout.trim())
            chromiumVersion = version.stdout.trim();
        } catch {
          chromiumVersion = "UNABLE_TO_VERIFY";
        }
        await writeJson(
          join(artifactDirectory, "harness-metadata.json"),
          sanitizeEvidence({
            accessibilityConformance: false,
            artifactRetentionDays: 7,
            backupRestore: false,
            browserResult,
            chromiumVersion,
            crossTenant: false,
            expectedSourceSha: expectedSourceSha ?? null,
            exactSourceQualified,
            fixture: {
              employeePrincipalId: fixture.employeePrincipalId,
              leaveRequestId: fixture.leaveRequestId,
              managerPrincipalId: fixture.managerPrincipalId,
              tenantId: fixture.tenantId,
            },
            fullJourney: false,
            git: {
              head: head ?? "UNABLE_TO_VERIFY",
              tree: tree ?? "UNABLE_TO_VERIFY",
              worktreeClean: initialStatus === "" && Boolean(initialFingerprint),
            },
            lifecycle: lifecycleStages(),
            nodeVersion: process.version,
            performanceQualification: false,
            playwrightVersion: playwrightPackage.version,
            pnpmVersion: runSync("pnpm", ["--version"]),
            postgresVersion: serverVersion ?? "UNABLE_TO_VERIFY",
            productionAuthentication: false,
            restart: false,
            signal: signalState.signal ?? null,
            teardown: teardownStages(),
            trackedFingerprintPreserved:
              Boolean(initialFingerprint) && finalFingerprint === initialFingerprint,
            visualAcceptance: false,
            worktreeFingerprint: initialFingerprint ?? "UNABLE_TO_VERIFY",
          }),
        );
        await scrubAndAssertArtifactSecrets(artifactDirectory, [...runtimeSensitiveValues]);
        await writeArtifactManifest(artifactDirectory);
        await assertArtifactSecretsAbsent(artifactDirectory, [...runtimeSensitiveValues]);
        process.stdout.write(`Browser evidence: ${artifactDirectory}\n`);
      } catch (evidenceError) {
        let finalEvidenceError = evidenceError;
        try {
          await rm(artifactDirectory, { force: true, recursive: true });
        } catch (removalError) {
          finalEvidenceError = new AggregateError([evidenceError, removalError]);
        }
        artifactDirectory = undefined;
        failure = appendFailure(failure, finalEvidenceError);
      }
    }
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    if (signalState.signal) process.exitCode = signalExitCode(signalState.signal);
  }
  if (failure) throw failure;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runHarness();
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error), [
      ...runtimeSensitiveValues,
    ]);
    process.stderr.write(`${message}\n`);
    if (!process.exitCode) process.exitCode = 1;
  }
}
