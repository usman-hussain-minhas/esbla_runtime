import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  createDatabase,
  createDatabasePool,
  migrateDatabase,
} from "../../packages/db/dist/index.js";

export const ports = {
  admin: 41_904,
  api: 41_900,
  employee: 41_901,
  employmentActionAdmin: 41_907,
  employmentActionOperator: 41_906,
  employmentEmployee: 41_905,
  employmentListOperator: 41_909,
  employmentViewAdmin: 41_908,
  manager: 41_902,
  operator: 41_903,
};
export const fixture = {
  adminLabel: "Browser Tenant Admin session",
  adminOrigin: `http://127.0.0.1:${ports.admin}`,
  adminPrincipalId: "10000000-0000-4000-8000-000000000010",
  employeeDisplayName: "Browser Employee",
  employeeLabel: "Browser Employee session",
  employeeOrigin: `http://127.0.0.1:${ports.employee}`,
  employeePrincipalId: "10000000-0000-4000-8000-000000000004",
  employmentActionAdminLabel: "Browser Employment Action Admin session",
  employmentActionAdminOrigin: `http://127.0.0.1:${ports.employmentActionAdmin}`,
  employmentActionAdminPrincipalId: "10000000-0000-4000-8000-000000000016",
  employmentActionAdminTenantId: "00000000-0000-4000-8000-000000000002",
  employmentActionOperatorLabel: "Browser Employment Action Operator session",
  employmentActionOperatorOrigin: `http://127.0.0.1:${ports.employmentActionOperator}`,
  employmentActionOperatorPrincipalId: "10000000-0000-4000-8000-000000000014",
  employmentEmployeeLabel: "Browser Employment Employee session",
  employmentEmployeeOrigin: `http://127.0.0.1:${ports.employmentEmployee}`,
  employmentEmployeePrincipalId: "10000000-0000-4000-8000-000000000012",
  employmentListOperatorLabel: "Browser Employment List Operator session",
  employmentListOperatorOrigin: `http://127.0.0.1:${ports.employmentListOperator}`,
  employmentListOperatorPrincipalId: "10000000-0000-4000-8000-000000000020",
  employmentViewAdminLabel: "Browser Employment View Admin session",
  employmentViewAdminOrigin: `http://127.0.0.1:${ports.employmentViewAdmin}`,
  employmentViewAdminPrincipalId: "10000000-0000-4000-8000-000000000018",
  managerLabel: "Browser Manager session",
  managerOrigin: `http://127.0.0.1:${ports.manager}`,
  managerPrincipalId: "10000000-0000-4000-8000-000000000002",
  operatorLabel: "Browser HR Operator session",
  operatorOrigin: `http://127.0.0.1:${ports.operator}`,
  operatorPrincipalId: "10000000-0000-4000-8000-000000000006",
  reportPrincipalId: "10000000-0000-4000-8000-000000000008",
  tenantId: "00000000-0000-4000-8000-000000000001",
};

export function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createFixtureEnvironment() {
  return {
    ESBLA_API_BASE_URL: `http://127.0.0.1:${ports.api}`,
    ESBLA_DEV_AUTH_SECRET: randomBytes(32).toString("hex"),
  };
}

export async function createPrivatePlaywrightRoot() {
  let path;
  try {
    path = await mkdtemp(join(tmpdir(), "esbla-playwright-"));
    await chmod(path, 0o700);
    const canonicalPath = await realpath(path);
    const identity = await lstat(canonicalPath);
    if (
      identity.isSymbolicLink() ||
      !identity.isDirectory() ||
      identity.uid !== process.getuid?.() ||
      (identity.mode & 0o777) !== 0o700
    ) {
      throw new Error("Invalid private Playwright root");
    }
    return {
      device: identity.dev,
      inode: identity.ino,
      mode: identity.mode,
      owner: identity.uid,
      path: canonicalPath,
    };
  } catch {
    const identity = path ? await lstat(path).catch(() => undefined) : undefined;
    if (
      identity?.isDirectory() &&
      !identity.isSymbolicLink() &&
      identity.uid === process.getuid?.()
    ) {
      await rm(path, { force: false, recursive: true }).catch(() => undefined);
    }
    throw new Error("Unable to create private Playwright root");
  }
}

async function removePrivatePlaywrightRoot(root, closeReceipt) {
  if (!root) return;
  if (closeReceipt && closeReceipt.signal !== null) {
    throw new Error("Playwright did not close cooperatively");
  }
  const canonicalPath = await realpath(root.path);
  const identity = await lstat(root.path);
  if (
    canonicalPath !== root.path ||
    identity.isSymbolicLink() ||
    !identity.isDirectory() ||
    identity.dev !== root.device ||
    identity.ino !== root.inode ||
    identity.mode !== root.mode ||
    identity.uid !== root.owner
  ) {
    throw new Error("Private Playwright root identity changed");
  }
  await rm(root.path, { force: false, recursive: true });
}

export async function closePrivatePlaywrightRoot(rootPromise, playwright) {
  if (playwright && !playwright.receipt) throw new Error("Missing Playwright close receipt");
  const root = rootPromise ? await rootPromise : undefined;
  await removePrivatePlaywrightRoot(root, playwright?.receipt);
}

const nextRuntimePersonas = [
  "admin",
  "employee",
  "employmentActionAdmin",
  "employmentActionOperator",
  "employmentEmployee",
  "employmentListOperator",
  "employmentViewAdmin",
  "manager",
  "operator",
];
const maxNextBuildFiles = 2_000;
const maxNextBuildEntries = 4_000;
const maxNextBuildFileBytes = 16 * 1_024 * 1_024;
const maxNextBuildTotalBytes = 128 * 1_024 * 1_024;
const maxNextBuildDepth = 32;
const nextRuntimeRequiredFiles = [
  "BUILD_ID",
  "required-server-files.json",
  join("server", "app-paths-manifest.json"),
];

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function isOwnedPrivateDirectory(identity) {
  return (
    identity?.isDirectory() &&
    !identity.isSymbolicLink() &&
    identity.uid === process.getuid?.() &&
    (identity.mode & 0o777) === 0o700
  );
}

async function inspectPhysicalTree(root) {
  const hash = createHash("sha256");
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (directory, depth) => {
    if (depth > maxNextBuildDepth) throw new Error("Next build exceeds private-copy depth");
    const entries = [];
    for await (const entry of await fs.opendir(directory)) {
      entryCount += 1;
      if (entryCount > maxNextBuildEntries) {
        throw new Error("Next build exceeds private-copy entry limit");
      }
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        hash.update(`directory\0${name}\0`);
        await visit(path, depth + 1);
      } else if (entry.isFile()) {
        const identity = await lstat(path);
        fileCount += 1;
        totalBytes += identity.size;
        if (
          !identity.isFile() ||
          fileCount > maxNextBuildFiles ||
          identity.size > maxNextBuildFileBytes ||
          totalBytes > maxNextBuildTotalBytes
        ) {
          throw new Error("Next build exceeds private-copy limits");
        }
        const bytes = await fs.readFile(path);
        if (bytes.length !== identity.size) throw new Error("Next build changed during inspection");
        hash.update(`file\0${name}\0${identity.size}\0`).update(bytes);
      } else {
        throw new Error("Next build contains an unsupported entry");
      }
    }
  };
  await visit(root, 0);
  return { fileCount, sha256: hash.digest("hex"), totalBytes };
}

async function fileReceipt(path) {
  const identity = await lstat(path);
  if (!identity.isFile()) throw new Error("Invalid Next build file");
  if (identity.size > maxNextBuildFileBytes) throw new Error("Next build file exceeds limit");
  const bytes = await fs.readFile(path);
  return {
    device: identity.dev,
    inode: identity.ino,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: identity.size,
  };
}

async function captureNextBuild(nextRoot) {
  const canonicalPath = await realpath(nextRoot);
  const identity = await lstat(nextRoot);
  if (canonicalPath !== resolve(nextRoot) || !identity.isDirectory())
    throw new Error("Invalid Next build root");
  const files = {};
  for (const name of nextRuntimeRequiredFiles)
    files[name] = await fileReceipt(join(nextRoot, name));
  return {
    device: identity.dev,
    files,
    inode: identity.ino,
    path: canonicalPath,
    shape: await inspectPhysicalTree(canonicalPath),
  };
}

export async function createPrivateNextRuntimeRoots(webRootInput) {
  let path;
  let rootIdentity;
  try {
    const webRoot = await realpath(webRootInput);
    if (webRoot !== resolve(webRootInput)) throw new Error("Invalid web root");
    const sourceNextRoot = join(webRoot, ".next");
    const source = await captureNextBuild(sourceNextRoot);
    const nodeModules = await realpath(join(webRoot, "node_modules"));

    path = await mkdtemp(join(tmpdir(), "esbla-next-runtime-"));
    await chmod(path, 0o700);
    const createdIdentity = await lstat(path);
    const canonicalPath = await realpath(path);
    path = canonicalPath;
    rootIdentity = await lstat(canonicalPath);
    if (
      !isOwnedPrivateDirectory(createdIdentity) ||
      createdIdentity.dev !== rootIdentity.dev ||
      createdIdentity.ino !== rootIdentity.ino ||
      !isOwnedPrivateDirectory(rootIdentity)
    ) {
      throw new Error("Invalid private Next runtime root");
    }

    const projects = {};
    const criticalCopies = new Set();
    for (const persona of nextRuntimePersonas) {
      const project = join(canonicalPath, persona);
      await fs.mkdir(project, { mode: 0o700 });
      const canonicalProject = await realpath(project);
      if (!canonicalProject.startsWith(`${canonicalPath}${sep}`)) {
        throw new Error("Invalid private Next project root");
      }

      await Promise.all([
        fs.copyFile(join(webRoot, "package.json"), join(canonicalProject, "package.json")),
        fs.copyFile(join(webRoot, "next.config.ts"), join(canonicalProject, "next.config.ts")),
      ]);
      await fs.symlink(nodeModules, join(canonicalProject, "node_modules"), "dir");
      if ((await realpath(join(canonicalProject, "node_modules"))) !== nodeModules) {
        throw new Error("Invalid private Next dependency link");
      }

      const destinationNextRoot = join(canonicalProject, ".next");
      await fs.cp(sourceNextRoot, destinationNextRoot, {
        errorOnExist: true,
        force: false,
        recursive: true,
      });
      const destination = await captureNextBuild(destinationNextRoot);
      if (JSON.stringify(destination.shape) !== JSON.stringify(source.shape)) {
        throw new Error("Next build copy validation failed");
      }
      for (const name of nextRuntimeRequiredFiles) {
        const sourceFile = source.files[name];
        const destinationFile = destination.files[name];
        const destinationIdentity = `${destinationFile.device}:${destinationFile.inode}`;
        if (
          sourceFile.sha256 !== destinationFile.sha256 ||
          sourceFile.size !== destinationFile.size ||
          `${sourceFile.device}:${sourceFile.inode}` === destinationIdentity ||
          criticalCopies.has(destinationIdentity)
        ) {
          throw new Error("Next build copy isolation failed");
        }
        criticalCopies.add(destinationIdentity);
      }
      projects[persona] = canonicalProject;
    }

    if (JSON.stringify(source) !== JSON.stringify(await captureNextBuild(sourceNextRoot))) {
      throw new Error("Source Next build changed during private copy creation");
    }
    return {
      device: rootIdentity.dev,
      inode: rootIdentity.ino,
      mode: rootIdentity.mode,
      owner: rootIdentity.uid,
      path: canonicalPath,
      projects: Object.freeze(projects),
      source,
    };
  } catch {
    let cleanupFailed = false;
    const identity = path ? await lstatIfPresent(path) : undefined;
    if (
      isOwnedPrivateDirectory(identity) &&
      (!rootIdentity || (identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino))
    ) {
      try {
        await rm(path, { force: false, recursive: true });
        cleanupFailed = Boolean(await lstatIfPresent(path));
      } catch {
        cleanupFailed = true;
      }
    } else if (identity) {
      cleanupFailed = true;
    }
    if (cleanupFailed) throw new Error("Unable to clean failed private Next runtime roots");
    throw new Error("Unable to create private Next runtime roots");
  }
}

async function removePrivateNextRuntimeRoots(root, webProcesses) {
  if (!root) return;
  let failed = webProcesses.some((processRecord) => !processRecord.receipt);
  try {
    if (JSON.stringify(root.source) !== JSON.stringify(await captureNextBuild(root.source.path))) {
      failed = true;
    }
  } catch {
    failed = true;
  }
  try {
    const canonicalPath = await realpath(root.path);
    const identity = await lstat(root.path);
    if (
      canonicalPath !== root.path ||
      identity.isSymbolicLink() ||
      !identity.isDirectory() ||
      identity.dev !== root.device ||
      identity.ino !== root.inode ||
      identity.mode !== root.mode ||
      identity.uid !== root.owner
    ) {
      throw new Error("Private Next runtime root identity changed");
    }
    await rm(root.path, { force: false, recursive: true });
    if (await lstatIfPresent(root.path)) throw new Error("Private Next runtime root remains");
  } catch {
    failed = true;
  }
  if (failed) throw new Error("Private Next runtime cleanup failed");
}

export async function closePrivateNextRuntimeRoots(rootPromise, webProcesses) {
  const root = rootPromise ? await rootPromise : undefined;
  await removePrivateNextRuntimeRoots(root, webProcesses);
}

export async function seedHrLeaveFixture() {
  const applicationRole = requiredEnvironment("ESBLA_TEST_APPLICATION_ROLE");
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) throw new Error("Unsafe application role");
  const pool = createDatabasePool(requiredEnvironment("DATABASE_MIGRATION_URL"), { max: 2 });
  let employmentActionWorkerProfileId;
  try {
    await migrateDatabase(createDatabase(pool));
    const client = await pool.connect();
    try {
      await client.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
      await client.query(`GRANT SELECT ON principals, tenant_settings TO ${applicationRole}`);
      await client.query(`GRANT SELECT ON memberships TO ${applicationRole}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON service_activations TO ${applicationRole}`,
      );
      await client.query(
        `GRANT SELECT ON membership_capabilities, hr_workforce_profile_service_control,
          hr_workforce_status_history, hr_reporting_relationships TO ${applicationRole}`,
      );
      await client.query(`GRANT INSERT ON hr_reporting_relationships TO ${applicationRole}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON work_items, hr_leave_requests,
          hr_worker_profiles, hr_employment_records TO ${applicationRole}`,
      );
      await client.query(
        `GRANT SELECT ON hr_employment_record_service_control TO ${applicationRole}`,
      );
      await client.query(
        `GRANT SELECT, INSERT ON hr_employment_record_versions TO ${applicationRole}`,
      );
      await client.query(
        `GRANT SELECT, INSERT ON evidence_events, outbox_events TO ${applicationRole}`,
      );
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
      await client.query("INSERT INTO tenants (tenant_id, name) VALUES($1,'Browser Tenant')", [
        fixture.tenantId,
      ]);
      await client.query(
        `INSERT INTO principals (principal_id, display_name)
         VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`,
        [
          fixture.managerPrincipalId,
          "Browser Manager",
          fixture.employeePrincipalId,
          fixture.employeeDisplayName,
          fixture.operatorPrincipalId,
          "Browser HR Operator",
          fixture.reportPrincipalId,
          "Browser Direct Report",
          fixture.adminPrincipalId,
          "Browser Tenant Admin",
        ],
      );
      await client.query(
        `INSERT INTO principals (principal_id, display_name)
         VALUES ($1, 'Browser Employment Employee'),
                ($2, 'Browser Employment Action Operator'),
                ($3, 'Browser Employment Action Admin'),
                ($4, 'Browser Employment View Admin'),
                ($5, 'Browser Employment List Operator')`,
        [
          fixture.employmentEmployeePrincipalId,
          fixture.employmentActionOperatorPrincipalId,
          fixture.employmentActionAdminPrincipalId,
          fixture.employmentViewAdminPrincipalId,
          fixture.employmentListOperatorPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ('20000000-0000-4000-8000-000000000002', $1, $2, 'manager', NULL),
                ('20000000-0000-4000-8000-000000000004', $1, $3, 'employee', $2),
                ('20000000-0000-4000-8000-000000000006', $1, $4, 'hr_operator', NULL),
                ('20000000-0000-4000-8000-000000000008', $1, $5, 'employee', $2),
                ('20000000-0000-4000-8000-000000000010', $1, $6, 'tenant_admin', NULL)`,
        [
          fixture.tenantId,
          fixture.managerPrincipalId,
          fixture.employeePrincipalId,
          fixture.operatorPrincipalId,
          fixture.reportPrincipalId,
          fixture.adminPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ('20000000-0000-4000-8000-000000000012', $1, $2, 'employee', NULL),
                ('20000000-0000-4000-8000-000000000014', $1, $3, 'hr_operator', NULL),
                ('20000000-0000-4000-8000-000000000018', $1, $4, 'tenant_admin', NULL),
                ('20000000-0000-4000-8000-000000000020', $1, $5, 'hr_operator', NULL)`,
        [
          fixture.tenantId,
          fixture.employmentEmployeePrincipalId,
          fixture.employmentActionOperatorPrincipalId,
          fixture.employmentViewAdminPrincipalId,
          fixture.employmentListOperatorPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.workforce.view_own'),
                ($1, $3, 'hr.workforce.create_profile'),
                ($1, $3, 'hr.workforce.link_principal'),
                ($1, $3, 'hr.workforce.change_status'),
                ($1, $3, 'hr.workforce.change_reporting_relationship'),
                ($1, $4, 'hr.workforce.view_authorized_detail'),
                ($1, $3, 'hr.workforce.view_authorized_detail'),
                ($1, $4, 'hr.workforce.list_authorized'),
                ($1, $3, 'hr.workforce.list_authorized'),
                ($1, $5, 'hr.workforce.activate_service'),
                ($1, $5, 'hr.workforce.configure_service'),
                ($1, $5, 'hr.workforce.deactivate_service'),
                ($1, $5, 'hr.workforce.view_service_control')`,
        [
          fixture.tenantId,
          fixture.employeePrincipalId,
          fixture.operatorPrincipalId,
          fixture.managerPrincipalId,
          fixture.adminPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.employment.list_authorized'),
                ($1, $2, 'hr.employment.view_detail'),
                ($1, $3, 'hr.employment.create_record'),
                ($1, $3, 'hr.employment.create_version'),
                ($1, $3, 'hr.employment.end_record'),
                ($1, $3, 'hr.employment.list_authorized'),
                ($1, $3, 'hr.employment.view_detail'),
                ($1, $4, 'hr.employment.activate_service'),
                ($1, $4, 'hr.employment.configure_service'),
                ($1, $4, 'hr.employment.deactivate_service'),
                ($1, $4, 'hr.employment.view_service_control'),
                ($1, $5, 'hr.employment.create_record'),
                ($1, $5, 'hr.employment.create_version'),
                ($1, $5, 'hr.employment.end_record'),
                ($1, $6, 'hr.employment.view_service_control'),
                ($1, $7, 'hr.employment.list_authorized')`,
        [
          fixture.tenantId,
          fixture.employmentEmployeePrincipalId,
          fixture.operatorPrincipalId,
          fixture.adminPrincipalId,
          fixture.employmentActionOperatorPrincipalId,
          fixture.employmentViewAdminPrincipalId,
          fixture.employmentListOperatorPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
         VALUES ($1, 'hr.leave_request', 'active', 1),
                ($1, 'workforce_profile', 'active', 1),
                ($1, 'employment_record', 'active', 1)`,
        [fixture.tenantId],
      );
      await client.query(
        `SELECT set_config('app.actor_principal_id', $1, true),
                set_config('app.correlation_id', $2, true)`,
        [fixture.operatorPrincipalId, "90000000-0000-4000-8000-000000000001"],
      );
      const createActiveProfile = async (employeeNumber, principalId) => {
        const inserted = await client.query(
          `INSERT INTO hr_worker_profiles (tenant_id, employee_number)
           VALUES ($1, $2) RETURNING worker_profile_id`,
          [fixture.tenantId, employeeNumber],
        );
        const workerProfileId = inserted.rows[0]?.worker_profile_id;
        if (typeof workerProfileId !== "string") throw new Error("Workforce fixture insert failed");
        await client.query(
          `UPDATE hr_worker_profiles SET principal_id=$3, row_version=2
           WHERE tenant_id=$1 AND worker_profile_id=$2`,
          [fixture.tenantId, workerProfileId, principalId],
        );
        await client.query(
          `UPDATE hr_worker_profiles SET workforce_status='active', row_version=3
           WHERE tenant_id=$1 AND worker_profile_id=$2`,
          [fixture.tenantId, workerProfileId],
        );
        return workerProfileId;
      };
      const managerWorkerProfileId = await createActiveProfile(
        "BROWSER-MANAGER-001",
        fixture.managerPrincipalId,
      );
      const reportWorkerProfileId = await createActiveProfile(
        "BROWSER-DIRECT-001",
        fixture.reportPrincipalId,
      );
      await createActiveProfile("BROWSER-EMPLOYMENT-001", fixture.employmentEmployeePrincipalId);
      const actionWorker = await client.query(
        `INSERT INTO hr_worker_profiles (worker_profile_id, tenant_id, employee_number)
         VALUES (gen_random_uuid(), $1, 'BROWSER-EMPLOYMENT-ACTION-001')
         RETURNING worker_profile_id`,
        [fixture.tenantId],
      );
      employmentActionWorkerProfileId = actionWorker.rows[0]?.worker_profile_id;
      if (typeof employmentActionWorkerProfileId !== "string") {
        throw new Error("Employment action fixture insert failed");
      }
      await client.query(
        `INSERT INTO hr_worker_profiles (tenant_id, employee_number)
         VALUES ($1, 'BROWSER-DRAFT-001'),
                ($1, 'BROWSER-EMPLOYMENT-CONTROL-001')`,
        [fixture.tenantId],
      );
      const relationship = await client.query(
        `INSERT INTO hr_reporting_relationships
           (tenant_id, worker_profile_id, manager_worker_profile_id,
            relationship_status, relationship_version)
         VALUES ($1, $2, $3, 'assigned', 1) RETURNING reporting_relationship_id`,
        [fixture.tenantId, reportWorkerProfileId, managerWorkerProfileId],
      );
      await client.query(
        `UPDATE hr_worker_profiles SET current_reporting_relationship_id=$3, row_version=4
         WHERE tenant_id=$1 AND worker_profile_id=$2`,
        [fixture.tenantId, reportWorkerProfileId, relationship.rows[0]?.reporting_relationship_id],
      );
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        fixture.employmentActionAdminTenantId,
      ]);
      await client.query(
        "INSERT INTO tenants (tenant_id, name) VALUES($1,'Browser Employment Action Tenant')",
        [fixture.employmentActionAdminTenantId],
      );
      await client.query(
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ('20000000-0000-4000-8000-000000000016', $1, $2, 'tenant_admin', NULL)`,
        [fixture.employmentActionAdminTenantId, fixture.employmentActionAdminPrincipalId],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.employment.activate_service'),
                ($1, $2, 'hr.employment.configure_service'),
                ($1, $2, 'hr.employment.deactivate_service')`,
        [fixture.employmentActionAdminTenantId, fixture.employmentActionAdminPrincipalId],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
         VALUES ($1, 'workforce_profile', 'active', 1)`,
        [fixture.employmentActionAdminTenantId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  return Object.freeze({ employmentActionWorkerProfileId });
}
