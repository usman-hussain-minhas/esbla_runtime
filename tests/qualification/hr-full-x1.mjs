import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  listAssignedExpenseClaims,
  listAssignedTimesheets,
  listAuthorizedShiftAssignments,
  listAuthorizedWorkforceProfiles,
  listOwnExpenseClaims,
  listOwnTimesheets,
} from "../../modules/hr/dist/index.js";
import { createDatabasePool } from "../../packages/db/dist/index.js";
import { fixture, requiredEnvironment, seedHrLeaveFixture } from "../browser/hr-leave-fixture.mjs";

const execute = promisify(execFile);
const representativeRows = 1_000;
const pageSize = 50;
const restoreDatabaseName = `esbla_full_x1_restore_${randomUUID().replaceAll("-", "")}`;
const supportOnly = process.argv.includes("--support-only");
const tableNamePattern = /^[a-z_][a-z0-9_]*$/;
const explainTablePattern =
  /\b(hr_worker_profiles|hr_reporting_relationships|hr_shift_assignments|hr_shift_roster_versions|hr_timesheets|hr_timesheet_versions|hr_expense_claims|hr_expense_claim_versions|work_items)\b/i;

if (process.env.ESBLA_FULL_X1_EPHEMERAL !== "1") {
  throw new Error("FULL-X1 qualification requires the supported ephemeral PostgreSQL command");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeIdentifier(value) {
  if (!tableNamePattern.test(value)) throw new Error("Unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function context(actorPrincipalId) {
  return {
    actorPrincipalId,
    correlationId: randomUUID(),
    tenantId: fixture.tenantId,
  };
}

function databaseUrlFor(connectionString, databaseName, username) {
  const selected = /^(postgres(?:ql)?:\/\/)([^/]*)(\/[^?#]*)(\?[^#]*)?$/.exec(connectionString);
  if (!selected) throw new Error("Invalid PostgreSQL connection string");
  let authority = selected[2] ?? "";
  if (username) {
    const separator = authority.lastIndexOf("@");
    const host = separator >= 0 ? authority.slice(separator + 1) : authority;
    authority = `${encodeURIComponent(username)}@${host}`;
  }
  const path = databaseName ? encodeURIComponent(databaseName) : (selected[3]?.slice(1) ?? "");
  return `${selected[1]}${authority}/${path}${selected[4] ?? ""}`;
}

async function assertEphemeralConnections(migrationConnectionString, applicationConnectionString) {
  const parse = (connectionString, expectedUser) => {
    const selected = /^(postgres(?:ql)?:\/\/)([^/]*)(\/[^?#]*)(\?[^#]*)?$/.exec(connectionString);
    assert.ok(selected, "PostgreSQL harness connection string is invalid");
    assert.equal(selected[2], `${expectedUser}@`, "PostgreSQL harness role is invalid");
    assert.equal(
      decodeURIComponent(selected[3]?.slice(1) ?? ""),
      "esbla_test",
      "PostgreSQL harness database is invalid",
    );
    const parameters = new URLSearchParams(selected[4]?.slice(1) ?? "");
    const host = parameters.get("host");
    const port = parameters.get("port");
    assert.ok(host, "PostgreSQL harness socket is missing");
    assert.match(port ?? "", /^[1-9][0-9]{0,4}$/, "PostgreSQL harness port is invalid");
    return { host, port };
  };
  const migration = parse(migrationConnectionString, "esbla_migrator");
  const application = parse(applicationConnectionString, "esbla_app");
  assert.deepEqual(application, migration, "PostgreSQL harness connections diverged");
  const canonical = await realpath(migration.host);
  const canonicalTemp = await realpath(tmpdir());
  const identity = await lstat(migration.host);
  assert.ok(
    canonical.startsWith(`${canonicalTemp}/esbla-postgres-`) && canonical.endsWith("/socket"),
    "PostgreSQL harness socket is outside the private test root",
  );
  assert.equal(identity.isDirectory(), true, "PostgreSQL harness socket is not a directory");
  assert.equal(identity.isSymbolicLink(), false, "PostgreSQL harness socket is a symlink");
  assert.equal(identity.uid, process.getuid?.(), "PostgreSQL harness socket owner changed");
}

async function runSanitized(command, args) {
  try {
    await execute(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
  } catch {
    throw new Error("FULL-X1 PostgreSQL utility failed");
  }
}

function instrumentPool(pool, observations) {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") {
                return async (...args) => {
                  const statement = typeof args[0] === "string" ? args[0] : undefined;
                  const result = await clientTarget.query(...args);
                  if (/^\s*BEGIN\s*$/i.test(statement ?? "")) {
                    await clientTarget.query("SET LOCAL enable_seqscan=off");
                  } else if (
                    statement &&
                    /^\s*SELECT\b/i.test(statement) &&
                    explainTablePattern.test(statement)
                  ) {
                    const explained = await clientTarget.query(
                      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`,
                      args[1],
                    );
                    observations.push({
                      plan: explained.rows[0]?.["QUERY PLAN"],
                      statement: statement.replace(/\s+/g, " ").trim(),
                    });
                  }
                  return result;
                };
              }
              return Reflect.get(clientTarget, clientProperty, clientReceiver);
            },
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function planBlocks(node) {
  if (!node || typeof node !== "object") return 0;
  return (
    Number(node["Shared Hit Blocks"] ?? 0) +
    Number(node["Shared Read Blocks"] ?? 0) +
    Number(node["Local Hit Blocks"] ?? 0) +
    Number(node["Local Read Blocks"] ?? 0) +
    Number(node["Temp Read Blocks"] ?? 0) +
    Number(node["Temp Written Blocks"] ?? 0)
  );
}

function collectPlanAccess(node, indexes, sequentialTables) {
  if (!node || typeof node !== "object") return;
  if (typeof node["Index Name"] === "string") indexes.add(node["Index Name"]);
  if (
    node["Node Type"] === "Seq Scan" &&
    typeof node["Relation Name"] === "string" &&
    explainTablePattern.test(node["Relation Name"])
  ) {
    sequentialTables.add(node["Relation Name"]);
  }
  for (const child of Array.isArray(node.Plans) ? node.Plans : []) {
    collectPlanAccess(child, indexes, sequentialTables);
  }
}

async function capturePerformance(observations, label, operation) {
  observations.length = 0;
  const result = await operation();
  assert.equal(result.items.length, pageSize, `${label} must return one bounded page`);
  assert.ok(observations.length > 0, `${label} must produce an analyzed query plan`);
  assert.ok(observations.length <= 12, `${label} exceeded its bounded query-plan count`);
  const indexes = new Set();
  const sequentialTables = new Set();
  for (const observation of observations) {
    for (const entry of Array.isArray(observation.plan) ? observation.plan : []) {
      collectPlanAccess(entry?.Plan, indexes, sequentialTables);
    }
  }
  assert.ok(indexes.size > 0, `${label} did not use an index`);
  assert.deepEqual([...sequentialTables], [], `${label} scanned a representative HR table`);
  const blockCount = observations.reduce(
    (total, observation) =>
      total +
      (Array.isArray(observation.plan)
        ? observation.plan.reduce((planTotal, entry) => planTotal + planBlocks(entry?.Plan), 0)
        : 0),
    0,
  );
  return {
    analyzedStatements: observations.length,
    blocks: blockCount,
    indexes: [...indexes].sort(),
    label,
    rows: result.items.length,
  };
}

async function seedRepresentativeRows(pool) {
  const client = await pool.connect();
  let rosterVersionId;
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true),
              set_config('app.actor_principal_id',$2,true),
              set_config('app.correlation_id',$3,true)`,
      [fixture.tenantId, fixture.operatorPrincipalId, randomUUID()],
    );
    await client.query(
      `UPDATE service_activations
       SET state='active',version=version+1
       WHERE tenant_id=$1
         AND service_key=ANY($2::text[])
         AND state<>'active'`,
      [
        fixture.tenantId,
        [
          "workforce_profile",
          "employment_record",
          "shift_assignment",
          "attendance",
          "timesheet",
          "expense_claim_boundary",
          "hr.leave_request",
        ],
      ],
    );
    await client.query(
      `UPDATE tenant_settings
       SET value='"minimized"'::jsonb,version=version+1
       WHERE tenant_id=$1 AND setting_key='hr.workforce_profile.manager_visibility'
         AND value<>'"minimized"'::jsonb`,
      [fixture.tenantId],
    );

    const profiles = await client.query(
      `SELECT principal_id,worker_profile_id
       FROM hr_worker_profiles
       WHERE tenant_id=$1 AND principal_id=ANY($2::uuid[])`,
      [fixture.tenantId, [fixture.managerPrincipalId, fixture.employmentEmployeePrincipalId]],
    );
    const managerProfileId = profiles.rows.find(
      (row) => row.principal_id === fixture.managerPrincipalId,
    )?.worker_profile_id;
    const employeeProfileId = profiles.rows.find(
      (row) => row.principal_id === fixture.employmentEmployeePrincipalId,
    )?.worker_profile_id;
    assert.equal(typeof managerProfileId, "string", "Manager profile must exist");
    assert.equal(typeof employeeProfileId, "string", "Employee profile must exist");

    await client.query(
      `CREATE TEMP TABLE full_x1_profiles
         (ordinal integer PRIMARY KEY,principal_id uuid NOT NULL,
          worker_profile_id uuid,
          reporting_relationship_id uuid) ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO full_x1_profiles
       SELECT ordinal,gen_random_uuid(),NULL,NULL
       FROM generate_series(1,$1) ordinal`,
      [representativeRows],
    );
    await client.query(
      `INSERT INTO principals (principal_id,display_name)
       SELECT principal_id,'FULL-X1 Worker ' || ordinal
       FROM full_x1_profiles`,
    );
    await client.query(
      `INSERT INTO memberships (tenant_id,principal_id,role_key)
       SELECT $1,principal_id,'employee'
       FROM full_x1_profiles`,
      [fixture.tenantId],
    );
    await client.query(
      `INSERT INTO hr_worker_profiles (tenant_id,employee_number)
       SELECT $1,'FULL-X1-' || lpad(ordinal::text,5,'0')
       FROM full_x1_profiles`,
      [fixture.tenantId],
    );
    await client.query(
      `UPDATE full_x1_profiles seed
       SET worker_profile_id=profile.worker_profile_id
       FROM hr_worker_profiles profile
       WHERE profile.tenant_id=$1
         AND profile.employee_number='FULL-X1-' || lpad(seed.ordinal::text,5,'0')`,
      [fixture.tenantId],
    );
    await client.query(
      `UPDATE hr_worker_profiles profile
       SET principal_id=seed.principal_id,row_version=2
       FROM full_x1_profiles seed
       WHERE profile.tenant_id=$1
         AND profile.worker_profile_id=seed.worker_profile_id`,
      [fixture.tenantId],
    );
    await client.query(
      `UPDATE hr_worker_profiles profile
       SET workforce_status='active',row_version=3
       FROM full_x1_profiles seed
       WHERE profile.tenant_id=$1
         AND profile.worker_profile_id=seed.worker_profile_id`,
      [fixture.tenantId],
    );
    await client.query(
      `INSERT INTO hr_reporting_relationships
         (reporting_relationship_id,tenant_id,worker_profile_id,
          manager_worker_profile_id,relationship_status,relationship_version,row_version)
       SELECT reporting_relationship_id,$1,worker_profile_id,$2,'assigned',1,1
       FROM full_x1_profiles`,
      [fixture.tenantId, managerProfileId],
    );
    await client.query(
      `UPDATE full_x1_profiles seed
       SET reporting_relationship_id=relationship.reporting_relationship_id
       FROM hr_reporting_relationships relationship
       WHERE relationship.tenant_id=$1
         AND relationship.worker_profile_id=seed.worker_profile_id
         AND relationship.relationship_version=1`,
      [fixture.tenantId],
    );
    await client.query(
      `UPDATE hr_worker_profiles profile
       SET current_reporting_relationship_id=seed.reporting_relationship_id,row_version=4
       FROM full_x1_profiles seed
       WHERE profile.tenant_id=$1
         AND profile.worker_profile_id=seed.worker_profile_id`,
      [fixture.tenantId],
    );

    const roster = await client.query(
      `INSERT INTO hr_shift_roster_versions
         (tenant_id,period_start,period_end,status,version,row_version)
       VALUES ($1,'2035-01-01','2035-01-14','draft',1,1)
       RETURNING roster_version_id`,
      [fixture.tenantId],
    );
    rosterVersionId = roster.rows[0]?.roster_version_id;
    assert.equal(typeof rosterVersionId, "string", "Representative roster must exist");
    await client.query(
      `INSERT INTO hr_shift_assignments
         (tenant_id,roster_version_id,worker_profile_id,
          starts_at,ends_at,iana_timezone,status,row_version)
       SELECT $1,$2,worker_profile_id,
              '2035-01-02T09:00:00Z','2035-01-02T17:00:00Z',
              'Etc/UTC','active',1
       FROM full_x1_profiles`,
      [fixture.tenantId, rosterVersionId],
    );
    await client.query(
      `UPDATE hr_shift_roster_versions
       SET status='published',row_version=2
       WHERE tenant_id=$1 AND roster_version_id=$2`,
      [fixture.tenantId, rosterVersionId],
    );

    await client.query(
      `CREATE TEMP TABLE full_x1_timesheets
         (ordinal integer PRIMARY KEY,timesheet_id uuid NOT NULL,
          version_id uuid NOT NULL,period_start date NOT NULL,period_end date NOT NULL,
          submitted boolean NOT NULL) ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO full_x1_timesheets
       SELECT ordinal,gen_random_uuid(),gen_random_uuid(),
              DATE '2000-01-03' + ((ordinal-1)*7),
              DATE '2000-01-09' + ((ordinal-1)*7),
              ordinal <= $1 / 2
       FROM generate_series(1,$1) ordinal`,
      [representativeRows],
    );
    await client.query(
      `INSERT INTO hr_timesheets
         (timesheet_id,tenant_id,worker_profile_id,period_start,period_end,
          current_version_id,created_at,row_version)
       SELECT timesheet_id,$1,$2,period_start,period_end,version_id,
              '2000-01-01T00:00:00Z'::timestamptz + ordinal*interval '1 minute',1
       FROM full_x1_timesheets`,
      [fixture.tenantId, employeeProfileId],
    );
    await client.query(
      `INSERT INTO hr_timesheet_versions
         (timesheet_version_id,tenant_id,timesheet_id,version,status,total_minutes,row_version)
       SELECT version_id,$1,timesheet_id,1,'draft',0,1
       FROM full_x1_timesheets`,
      [fixture.tenantId],
    );
    await client.query(
      `INSERT INTO hr_timesheet_entries
         (tenant_id,timesheet_version_id,entry_date,minutes,description)
       SELECT $1,version_id,period_start,60,'Representative FULL-X1 entry'
       FROM full_x1_timesheets WHERE submitted`,
      [fixture.tenantId],
    );
    await client.query(
      `UPDATE hr_timesheet_versions version
       SET status='submitted',assigned_approver_worker_profile_id=$2,
           submitted_at='2030-01-01T00:00:00Z'::timestamptz
                        + seed.ordinal*interval '1 minute',
           total_minutes=60,updated_at=version.updated_at+interval '1 microsecond',
           row_version=2
       FROM full_x1_timesheets seed
       WHERE version.tenant_id=$1
         AND version.timesheet_version_id=seed.version_id
         AND seed.submitted`,
      [fixture.tenantId, managerProfileId],
    );
    await client.query(
      `INSERT INTO work_items
         (tenant_id,assignee_principal_id,work_type,subject_type,subject_id,status,created_at)
       SELECT $1,$2,'hr.timesheet.approval','hr.timesheet.version',
              version_id,'open',
              '2030-01-01T00:00:00Z'::timestamptz + ordinal*interval '1 minute'
       FROM full_x1_timesheets WHERE submitted`,
      [fixture.tenantId, fixture.managerPrincipalId],
    );

    await client.query(
      `CREATE TEMP TABLE full_x1_expenses
         (ordinal integer PRIMARY KEY,expense_claim_id uuid NOT NULL,
          version_id uuid NOT NULL,submitted boolean NOT NULL) ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO full_x1_expenses
       SELECT ordinal,gen_random_uuid(),gen_random_uuid(),ordinal <= $1 / 2
       FROM generate_series(1,$1) ordinal`,
      [representativeRows],
    );
    await client.query(
      `INSERT INTO hr_expense_claims
         (expense_claim_id,tenant_id,worker_profile_id,current_version_id,created_at,row_version)
       SELECT expense_claim_id,$1,$2,version_id,
              '2000-01-01T00:00:00Z'::timestamptz + ordinal*interval '1 minute',1
       FROM full_x1_expenses`,
      [fixture.tenantId, employeeProfileId],
    );
    await client.query(
      `INSERT INTO hr_expense_claim_versions
         (expense_claim_version_id,tenant_id,expense_claim_id,version,currency_code,
          status,total_amount_minor,row_version)
       SELECT version_id,$1,expense_claim_id,1,'USD','draft',0,1
       FROM full_x1_expenses`,
      [fixture.tenantId],
    );
    await client.query(
      `INSERT INTO hr_expense_claim_lines
         (tenant_id,expense_claim_version_id,expense_date,category_code,
          amount_minor,description)
       SELECT $1,version_id,DATE '2031-01-01','TRAVEL',100,
              'Representative FULL-X1 line'
       FROM full_x1_expenses WHERE submitted`,
      [fixture.tenantId],
    );
    await client.query(
      `UPDATE hr_expense_claim_versions version
       SET status='submitted',assigned_approver_worker_profile_id=$2,
           submitted_at='2031-01-01T00:00:00Z'::timestamptz
                        + seed.ordinal*interval '1 minute',
           total_amount_minor=100,
           updated_at=version.updated_at+interval '1 microsecond',row_version=2
       FROM full_x1_expenses seed
       WHERE version.tenant_id=$1
         AND version.expense_claim_version_id=seed.version_id
         AND seed.submitted`,
      [fixture.tenantId, managerProfileId],
    );
    await client.query(
      `INSERT INTO work_items
         (tenant_id,assignee_principal_id,work_type,subject_type,subject_id,status,created_at)
       SELECT $1,$2,'hr.expense.approval','hr.expense.version',
              version_id,'open',
              '2031-01-01T00:00:00Z'::timestamptz + ordinal*interval '1 minute'
       FROM full_x1_expenses WHERE submitted`,
      [fixture.tenantId, fixture.managerPrincipalId],
    );
    await client.query("COMMIT");
    await client.query(
      `ANALYZE hr_worker_profiles,hr_reporting_relationships,
               hr_shift_roster_versions,hr_shift_assignments,
               hr_timesheets,hr_timesheet_versions,
               hr_expense_claims,hr_expense_claim_versions,work_items`,
    );
    return { employeeProfileId, managerProfileId, rosterVersionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function proveRepresentativePerformance(applicationPool, rosterVersionId) {
  const observations = [];
  const pool = instrumentPool(applicationPool, observations);
  const receipts = [];
  receipts.push(
    await capturePerformance(observations, "workforce status list", () =>
      listAuthorizedWorkforceProfiles(pool, context(fixture.operatorPrincipalId), {
        pageSize,
        status: "active",
      }),
    ),
  );
  receipts.push(
    await capturePerformance(observations, "workforce direct reports", () =>
      listAuthorizedWorkforceProfiles(pool, context(fixture.managerPrincipalId), {
        pageSize,
      }),
    ),
  );
  receipts.push(
    await capturePerformance(observations, "shift roster", () =>
      listAuthorizedShiftAssignments(pool, context(fixture.operatorPrincipalId), {
        mode: "roster",
        pageSize,
        rosterVersionId,
        status: "active",
      }),
    ),
  );
  receipts.push(
    await capturePerformance(observations, "timesheet own list", () =>
      listOwnTimesheets(pool, context(fixture.employmentEmployeePrincipalId), {
        pageSize,
      }),
    ),
  );
  receipts.push(
    await capturePerformance(observations, "timesheet assigned list", () =>
      listAssignedTimesheets(pool, context(fixture.managerPrincipalId), {
        pageSize,
      }),
    ),
  );
  receipts.push(
    await capturePerformance(observations, "expense own list", () =>
      listOwnExpenseClaims(pool, context(fixture.employmentEmployeePrincipalId), {
        pageSize,
      }),
    ),
  );
  receipts.push(
    await capturePerformance(observations, "expense assigned list", () =>
      listAssignedExpenseClaims(pool, context(fixture.managerPrincipalId), {
        pageSize,
      }),
    ),
  );
  return receipts;
}

async function schemaSnapshot(pool) {
  const [columns, constraints, enums, indexes, policies, routines, rowSecurity, triggers] =
    await Promise.all([
      pool.query(
        `SELECT table_name,column_name,ordinal_position,data_type,udt_name,
                is_nullable,column_default
         FROM information_schema.columns
         WHERE table_schema='public'
         ORDER BY table_name,ordinal_position`,
      ),
      pool.query(
        `SELECT relation.relname table_name,constraint_record.conname,
                pg_get_constraintdef(constraint_record.oid,true) definition
         FROM pg_constraint constraint_record
         JOIN pg_class relation ON relation.oid=constraint_record.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public'
         ORDER BY relation.relname,constraint_record.conname`,
      ),
      pool.query(
        `SELECT type_record.typname,enum_record.enumsortorder,enum_record.enumlabel
         FROM pg_enum enum_record
         JOIN pg_type type_record ON type_record.oid=enum_record.enumtypid
         JOIN pg_namespace namespace ON namespace.oid=type_record.typnamespace
         WHERE namespace.nspname='public'
         ORDER BY type_record.typname,enum_record.enumsortorder`,
      ),
      pool.query(
        `SELECT relation.relname table_name,index_record.relname index_name,
                pg_get_indexdef(index_record.oid) definition
         FROM pg_index selected
         JOIN pg_class relation ON relation.oid=selected.indrelid
         JOIN pg_class index_record ON index_record.oid=selected.indexrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public'
         ORDER BY relation.relname,index_record.relname`,
      ),
      pool.query(
        `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
         FROM pg_policies WHERE schemaname='public'
         ORDER BY tablename,policyname`,
      ),
      pool.query(
        `SELECT routine.proname,pg_get_function_identity_arguments(routine.oid) arguments,
                pg_get_functiondef(routine.oid) definition
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
         WHERE namespace.nspname='public'
         ORDER BY routine.proname,arguments`,
      ),
      pool.query(
        `SELECT relation.relname,relation.relrowsecurity,relation.relforcerowsecurity
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public' AND relation.relkind IN ('r','p')
         ORDER BY relation.relname`,
      ),
      pool.query(
        `SELECT relation.relname table_name,trigger_record.tgname,
                pg_get_triggerdef(trigger_record.oid,true) definition
         FROM pg_trigger trigger_record
         JOIN pg_class relation ON relation.oid=trigger_record.tgrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public' AND NOT trigger_record.tgisinternal
         ORDER BY relation.relname,trigger_record.tgname`,
      ),
    ]);
  return sha256(
    JSON.stringify({
      columns: columns.rows,
      constraints: constraints.rows,
      enums: enums.rows,
      indexes: indexes.rows,
      policies: policies.rows,
      routines: routines.rows,
      rowSecurity: rowSecurity.rows,
      triggers: triggers.rows,
    }),
  );
}

async function dataSnapshot(pool) {
  const selected = await pool.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname='public' ORDER BY tablename`,
  );
  const tables = [];
  for (const { tablename } of selected.rows) {
    if (typeof tablename !== "string") throw new Error("Invalid table catalogue row");
    const rows = await pool.query(
      `SELECT row_to_json(selected_row)::text row_json
       FROM ${safeIdentifier(tablename)} selected_row
       ORDER BY row_to_json(selected_row)::text`,
    );
    const digest = createHash("sha256");
    for (const row of rows.rows) digest.update(`${row.row_json}\n`);
    tables.push({
      rowCount: rows.rowCount,
      rowDigest: digest.digest("hex"),
      tableName: tablename,
    });
  }
  return { digest: sha256(JSON.stringify(tables)), tables };
}

async function proveBackupRestore(migrationConnectionString, applicationConnectionString) {
  let root;
  let rootIdentity;
  let migrationPool;
  let restoredMigrationPool;
  let restoredApplicationPool;
  const superConnectionString = databaseUrlFor(migrationConnectionString, "postgres", "postgres");
  const sourceSuperUrl = databaseUrlFor(migrationConnectionString, undefined, "postgres");
  const restoredMigrationUrl = databaseUrlFor(migrationConnectionString, restoreDatabaseName);
  const restoredSuperUrl = databaseUrlFor(
    migrationConnectionString,
    restoreDatabaseName,
    "postgres",
  );
  const restoredApplicationUrl = databaseUrlFor(applicationConnectionString, restoreDatabaseName);
  const superPool = createDatabasePool(superConnectionString, { max: 1 });
  try {
    root = await mkdtemp(join(tmpdir(), "esbla-hr-full-x1-"));
    await chmod(root, 0o700);
    root = await realpath(root);
    rootIdentity = await lstat(root);
    assert.equal(rootIdentity.isDirectory(), true, "Qualification root must be a directory");
    assert.equal(rootIdentity.isSymbolicLink(), false, "Qualification root must not be a symlink");
    assert.equal(rootIdentity.uid, process.getuid?.(), "Qualification root owner must match");
    assert.equal(rootIdentity.mode & 0o777, 0o700, "Qualification root must remain private");
    const dumpPath = join(root, "hr-full-x1.pgdump");

    migrationPool = createDatabasePool(sourceSuperUrl, { max: 1 });
    const sourceSchema = await schemaSnapshot(migrationPool);
    const sourceData = await dataSnapshot(migrationPool);
    await runSanitized("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--file",
      dumpPath,
      sourceSuperUrl,
    ]);
    await superPool.query(`DROP DATABASE IF EXISTS ${safeIdentifier(restoreDatabaseName)}`);
    await superPool.query(
      `CREATE DATABASE ${safeIdentifier(restoreDatabaseName)} OWNER esbla_migrator`,
    );
    await runSanitized("pg_restore", [
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--dbname",
      restoredMigrationUrl,
      dumpPath,
    ]);

    restoredMigrationPool = createDatabasePool(restoredSuperUrl, { max: 1 });
    const restoredSchema = await schemaSnapshot(restoredMigrationPool);
    const restoredData = await dataSnapshot(restoredMigrationPool);
    assert.equal(restoredSchema, sourceSchema, "Restored schema digest must match");
    assert.deepEqual(restoredData, sourceData, "Restored table data must match");

    const requiredRows = supportOnly
      ? ["hr_worker_profiles", "hr_shift_assignments", "hr_timesheets", "hr_expense_claims"]
      : [
          "hr_worker_profiles",
          "hr_employment_records",
          "hr_shift_assignments",
          "hr_attendance_observations",
          "hr_leave_requests",
          "hr_timesheets",
          "hr_expense_claims",
          "evidence_events",
          "outbox_events",
          "work_items",
        ];
    for (const tableName of requiredRows) {
      const table = restoredData.tables.find((entry) => entry.tableName === tableName);
      assert.ok(table?.rowCount > 0, `${tableName} must survive backup and restore`);
    }

    restoredApplicationPool = createDatabasePool(restoredApplicationUrl, { max: 1 });
    const denied = await restoredApplicationPool.query(
      "SELECT count(*)::integer row_count FROM hr_worker_profiles",
    );
    assert.equal(denied.rows[0]?.row_count, 0, "Restored application access must fail closed");
    const applicationClient = await restoredApplicationPool.connect();
    try {
      await applicationClient.query("BEGIN");
      await applicationClient.query("SELECT set_config('app.tenant_id',$1,true)", [
        fixture.tenantId,
      ]);
      const scoped = await applicationClient.query(
        "SELECT count(*)::integer row_count FROM hr_worker_profiles WHERE tenant_id=$1",
        [fixture.tenantId],
      );
      assert.ok(scoped.rows[0]?.row_count >= representativeRows);
      await applicationClient.query("ROLLBACK");
    } finally {
      applicationClient.release();
    }
    return {
      dataDigest: sourceData.digest,
      restoredTables: restoredData.tables.length,
      schemaDigest: sourceSchema,
    };
  } finally {
    await restoredApplicationPool?.end().catch(() => undefined);
    await restoredMigrationPool?.end().catch(() => undefined);
    await migrationPool?.end().catch(() => undefined);
    await superPool
      .query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [restoreDatabaseName],
      )
      .catch(() => undefined);
    await superPool
      .query(`DROP DATABASE IF EXISTS ${safeIdentifier(restoreDatabaseName)}`)
      .catch(() => undefined);
    await superPool.end();
    if (root && rootIdentity) {
      const canonical = await realpath(root);
      const current = await lstat(root);
      assert.equal(canonical, root, "Qualification root path changed");
      assert.equal(current.dev, rootIdentity.dev, "Qualification root device changed");
      assert.equal(current.ino, rootIdentity.ino, "Qualification root inode changed");
      assert.equal(current.uid, rootIdentity.uid, "Qualification root owner changed");
      assert.equal(current.mode, rootIdentity.mode, "Qualification root mode changed");
      assert.equal(current.isSymbolicLink(), false, "Qualification root became a symlink");
      await rm(root, { force: false, recursive: true });
    }
  }
}

const migrationConnectionString = requiredEnvironment("DATABASE_MIGRATION_URL");
const applicationConnectionString = requiredEnvironment("DATABASE_URL");
await assertEphemeralConnections(migrationConnectionString, applicationConnectionString);

if (!supportOnly) {
  await import("../browser/hr-leave-stack.mjs");
  if (process.exitCode) throw new Error("Integrated HR browser qualification failed");
} else {
  await seedHrLeaveFixture();
}

const migrationPool = createDatabasePool(migrationConnectionString, { max: 2 });
const applicationPool = createDatabasePool(applicationConnectionString, { max: 4 });
let performance;
try {
  const { rosterVersionId } = await seedRepresentativeRows(migrationPool);
  performance = await proveRepresentativePerformance(applicationPool, rosterVersionId);
} finally {
  await applicationPool.end();
  await migrationPool.end();
}
const backupRestore = await proveBackupRestore(
  migrationConnectionString,
  applicationConnectionString,
);

console.log(
  JSON.stringify({
    backupRestore,
    browserScenarios: supportOnly ? 0 : 17,
    cannotClaim: [
      "FULL-X1 terminal",
      "PostgreSQL daemon restart",
      "release",
      "deployment",
      "production",
      "human acceptance",
    ],
    performance,
    proofClass: supportOnly ? "FULL_X1_SUPPORT_ONLY" : "FULL_X1_REPOSITORY_CANDIDATE",
    representativeRows,
    status: supportOnly
      ? "HR_FULL_X1_SUPPORT_CHECK_GREEN"
      : "HR_FULL_X1_REPOSITORY_QUALIFICATION_GREEN",
  }),
);
