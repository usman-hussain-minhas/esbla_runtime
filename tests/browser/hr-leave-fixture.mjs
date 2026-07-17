import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  createDatabasePool,
  migrateDatabase,
} from "../../packages/db/dist/index.js";

export const ports = { api: 41_900, employee: 41_901, manager: 41_902 };
export const fixture = {
  employeeDisplayName: "Browser Employee",
  employeeLabel: "Browser Employee session",
  employeeOrigin: `http://127.0.0.1:${ports.employee}`,
  employeePrincipalId: "10000000-0000-4000-8000-000000000004",
  managerLabel: "Browser Manager session",
  managerOrigin: `http://127.0.0.1:${ports.manager}`,
  managerPrincipalId: "10000000-0000-4000-8000-000000000002",
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
      await client.query(
        `GRANT SELECT ON principals, service_activations, tenant_settings TO ${applicationRole}`,
      );
      await client.query(`GRANT SELECT, UPDATE ON memberships TO ${applicationRole}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON work_items, hr_leave_requests TO ${applicationRole}`,
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
        "INSERT INTO principals (principal_id, display_name) VALUES ($1, $2), ($3, $4)",
        [
          fixture.managerPrincipalId,
          "Browser Manager",
          fixture.employeePrincipalId,
          fixture.employeeDisplayName,
        ],
      );
      await client.query(
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, manager_principal_id)
         VALUES ('20000000-0000-4000-8000-000000000002', $1, $2, 'manager', NULL),
                ('20000000-0000-4000-8000-000000000004', $1, $3, 'employee', $2)`,
        [fixture.tenantId, fixture.managerPrincipalId, fixture.employeePrincipalId],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
         VALUES ($1, 'hr.leave_request', 'active', 1)`,
        [fixture.tenantId],
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
