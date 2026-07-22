import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  createDatabasePool,
  migrateDatabase,
} from "../../packages/db/dist/index.js";

export const ports = {
  admin: 41_904,
  api: 41_900,
  employee: 41_901,
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

export async function seedHrLeaveFixture() {
  const applicationRole = requiredEnvironment("ESBLA_TEST_APPLICATION_ROLE");
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) throw new Error("Unsafe application role");
  const pool = createDatabasePool(requiredEnvironment("DATABASE_MIGRATION_URL"), { max: 2 });
  try {
    await migrateDatabase(createDatabase(pool));
    const client = await pool.connect();
    try {
      await client.query(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
      await client.query(`GRANT SELECT ON principals, tenant_settings TO ${applicationRole}`);
      await client.query(
        `GRANT SELECT, UPDATE ON memberships, service_activations TO ${applicationRole}`,
      );
      await client.query(
        `GRANT SELECT ON membership_capabilities, hr_workforce_profile_service_control,
          hr_workforce_status_history, hr_reporting_relationships TO ${applicationRole}`,
      );
      await client.query(`GRANT INSERT ON hr_reporting_relationships TO ${applicationRole}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON work_items, hr_leave_requests,
          hr_worker_profiles TO ${applicationRole}`,
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
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
         VALUES ($1, 'hr.leave_request', 'active', 1),
                ($1, 'workforce_profile', 'active', 1)`,
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
      await client.query(
        `INSERT INTO hr_worker_profiles (tenant_id, employee_number)
         VALUES ($1, 'BROWSER-DRAFT-001')`,
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
}
