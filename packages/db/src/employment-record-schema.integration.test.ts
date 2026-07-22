import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabasePool } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const ids = {
  actor: "14000000-0000-4000-8000-000000000001",
  correlation: "54000000-0000-4000-8000-000000000001",
  historicalActor: "14000000-0000-4000-8000-000000000003",
  historicalMembership: "24000000-0000-4000-8000-000000000003",
  historicalTenant: "06000000-0000-4000-8000-000000000003",
  membership: "24000000-0000-4000-8000-000000000001",
  otherMembership: "24000000-0000-4000-8000-000000000002",
  otherPrincipal: "14000000-0000-4000-8000-000000000002",
  otherTenant: "06000000-0000-4000-8000-000000000002",
  tenant: "06000000-0000-4000-8000-000000000001",
} as const;

let applicationRole: string;
let historicalWorkerProfileId: string;
let migrationPool: Pool;
let pool: Pool;
let otherWorkerProfileId: string;
let workerProfileId: string;

async function tenantTransaction<T>(
  source: Pool,
  tenantId: string,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await source.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [actorId]);
    await client.query("SELECT set_config('app.correlation_id', $1, true)", [ids.correlation]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createActiveWorker(tenantId: string, principalId: string): Promise<string> {
  return await tenantTransaction(migrationPool, tenantId, principalId, async (client) => {
    const created = await client.query<{ worker_profile_id: string }>(
      "INSERT INTO hr_worker_profiles (tenant_id) VALUES ($1) RETURNING worker_profile_id::text",
      [tenantId],
    );
    const workerId = created.rows[0]?.worker_profile_id;
    if (!workerId) throw new Error("Worker profile identifier was unavailable");
    await client.query(
      `UPDATE hr_worker_profiles SET principal_id=$3, row_version=2
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [tenantId, workerId, principalId],
    );
    await client.query(
      `UPDATE hr_worker_profiles SET workforce_status='active', row_version=3
       WHERE tenant_id=$1 AND worker_profile_id=$2`,
      [tenantId, workerId],
    );
    return workerId;
  });
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  await expect(operation()).rejects.toMatchObject(expected);
}

beforeAll(async () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE ?? "";
  if (!runtimeUrl || !migrationUrl || !/^[a-z_][a-z0-9_]*$/.test(applicationRole)) {
    throw new Error("PostgreSQL harness environment is required");
  }

  migrationPool = createDatabasePool(migrationUrl, { max: 2 });
  await migrateDatabase(createDatabase(migrationPool));
  pool = createDatabasePool(runtimeUrl, { max: 4 });
  await migrationPool.query(`GRANT SELECT, UPDATE ON service_activations TO ${applicationRole}`);

  await migrationPool.query(
    `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Employment Tenant'),
       ($2, 'Other Employment Tenant'), ($3, 'Historical Employment Tenant')`,
    [ids.tenant, ids.otherTenant, ids.historicalTenant],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id, display_name) VALUES ($1, 'Employment Actor'),
       ($2, 'Other Employment Actor'), ($3, 'Historical Employment Actor')`,
    [ids.actor, ids.otherPrincipal, ids.historicalActor],
  );
  await tenantTransaction(migrationPool, ids.tenant, ids.actor, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'tenant_admin')`,
      [ids.membership, ids.tenant, ids.actor],
    );
    await client.query(
      `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
       VALUES ($1, $2, 'hr.employment.configure_service')`,
      [ids.tenant, ids.actor],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1),
              ($1, 'employment_record', 'active', 1)`,
      [ids.tenant],
    );
  });
  await tenantTransaction(migrationPool, ids.otherTenant, ids.otherPrincipal, async (client) => {
    await client.query(
      `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'hr_operator')`,
      [ids.otherMembership, ids.otherTenant, ids.otherPrincipal],
    );
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1),
              ($1, 'employment_record', 'active', 1)`,
      [ids.otherTenant],
    );
  });
  await tenantTransaction(
    migrationPool,
    ids.historicalTenant,
    ids.historicalActor,
    async (client) => {
      await client.query(
        `INSERT INTO memberships (membership_id, tenant_id, principal_id, role_key)
       VALUES ($1, $2, $3, 'hr_operator')`,
        [ids.historicalMembership, ids.historicalTenant, ids.historicalActor],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1),
              ($1, 'employment_record', 'active', 1)`,
        [ids.historicalTenant],
      );
    },
  );
  workerProfileId = await createActiveWorker(ids.tenant, ids.actor);
  otherWorkerProfileId = await createActiveWorker(ids.otherTenant, ids.otherPrincipal);
  historicalWorkerProfileId = await createActiveWorker(ids.historicalTenant, ids.historicalActor);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (migrationPool) await migrationPool.end();
});

describe("Employment Record persistence and immutability kernel", () => {
  it("installs exact tenant-isolated tables, indexes, and least-privilege access", async () => {
    const tables = await migrationPool.query<{
      force_rls: boolean;
      name: string;
      rls: boolean;
    }>(
      `SELECT relname AS name, relrowsecurity AS rls, relforcerowsecurity AS force_rls
       FROM pg_catalog.pg_class
       WHERE oid = ANY(ARRAY[
         'public.hr_employment_record_service_control'::regclass,
         'public.hr_employment_records'::regclass,
         'public.hr_employment_record_versions'::regclass
       ]) ORDER BY relname`,
    );
    expect(tables.rows).toEqual([
      { force_rls: true, name: "hr_employment_record_service_control", rls: true },
      { force_rls: true, name: "hr_employment_record_versions", rls: true },
      { force_rls: true, name: "hr_employment_records", rls: true },
    ]);

    const enums = await migrationPool.query<{ definition: string }>(
      `SELECT typname || ':' || string_agg(enumlabel, ',' ORDER BY enumsortorder) AS definition
       FROM pg_catalog.pg_type JOIN pg_catalog.pg_enum ON enumtypid=pg_type.oid
       WHERE typname = ANY($1::text[]) GROUP BY typname ORDER BY typname`,
      [["hr_employment_record_status", "hr_employment_version_kind"]],
    );
    expect(enums.rows.map(({ definition }) => definition)).toEqual([
      "hr_employment_record_status:draft,active,ended",
      "hr_employment_version_kind:effective,end",
    ]);

    const indexes = await migrationPool.query<{ name: string }>(
      `SELECT indexname AS name FROM pg_catalog.pg_indexes
       WHERE schemaname='public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
      [
        [
          "idx_hr_employment_record_versions_tenant_record_cursor",
          "idx_hr_employment_records_tenant_cursor",
          "idx_hr_employment_records_tenant_order_cursor",
          "idx_hr_employment_records_tenant_worker_active_head",
          "uq_hr_employment_record_service_control_tenant_key",
          "uq_hr_employment_record_versions_composite_identity",
          "uq_hr_employment_record_versions_tenant_record_version",
          "uq_hr_employment_record_versions_tenant_successor",
          "uq_hr_employment_records_tenant_worker_current",
        ],
      ],
    );
    expect(indexes.rows.map(({ name }) => name)).toEqual([
      "idx_hr_employment_record_versions_tenant_record_cursor",
      "idx_hr_employment_records_tenant_cursor",
      "idx_hr_employment_records_tenant_order_cursor",
      "idx_hr_employment_records_tenant_worker_active_head",
      "uq_hr_employment_record_service_control_tenant_key",
      "uq_hr_employment_record_versions_composite_identity",
      "uq_hr_employment_record_versions_tenant_record_version",
      "uq_hr_employment_record_versions_tenant_successor",
      "uq_hr_employment_records_tenant_worker_current",
    ]);

    const cursorIndexes = await migrationPool.query<{ definition: string; name: string }>(
      `SELECT indexname AS name, indexdef AS definition
       FROM pg_catalog.pg_indexes
       WHERE schemaname='public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [
        [
          "idx_hr_employment_records_tenant_cursor",
          "idx_hr_employment_records_tenant_order_cursor",
        ],
      ],
    );
    expect(cursorIndexes.rows).toEqual([
      {
        definition:
          "CREATE INDEX idx_hr_employment_records_tenant_cursor ON public.hr_employment_records USING btree (tenant_id, worker_profile_id, created_at DESC NULLS LAST, employment_record_id DESC NULLS LAST)",
        name: "idx_hr_employment_records_tenant_cursor",
      },
      {
        definition:
          "CREATE INDEX idx_hr_employment_records_tenant_order_cursor ON public.hr_employment_records USING btree (tenant_id, created_at DESC NULLS LAST, employment_record_id DESC NULLS LAST)",
        name: "idx_hr_employment_records_tenant_order_cursor",
      },
    ]);

    const privileges = await migrationPool.query<{
      delete: boolean;
      insert: boolean;
      name: string;
      select: boolean;
      truncate: boolean;
      update: boolean;
    }>(
      `SELECT table_name AS name,
              has_table_privilege($1, table_name, 'SELECT') AS select,
              has_table_privilege($1, table_name, 'INSERT') AS insert,
              has_table_privilege($1, table_name, 'UPDATE') AS update,
              has_table_privilege($1, table_name, 'DELETE') AS delete,
              has_table_privilege($1, table_name, 'TRUNCATE') AS truncate
       FROM unnest($2::text[]) table_name ORDER BY table_name`,
      [
        applicationRole,
        [
          "hr_employment_record_service_control",
          "hr_employment_record_versions",
          "hr_employment_records",
        ],
      ],
    );
    expect(privileges.rows).toEqual([
      {
        delete: false,
        insert: false,
        name: "hr_employment_record_service_control",
        select: true,
        truncate: false,
        update: false,
      },
      {
        delete: false,
        insert: true,
        name: "hr_employment_record_versions",
        select: true,
        truncate: false,
        update: false,
      },
      {
        delete: false,
        insert: true,
        name: "hr_employment_records",
        select: true,
        truncate: false,
        update: true,
      },
    ]);
  });

  it("preserves an immutable same-root version chain and exact root head", async () => {
    const chain = await tenantTransaction(pool, ids.tenant, ids.actor, async (client) => {
      const root = await client.query<{ employment_record_id: string }>(
        `INSERT INTO hr_employment_records (tenant_id, worker_profile_id)
         VALUES ($1, $2) RETURNING employment_record_id::text`,
        [ids.tenant, workerProfileId],
      );
      const employmentRecordId = root.rows[0]?.employment_record_id;
      expect(employmentRecordId).toBeTruthy();

      const first = await client.query<{ employment_record_version_id: string }>(
        `INSERT INTO hr_employment_record_versions
           (tenant_id, employment_record_id, worker_profile_id, effective_from,
            effective_to, employment_type_code, version, version_kind)
         VALUES ($1, $2, $3, '2026-01-01', '2026-03-31', 'standard', 1, 'effective')
         RETURNING employment_record_version_id::text`,
        [ids.tenant, employmentRecordId, workerProfileId],
      );
      const firstVersionId = first.rows[0]?.employment_record_version_id;
      await client.query(
        `UPDATE hr_employment_records
         SET status='active', current_version_id=$3, row_version=2
         WHERE tenant_id=$1 AND employment_record_id=$2`,
        [ids.tenant, employmentRecordId, firstVersionId],
      );

      const second = await client.query<{ employment_record_version_id: string }>(
        `INSERT INTO hr_employment_record_versions
           (tenant_id, employment_record_id, worker_profile_id, effective_from,
            organization_reference, supersedes_version_id, version, version_kind)
         VALUES ($1, $2, $3, '2026-04-01', 'org-a', $4, 2, 'effective')
         RETURNING employment_record_version_id::text`,
        [ids.tenant, employmentRecordId, workerProfileId, firstVersionId],
      );
      const secondVersionId = second.rows[0]?.employment_record_version_id;
      await client.query(
        `UPDATE hr_employment_records SET current_version_id=$3, row_version=3
         WHERE tenant_id=$1 AND employment_record_id=$2`,
        [ids.tenant, employmentRecordId, secondVersionId],
      );

      await client.query("SAVEPOINT open_ended_successor_rejection");
      try {
        await expectDatabaseError(
          () =>
            client.query(
              `INSERT INTO hr_employment_record_versions
                 (tenant_id, employment_record_id, worker_profile_id, effective_from,
                  supersedes_version_id, version, version_kind)
               VALUES ($1, $2, $3, '2026-07-01', $4, 3, 'effective')`,
              [ids.tenant, employmentRecordId, workerProfileId, secondVersionId],
            ),
          { code: "55000", message: "open-ended employment record head cannot be superseded" },
        );
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT open_ended_successor_rejection");
      }

      const ended = await client.query<{ employment_record_version_id: string }>(
        `INSERT INTO hr_employment_record_versions
           (tenant_id, employment_record_id, worker_profile_id, effective_from, effective_to,
            organization_reference, supersedes_version_id, version, version_kind, terminal_version)
         VALUES ($1, $2, $3, '2026-04-01', '2026-06-30', 'org-a', $4, 3, 'end', true)
         RETURNING employment_record_version_id::text`,
        [ids.tenant, employmentRecordId, workerProfileId, secondVersionId],
      );
      const endedVersionId = ended.rows[0]?.employment_record_version_id;
      await client.query(
        `UPDATE hr_employment_records
         SET status='ended', current_version_id=$3, row_version=4
         WHERE tenant_id=$1 AND employment_record_id=$2`,
        [ids.tenant, employmentRecordId, endedVersionId],
      );

      const state = await client.query(
        `SELECT record.status, record.row_version, version.version, version.version_kind,
                version.terminal_version
         FROM hr_employment_records record
         JOIN hr_employment_record_versions version
           ON version.tenant_id=record.tenant_id
          AND version.employment_record_id=record.employment_record_id
          AND version.employment_record_version_id=record.current_version_id
         WHERE record.tenant_id=$1 AND record.employment_record_id=$2`,
        [ids.tenant, employmentRecordId],
      );
      expect(state.rows).toEqual([
        {
          row_version: 4,
          status: "ended",
          terminal_version: true,
          version: 3,
          version_kind: "end",
        },
      ]);
      return { employmentRecordId: employmentRecordId ?? "", firstVersionId: firstVersionId ?? "" };
    });

    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `UPDATE hr_employment_record_versions SET position_reference='changed'
             WHERE tenant_id=$1 AND employment_record_version_id=$2`,
            [ids.tenant, chain.firstVersionId],
          ),
        ),
      { code: "42501" },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(migrationPool, ids.tenant, ids.actor, (client) =>
          client.query(
            `UPDATE hr_employment_record_versions SET position_reference='changed'
             WHERE tenant_id=$1 AND employment_record_version_id=$2`,
            [ids.tenant, chain.firstVersionId],
          ),
        ),
      { code: "55000", message: "employment record versions are append-only" },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `UPDATE hr_employment_records SET row_version=5
             WHERE tenant_id=$1 AND employment_record_id=$2`,
            [ids.tenant, chain.employmentRecordId],
          ),
        ),
      { code: "55000", message: "ended employment records are immutable" },
    );

    await tenantTransaction(pool, ids.tenant, ids.actor, async (client) => {
      const replacement = await client.query<{ employment_record_id: string }>(
        `INSERT INTO hr_employment_records (tenant_id, worker_profile_id)
         VALUES ($1, $2) RETURNING employment_record_id::text`,
        [ids.tenant, workerProfileId],
      );
      expect(replacement.rows[0]?.employment_record_id).toBeTruthy();
    });

    const hidden = await tenantTransaction(pool, ids.otherTenant, ids.otherPrincipal, (client) =>
      client.query("SELECT * FROM hr_employment_records"),
    );
    expect(hidden.rows).toEqual([]);
  });

  it("synchronizes activation and permits only guarded tenant-admin settings revisions", async () => {
    const initial = await tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
      client.query(
        `SELECT settings_version, row_version
         FROM hr_employment_record_service_control
         WHERE tenant_id=$1 AND service_key='employment_record'`,
        [ids.tenant],
      ),
    );
    expect(initial.rows).toEqual([{ row_version: 1, settings_version: 1 }]);

    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `UPDATE hr_employment_record_service_control SET settings_version=2, row_version=2
             WHERE tenant_id=$1`,
            [ids.tenant],
          ),
        ),
      { code: "42501" },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            "SELECT public.esbla_configure_hr_employment_record_settings(1, 'unspecified', true)",
          ),
        ),
      { code: "22023" },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            "SELECT public.esbla_configure_hr_employment_record_settings(1, 'unspecified,,fixed', false)",
          ),
        ),
      { code: "22023" },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherPrincipal, (client) =>
          client.query(
            "SELECT public.esbla_configure_hr_employment_record_settings(1, 'unspecified', false)",
          ),
        ),
      { code: "42501" },
    );

    const configured = await tenantTransaction(pool, ids.tenant, ids.actor, async (client) => {
      await client.query(
        "SELECT public.esbla_configure_hr_employment_record_settings(1, 'unspecified,Fixed Term', false)",
      );
      return await client.query(
        `SELECT control.settings_version, control.row_version,
                jsonb_object_agg(setting.setting_key, setting.value ORDER BY setting.setting_key)
                  AS settings
         FROM hr_employment_record_service_control control
         JOIN tenant_settings setting ON setting.tenant_id=control.tenant_id
         WHERE control.tenant_id=$1 AND control.service_key='employment_record'
           AND setting.setting_key IN (
             'hr.employment_record.employment_type_codes',
             'hr.employment_record.effective_range_overlap_allowed'
           )
         GROUP BY control.settings_version, control.row_version`,
        [ids.tenant],
      );
    });
    expect(configured.rows).toEqual([
      {
        row_version: 2,
        settings: {
          "hr.employment_record.effective_range_overlap_allowed": false,
          "hr.employment_record.employment_type_codes": "unspecified,Fixed Term",
        },
        settings_version: 2,
      },
    ]);
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            "SELECT public.esbla_configure_hr_employment_record_settings(1, 'unspecified', false)",
          ),
        ),
      { code: "40001" },
    );

    const lifecycle = await tenantTransaction(
      pool,
      ids.otherTenant,
      ids.otherPrincipal,
      async (client) => {
        await client.query(
          `UPDATE service_activations SET state='inactive', version=2
           WHERE tenant_id=$1 AND service_key='employment_record'`,
          [ids.otherTenant],
        );
        await client.query(
          `UPDATE service_activations SET state='active', version=3
           WHERE tenant_id=$1 AND service_key='employment_record'`,
          [ids.otherTenant],
        );
        return await client.query(
          `SELECT settings_version, row_version
           FROM hr_employment_record_service_control
           WHERE tenant_id=$1 AND service_key='employment_record'`,
          [ids.otherTenant],
        );
      },
    );
    expect(lifecycle.rows).toEqual([{ row_version: 3, settings_version: 1 }]);
  });

  it("rejects a successor that overlaps any immutable pre-migration effective version", async () => {
    let employmentRecordId = "";
    await migrationPool.query(
      `ALTER TABLE hr_employment_record_versions
       DISABLE TRIGGER hr_employment_record_versions_enforce_state`,
    );
    try {
      employmentRecordId = await tenantTransaction(
        migrationPool,
        ids.historicalTenant,
        ids.historicalActor,
        async (client) => {
          const root = await client.query<{ employment_record_id: string }>(
            `INSERT INTO hr_employment_records (tenant_id, worker_profile_id)
             VALUES ($1,$2) RETURNING employment_record_id::text`,
            [ids.historicalTenant, historicalWorkerProfileId],
          );
          const recordId = root.rows[0]?.employment_record_id ?? "";
          const first = await client.query<{ employment_record_version_id: string }>(
            `INSERT INTO hr_employment_record_versions
               (tenant_id,employment_record_id,worker_profile_id,effective_from,effective_to,
                version,version_kind)
             VALUES ($1,$2,$3,'2026-01-01','2026-12-31',1,'effective')
             RETURNING employment_record_version_id::text`,
            [ids.historicalTenant, recordId, historicalWorkerProfileId],
          );
          await client.query(
            `UPDATE hr_employment_records SET status='active',current_version_id=$3,row_version=2
             WHERE tenant_id=$1 AND employment_record_id=$2`,
            [ids.historicalTenant, recordId, first.rows[0]?.employment_record_version_id],
          );
          const second = await client.query<{ employment_record_version_id: string }>(
            `INSERT INTO hr_employment_record_versions
               (tenant_id,employment_record_id,worker_profile_id,effective_from,effective_to,
                supersedes_version_id,version,version_kind)
             VALUES ($1,$2,$3,'2026-02-01','2026-03-31',$4,2,'effective')
             RETURNING employment_record_version_id::text`,
            [
              ids.historicalTenant,
              recordId,
              historicalWorkerProfileId,
              first.rows[0]?.employment_record_version_id,
            ],
          );
          await client.query(
            `UPDATE hr_employment_records SET current_version_id=$3,row_version=3
             WHERE tenant_id=$1 AND employment_record_id=$2`,
            [ids.historicalTenant, recordId, second.rows[0]?.employment_record_version_id],
          );
          return recordId;
        },
      );
    } finally {
      await migrationPool.query(
        `ALTER TABLE hr_employment_record_versions
         ENABLE TRIGGER hr_employment_record_versions_enforce_state`,
      );
    }

    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.historicalTenant, ids.historicalActor, (client) =>
          client.query(
            `INSERT INTO hr_employment_record_versions
               (tenant_id,employment_record_id,worker_profile_id,effective_from,effective_to,
                supersedes_version_id,version,version_kind)
             SELECT $1,$2,$3,'2026-04-01','2026-05-31',current_version_id,3,'effective'
             FROM hr_employment_records WHERE tenant_id=$1 AND employment_record_id=$2`,
            [ids.historicalTenant, employmentRecordId, historicalWorkerProfileId],
          ),
        ),
      { code: "55000", message: "employment record effective ranges cannot overlap" },
    );
  });

  it("fails closed on cross-tenant roots, invalid versions, and competing successors", async () => {
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.tenant, ids.actor, (client) =>
          client.query(
            `INSERT INTO hr_employment_records (tenant_id, worker_profile_id)
             VALUES ($1, $2)`,
            [ids.tenant, otherWorkerProfileId],
          ),
        ),
      { code: "23503", constraint: "hr_employment_records_worker_same_tenant_fk" },
    );

    const employmentRecordId = await tenantTransaction(
      pool,
      ids.otherTenant,
      ids.otherPrincipal,
      async (client) => {
        const root = await client.query<{ employment_record_id: string }>(
          `INSERT INTO hr_employment_records (tenant_id, worker_profile_id)
         VALUES ($1, $2) RETURNING employment_record_id::text`,
          [ids.otherTenant, otherWorkerProfileId],
        );
        return root.rows[0]?.employment_record_id ?? "";
      },
    );
    expect(employmentRecordId).toBeTruthy();
    const firstVersionId = await tenantTransaction(
      pool,
      ids.otherTenant,
      ids.otherPrincipal,
      async (client) => {
        const first = await client.query<{ employment_record_version_id: string }>(
          `INSERT INTO hr_employment_record_versions
           (tenant_id, employment_record_id, worker_profile_id, effective_from,
            effective_to, version, version_kind)
         VALUES ($1, $2, $3, '2026-01-01', '2026-01-31', 1, 'effective')
         RETURNING employment_record_version_id::text`,
          [ids.otherTenant, employmentRecordId, otherWorkerProfileId],
        );
        const firstVersionId = first.rows[0]?.employment_record_version_id;
        await client.query(
          `UPDATE hr_employment_records
         SET status='active', current_version_id=$3, row_version=2
         WHERE tenant_id=$1 AND employment_record_id=$2`,
          [ids.otherTenant, employmentRecordId, firstVersionId],
        );
        return firstVersionId ?? "";
      },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherPrincipal, (client) =>
          client.query(
            `INSERT INTO hr_employment_record_versions
               (tenant_id, employment_record_id, worker_profile_id, effective_from, effective_to,
                supersedes_version_id, version, version_kind)
             VALUES ($1, $2, $3, '2026-01-31', '2026-02-15', $4, 2, 'effective')`,
            [ids.otherTenant, employmentRecordId, otherWorkerProfileId, firstVersionId],
          ),
        ),
      { code: "55000", message: "employment record successor must begin after its predecessor" },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherPrincipal, (client) =>
          client.query(
            `INSERT INTO hr_employment_record_versions
               (tenant_id, employment_record_id, worker_profile_id, effective_from, effective_to,
                supersedes_version_id, version, version_kind)
             VALUES ($1, $2, $3, '2026-02-01', '2026-01-31', $4, 2, 'effective')`,
            [ids.otherTenant, employmentRecordId, otherWorkerProfileId, firstVersionId],
          ),
        ),
      { code: "23514", constraint: "hr_employment_record_versions_effective_range_valid" },
    );
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherPrincipal, (client) =>
          client.query(
            `INSERT INTO hr_employment_record_versions
               (tenant_id, employment_record_id, worker_profile_id, effective_from,
                supersedes_version_id, version, version_kind)
             VALUES ($1, $2, $3, '2026-02-01', $4, 2, 'effective')`,
            [ids.otherTenant, employmentRecordId, otherWorkerProfileId, firstVersionId],
          ),
        ),
      { code: "55000", message: "employment record version is not linked to the current head" },
    );
    const secondVersionId = await tenantTransaction(
      pool,
      ids.otherTenant,
      ids.otherPrincipal,
      async (client) => {
        const second = await client.query<{ employment_record_version_id: string }>(
          `INSERT INTO hr_employment_record_versions
           (tenant_id, employment_record_id, worker_profile_id, effective_from,
            supersedes_version_id, version, version_kind)
         VALUES ($1, $2, $3, '2026-02-01', $4, 2, 'effective')
         RETURNING employment_record_version_id::text`,
          [ids.otherTenant, employmentRecordId, otherWorkerProfileId, firstVersionId],
        );
        await client.query(
          `UPDATE hr_employment_records SET current_version_id=$3, row_version=3
         WHERE tenant_id=$1 AND employment_record_id=$2`,
          [ids.otherTenant, employmentRecordId, second.rows[0]?.employment_record_version_id],
        );
        return second.rows[0]?.employment_record_version_id ?? "";
      },
    );
    expect(secondVersionId).toBeTruthy();
    await expectDatabaseError(
      () =>
        tenantTransaction(pool, ids.otherTenant, ids.otherPrincipal, (client) =>
          client.query(
            `INSERT INTO hr_employment_record_versions
               (tenant_id, employment_record_id, worker_profile_id, effective_from,
                supersedes_version_id, version, version_kind)
             VALUES ($1, $2, $3, '2026-03-01', $4, 3, 'effective')`,
            [ids.otherTenant, employmentRecordId, otherWorkerProfileId, firstVersionId],
          ),
        ),
      {
        code: "55000",
        message: "employment record predecessor is not current",
      },
    );

    await expectDatabaseError(
      () => migrationPool.query("TRUNCATE hr_employment_record_versions CASCADE"),
      { code: "55000" },
    );
  });
});
