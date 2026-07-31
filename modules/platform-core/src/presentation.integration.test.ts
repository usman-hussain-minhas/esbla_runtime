import { createHash, randomUUID } from "node:crypto";
import { createDatabase, createDatabasePool, migrateDatabase } from "@esbla/db";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformError } from "./errors.js";
import {
  getOwnPresentationNavigation,
  getOwnPresentationPersonalSurfaceEditorWorkspace,
  getOwnPresentationPreferences,
  getOwnPresentationServiceGroups,
  getOwnPresentationShortcuts,
  getOwnPresentationSurfaceLayout,
  getTenantPresentationSurfaceBaseWorkspace,
  publishTenantPresentationSurfaceDraft,
  resetOwnPresentationPreferences,
  resetOwnPresentationSurfaceOverlay,
  resetTenantPresentationDefaults,
  rollbackTenantPresentationSurfaceBase,
  updateOwnPresentationPreferences,
  updateOwnPresentationShortcut,
  updateOwnPresentationSurfaceOverlay,
  updateTenantPresentationDefaults,
  upsertTenantPresentationSurfaceDraft,
  validateTenantPresentationSurfaceDraft,
} from "./presentation.js";

const ids = {
  actorA: "91000000-0000-4000-8000-000000000001",
  actorAdminA: "91000000-0000-4000-8000-000000000003",
  actorB: "91000000-0000-4000-8000-000000000002",
  membershipA: "92000000-0000-4000-8000-000000000001",
  membershipAdminA: "92000000-0000-4000-8000-000000000003",
  membershipB: "92000000-0000-4000-8000-000000000002",
  tenantA: "90000000-0000-4000-8000-000000000001",
  tenantB: "90000000-0000-4000-8000-000000000002",
} as const;

let migrationPool: Pool;
let pool: Pool;

function context(tenantId: string, actorPrincipalId: string, correlationId = randomUUID()) {
  return { actorPrincipalId, correlationId, tenantId };
}

async function presentationRows<T extends Record<string, unknown>>(
  tenantId: string,
  actorPrincipalId: string,
  statement: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [actorPrincipalId]);
    const result = await client.query<T>(statement, [...values]);
    await client.query("ROLLBACK");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function shortcutProofSnapshot(tenantId: string, actorPrincipalId: string) {
  const rows = await presentationRows<{
    evidence_rows: string;
    outbox_rows: string;
    patch_row: string | null;
  }>(
    tenantId,
    actorPrincipalId,
    `SELECT
       (
         SELECT jsonb_build_object(
           'tenantId',tenant_id,
           'principalId',principal_id,
           'settingKey',setting_key,
           'contextKind',context_kind,
           'contextId',context_id,
           'patch',patch,
           'version',version,
           'updatedByPrincipalId',updated_by_principal_id,
           'updatedAt',updated_at
         )::text
         FROM presentation_shortcut_user_patches
         WHERE tenant_id = $1 AND principal_id = $2
           AND setting_key = 'navigation.universal_shortcuts.v1'
           AND context_kind = 'global' AND context_id = 'global'
       ) AS patch_row,
       (
         SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'evidenceEventId',evidence_event_id,
               'eventType',event_type,
               'subjectType',subject_type,
               'subjectId',subject_id,
               'actorPrincipalId',actor_principal_id,
               'correlationId',correlation_id,
               'priorState',prior_state,
               'newState',new_state,
               'occurredAt',occurred_at
             )
             ORDER BY evidence_event_id
           ),
           '[]'::jsonb
         )::text
         FROM evidence_events
         WHERE tenant_id = $1 AND subject_type = 'platform_presentation_shortcuts'
       ) AS evidence_rows,
       (
         SELECT coalesce(
           jsonb_agg(to_jsonb(outbox_events) ORDER BY event_id),
           '[]'::jsonb
         )::text
         FROM outbox_events
         WHERE tenant_id = $1 AND event_type LIKE 'platform.presentation.shortcut%'
       ) AS outbox_rows`,
    [tenantId, actorPrincipalId],
  );
  const row = rows[0];
  if (!row) throw new Error("Shortcut proof snapshot is unavailable");
  return row;
}

async function preferenceProofSnapshot(tenantId: string) {
  const result = await migrationPool.query<{
    evidence_rows: string;
    outbox_rows: string;
    setting_rows: string;
  }>(
    `SELECT
       (
         SELECT coalesce(jsonb_agg(to_jsonb(setting) ORDER BY subject_type, subject_id, setting_key),
                         '[]'::jsonb)::text
         FROM presentation_setting_values setting
         WHERE tenant_id = $1
       ) AS setting_rows,
       (
         SELECT coalesce(jsonb_agg(to_jsonb(evidence) ORDER BY evidence_event_id),
                         '[]'::jsonb)::text
         FROM evidence_events evidence
         WHERE tenant_id = $1
           AND subject_type IN (
             'platform_presentation_preferences',
             'platform_presentation_tenant_defaults'
           )
       ) AS evidence_rows,
       (
         SELECT coalesce(jsonb_agg(to_jsonb(outbox) ORDER BY event_id), '[]'::jsonb)::text
         FROM outbox_events outbox
         WHERE tenant_id = $1
           AND event_type LIKE 'platform.presentation.%preferences%'
       ) AS outbox_rows`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Preference proof snapshot is unavailable");
  return row;
}

async function insertMembership(
  tenantId: string,
  membershipId: string,
  principalId: string,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO memberships
         (membership_id, tenant_id, principal_id, role_key, status)
       VALUES ($1, $2, $3, 'employee', 'active')`,
      [membershipId, tenantId, principalId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setLeavePresentationEligibility(
  tenantId: string,
  principalId: string,
  input: { readonly active: boolean; readonly capabilities: readonly string[] },
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'hr.leave_request', $2, 1)
       ON CONFLICT (tenant_id, service_key)
       DO UPDATE SET state = EXCLUDED.state, version = service_activations.version + 1`,
      [tenantId, input.active ? "active" : "inactive"],
    );
    await client.query(
      `DELETE FROM membership_capabilities
       WHERE tenant_id = $1 AND principal_id = $2
         AND capability_id = ANY($3::text[])`,
      [
        tenantId,
        principalId,
        ["hr.leave.list_assigned", "hr.leave.list_own", "hr.leave.submit", "hr.leave.view"],
      ],
    );
    if (input.capabilities.length > 0) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1, $2, capability_id
         FROM unnest($3::text[]) AS capability(capability_id)`,
        [tenantId, principalId, input.capabilities],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setWorkforcePresentationEligibility(
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, 'workforce_profile', 'active', 1)
       ON CONFLICT (tenant_id, service_key) DO NOTHING`,
      [tenantId],
    );
    await client.query(
      `DELETE FROM membership_capabilities
       WHERE tenant_id = $1 AND principal_id = $2
         AND capability_id = ANY($3::text[])`,
      [tenantId, principalId, ["hr.workforce.view_own", "hr.workforce.view_authorized_detail"]],
    );
    if (eligible) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1, $2, capability_id
         FROM unnest($3::text[]) AS capability(capability_id)`,
        [tenantId, principalId, ["hr.workforce.view_own", "hr.workforce.view_authorized_detail"]],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setWorkforceManagerVisibility(
  tenantId: string,
  value: "minimized" | "none" | null,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (value === null) {
      await client.query(
        `DELETE FROM tenant_settings
         WHERE tenant_id = $1 AND setting_key = 'hr.workforce_profile.manager_visibility'`,
        [tenantId],
      );
    } else {
      await client.query(
        `INSERT INTO tenant_settings (tenant_id, setting_key, value_type, value, version)
         VALUES ($1, 'hr.workforce_profile.manager_visibility', 'enum', $2::jsonb, 1)
         ON CONFLICT (tenant_id, setting_key)
         DO UPDATE SET value_type = EXCLUDED.value_type, value = EXCLUDED.value,
                       version = tenant_settings.version + 1`,
        [tenantId, JSON.stringify(value)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setPresentationActorRole(
  tenantId: string,
  principalId: string,
  roleKey: string,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `UPDATE memberships
       SET role_key = $3
       WHERE tenant_id = $1 AND principal_id = $2`,
      [tenantId, principalId, roleKey],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setPresentationCapability(
  tenantId: string,
  principalId: string,
  capabilityId: string,
  enabled: boolean,
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (enabled) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [tenantId, principalId, capabilityId],
      );
    } else {
      await client.query(
        `DELETE FROM membership_capabilities
         WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = $3`,
        [tenantId, principalId, capabilityId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setSurfacePersonalization(
  tenantId: string,
  surfaceId: "surface.hr.mission-control" | "surface.mission-control",
  updatedByPrincipalId: string,
  enabled: boolean,
): Promise<void> {
  await migrationPool.query(
    "ALTER TABLE presentation_surface_settings NO FORCE ROW LEVEL SECURITY",
  );
  try {
    await migrationPool.query(
      `INSERT INTO presentation_surface_settings
         (tenant_id,surface_id,personalization_enabled,version,updated_by_principal_id)
       VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (tenant_id,surface_id)
       DO UPDATE SET personalization_enabled=EXCLUDED.personalization_enabled,
                     version=presentation_surface_settings.version+1,
                     updated_at=now(),
                     updated_by_principal_id=EXCLUDED.updated_by_principal_id`,
      [tenantId, surfaceId, enabled, updatedByPrincipalId],
    );
  } finally {
    await migrationPool.query("ALTER TABLE presentation_surface_settings FORCE ROW LEVEL SECURITY");
  }
}

function legacyCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${legacyCanonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutWidgetDefinitionVersions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWidgetDefinitionVersions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "widgetDefinitionVersion")
      .map(([key, child]) => [key, withoutWidgetDefinitionVersions(child)]),
  );
}

async function rewriteSurfaceEvidenceAsLegacyV1(
  tenantId: string,
  actorPrincipalId: string,
  evidenceEventId: string,
  legacyRequestHash?: string,
): Promise<void> {
  await migrationPool.query(
    "ALTER TABLE evidence_events DISABLE TRIGGER evidence_events_reject_update_delete",
  );
  try {
    const client = await migrationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [
        actorPrincipalId,
      ]);
      const current = await client.query<{ new_state: string }>(
        "SELECT new_state FROM evidence_events WHERE evidence_event_id = $1",
        [evidenceEventId],
      );
      const row = current.rows[0];
      if (!row) throw new Error("Surface evidence is unavailable");
      const state = withoutWidgetDefinitionVersions(JSON.parse(row.new_state)) as Record<
        string,
        unknown
      >;
      if (legacyRequestHash) state.requestHash = legacyRequestHash;
      await client.query("UPDATE evidence_events SET new_state = $2 WHERE evidence_event_id = $1", [
        evidenceEventId,
        legacyCanonicalJson(state),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await migrationPool.query(
      "ALTER TABLE evidence_events ENABLE TRIGGER evidence_events_reject_update_delete",
    );
  }
}

const studioSurfaceBaseCapabilities = [
  "platform.studio.surface_base.read",
  "platform.studio.surface_base.draft",
  "platform.studio.surface_base.validate",
  "platform.studio.surface_base.publish",
  "platform.studio.surface_base.rollback",
] as const;

async function setStudioSurfaceBaseCapabilities(
  tenantId: string,
  principalId: string,
  capabilities: readonly (typeof studioSurfaceBaseCapabilities)[number][],
): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `DELETE FROM membership_capabilities
       WHERE tenant_id = $1 AND principal_id = $2
         AND capability_id = ANY($3::text[])`,
      [tenantId, principalId, studioSurfaceBaseCapabilities],
    );
    if (capabilities.length > 0) {
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         SELECT $1, $2, capability_id
         FROM unnest($3::text[]) AS capability(capability_id)`,
        [tenantId, principalId, capabilities],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function surfaceMutationFootprint(
  tenantId: string,
  surfaceId: string,
): Promise<{
  readonly draftCount: number;
  readonly evidenceCount: number;
  readonly headBaseVersion: number | null;
  readonly headRowVersion: number | null;
  readonly overlayRows: string;
  readonly outboxCount: number;
  readonly versionCount: number;
}> {
  const result = await migrationPool.query<{
    draft_count: number;
    evidence_count: number;
    head_base_version: number | null;
    head_row_version: number | null;
    overlay_rows: string;
    outbox_count: number;
    version_count: number;
  }>(
    `SELECT
       (SELECT count(*)::integer
        FROM presentation_surface_drafts
        WHERE tenant_id = $1 AND surface_id = $2) AS draft_count,
       (SELECT count(*)::integer
        FROM presentation_surface_versions
        WHERE tenant_id = $1 AND surface_id = $2) AS version_count,
       (SELECT current_base_version
        FROM presentation_surface_heads
        WHERE tenant_id = $1 AND surface_id = $2) AS head_base_version,
       (SELECT row_version
        FROM presentation_surface_heads
        WHERE tenant_id = $1 AND surface_id = $2) AS head_row_version,
       (SELECT coalesce(
          jsonb_agg(to_jsonb(presentation_surface_overlays) ORDER BY principal_id),
          '[]'::jsonb
        )::text
        FROM presentation_surface_overlays
        WHERE tenant_id = $1 AND surface_id = $2) AS overlay_rows,
       (SELECT count(*)::integer
        FROM evidence_events
        WHERE tenant_id = $1) AS evidence_count,
       (SELECT count(*)::integer
        FROM outbox_events
        WHERE tenant_id = $1) AS outbox_count`,
    [tenantId, surfaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Surface mutation footprint query returned no row");
  return {
    draftCount: row.draft_count,
    evidenceCount: row.evidence_count,
    headBaseVersion: row.head_base_version,
    headRowVersion: row.head_row_version,
    overlayRows: row.overlay_rows,
    outboxCount: row.outbox_count,
    versionCount: row.version_count,
  };
}

async function surfaceBaseCounts(tenantId: string): Promise<{
  readonly heads: number;
  readonly versions: number;
}> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{
      heads: number;
      versions: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM presentation_surface_heads
          WHERE tenant_id = $1) AS heads,
         (SELECT count(*)::integer FROM presentation_surface_versions
          WHERE tenant_id = $1) AS versions`,
      [tenantId],
    );
    await client.query("ROLLBACK");
    const row = result.rows[0];
    if (!row) throw new Error("Surface base count query returned no row");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function waitForBackendLock(input: {
  readonly applicationRole?: string;
  readonly pid?: number;
}): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const result = await migrationPool.query<{ waiting: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM pg_catalog.pg_locks AS pending
         JOIN pg_catalog.pg_stat_activity AS activity ON activity.pid = pending.pid
         WHERE NOT pending.granted
           AND activity.datname = pg_catalog.current_database()
           AND ($1::integer IS NULL OR pending.pid = $1)
           AND ($2::text IS NULL OR activity.usename = $2)
       ) AS waiting`,
      [input.pid ?? null, input.applicationRole ?? null],
    );
    if (result.rows[0]?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function racePresentationMutationWithDeactivation<T>(
  surfaceId: "surface.mission-control" | "surface.hr.mission-control",
  mutation: () => Promise<T>,
): Promise<{
  readonly deactivationBlocked: boolean;
  readonly deactivationResult: PromiseSettledResult<void>;
  readonly mutationReachedWrite: boolean;
  readonly mutationResult: PromiseSettledResult<T>;
}> {
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (!applicationRole) throw new Error("PostgreSQL application role is unavailable");
  const blocker = await migrationPool.connect();
  let deactivator: PoolClient | undefined;
  let blockerOpen = false;
  let blockerReleased = false;
  let deactivatorOpen = false;
  let mutationPromise: Promise<T> | undefined;
  let deactivationPromise: Promise<void> | undefined;
  let mutationReachedWrite = false;
  let deactivationBlocked = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let mutationResult: PromiseSettledResult<T> = {
    reason: new Error("Presentation mutation did not start"),
    status: "rejected",
  };
  let deactivationResult: PromiseSettledResult<void> = {
    reason: new Error("Service deactivation did not start"),
    status: "rejected",
  };
  try {
    deactivator = await migrationPool.connect();
    await blocker.query("BEGIN");
    blockerOpen = true;
    await blocker.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
    await blocker.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.actorAdminA]);
    const lockedOverlay = await blocker.query(
      `SELECT version
       FROM presentation_surface_overlays
       WHERE tenant_id = $1 AND principal_id = $2 AND surface_id = $3
       FOR UPDATE`,
      [ids.tenantA, ids.actorAdminA, surfaceId],
    );
    if (lockedOverlay.rowCount !== 1) {
      throw new Error("Presentation overlay lock target is unavailable");
    }
    mutationPromise = mutation();
    mutationReachedWrite = await waitForBackendLock({ applicationRole });

    await deactivator.query("BEGIN");
    deactivatorOpen = true;
    await deactivator.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
    const backend = await deactivator.query<{ pid: number }>(
      "SELECT pg_catalog.pg_backend_pid() AS pid",
    );
    const pid = backend.rows[0]?.pid;
    if (pid === undefined) throw new Error("Deactivation backend identity is unavailable");
    deactivationPromise = (async () => {
      await deactivator.query(
        `UPDATE service_activations
         SET state = 'inactive', version = version + 1
         WHERE tenant_id = $1 AND service_key = 'hr.leave_request'`,
        [ids.tenantA],
      );
      await deactivator.query("COMMIT");
      deactivatorOpen = false;
    })();
    deactivationBlocked = await waitForBackendLock({ pid });
  } catch (error) {
    primaryError = error;
  } finally {
    if (blockerOpen) {
      try {
        await blocker.query("COMMIT");
      } catch (commitError) {
        cleanupErrors.push(commitError);
        try {
          await blocker.query("ROLLBACK");
        } catch (rollbackError) {
          cleanupErrors.push(rollbackError);
          blocker.release(
            rollbackError instanceof Error
              ? rollbackError
              : new Error("Presentation blocker rollback failed"),
          );
          blockerReleased = true;
        }
      }
      blockerOpen = false;
    }
    if (mutationPromise) {
      mutationResult = (await Promise.allSettled([mutationPromise]))[0] as PromiseSettledResult<T>;
    }
    if (deactivationPromise) {
      deactivationResult = (
        await Promise.allSettled([deactivationPromise])
      )[0] as PromiseSettledResult<void>;
    }
    if (deactivatorOpen && deactivator) {
      try {
        await deactivator.query("ROLLBACK");
      } catch (error) {
        cleanupErrors.push(error);
      }
      deactivatorOpen = false;
    }
    if (!blockerReleased) {
      try {
        blocker.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (deactivator) {
      try {
        deactivator.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Presentation mutation race and cleanup failed",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Presentation mutation race cleanup failed");
  }
  return {
    deactivationBlocked,
    deactivationResult,
    mutationReachedWrite,
    mutationResult,
  };
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  const migrationConnectionString = process.env.DATABASE_MIGRATION_URL;
  const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
  if (
    !connectionString ||
    !migrationConnectionString ||
    !applicationRole ||
    !/^[a-z_][a-z0-9_]*$/.test(applicationRole)
  ) {
    throw new Error("PostgreSQL fixture variables are required");
  }
  migrationPool = createDatabasePool(migrationConnectionString, { max: 4 });
  await migrateDatabase(createDatabase(migrationPool));
  await migrationPool.query(
    `INSERT INTO tenants (tenant_id, name)
     VALUES ($1, 'Presentation A'), ($2, 'Presentation B')`,
    [ids.tenantA, ids.tenantB],
  );
  await migrationPool.query(
    `INSERT INTO principals (principal_id, display_name)
     VALUES ($1, 'Actor A'), ($2, 'Actor B'), ($3, 'Surface Admin A')`,
    [ids.actorA, ids.actorB, ids.actorAdminA],
  );
  await insertMembership(ids.tenantA, ids.membershipA, ids.actorA);
  await insertMembership(ids.tenantA, ids.membershipAdminA, ids.actorAdminA);
  await insertMembership(ids.tenantB, ids.membershipB, ids.actorB);
  await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
    active: true,
    capabilities: ["hr.leave.list_own", "hr.leave.view"],
  });
  await setLeavePresentationEligibility(ids.tenantA, ids.actorAdminA, {
    active: true,
    capabilities: ["hr.leave.list_own", "hr.leave.view"],
  });
  for (const [tenantId, principalId] of [
    [ids.tenantA, ids.actorA],
    [ids.tenantA, ids.actorAdminA],
    [ids.tenantB, ids.actorB],
  ] as const) {
    for (const capabilityId of [
      "platform.presentation.layouts.read_own",
      "platform.presentation.layouts.reset_own",
      "platform.presentation.layouts.write_own",
    ]) {
      await setPresentationCapability(tenantId, principalId, capabilityId, true);
    }
  }
  await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);
  await migrationPool.query(
    `GRANT SELECT ON membership_capabilities TO ${applicationRole};
     GRANT SELECT, UPDATE ON service_activations TO ${applicationRole}`,
  );
  pool = createDatabasePool(connectionString, { max: 4 });
});

afterAll(async () => {
  await pool?.end();
  await migrationPool?.end();
});

describe("presentation preference persistence", () => {
  it("persists all four independent appearance values through a pool restart", async () => {
    const initial = await getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA));
    expect(initial).toEqual({
      appearance: {
        density: {
          effectiveValue: "comfortable",
          key: "appearance.density.v1",
          locked: false,
          lockReason: null,
          source: "product_default",
          tenantValue: null,
          userValue: null,
        },
        highContrast: {
          effectiveValue: false,
          key: "appearance.high_contrast.v1",
          locked: false,
          lockReason: null,
          source: "product_default",
          tenantValue: null,
          userValue: null,
        },
        palette: {
          effectiveValue: "light",
          key: "appearance.palette.v1",
          locked: false,
          lockReason: null,
          source: "product_default",
          tenantValue: null,
          userValue: null,
        },
        reducedMotion: {
          effectiveValue: "auto",
          key: "appearance.reduced_motion.v1",
          locked: false,
          lockReason: null,
          source: "product_default",
          tenantValue: null,
          userValue: null,
        },
      },
      canManageTenantDefaults: false,
      tenantVersion: 0,
      userVersion: 0,
    });

    const mutationContext = context(ids.tenantA, ids.actorA);
    const updated = await updateOwnPresentationPreferences(pool, mutationContext, {
      density: "compact",
      expectedVersion: 0,
      highContrast: false,
      palette: "dark",
      reducedMotion: "reduce",
    });
    expect(updated).toMatchObject({
      billingState: "non_billable",
      appearance: {
        density: { effectiveValue: "compact", source: "user_global" },
        highContrast: { effectiveValue: false, source: "user_global" },
        palette: { effectiveValue: "dark", source: "user_global" },
        reducedMotion: { effectiveValue: "reduce", source: "user_global" },
      },
      replayed: false,
      tenantVersion: 0,
      userVersion: 1,
    });
    expect(
      await updateOwnPresentationPreferences(pool, mutationContext, {
        density: "compact",
        expectedVersion: 0,
        highContrast: false,
        palette: "dark",
        reducedMotion: "reduce",
      }),
    ).toEqual({ ...updated, replayed: true });

    const stored = await migrationPool.connect();
    try {
      await stored.query("BEGIN");
      await stored.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await stored.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.actorA]);
      const rows = await stored.query<{
        locked: boolean;
        setting_key: string;
        value: unknown;
        version: number;
      }>(
        `SELECT setting_key, value, locked, version
         FROM presentation_setting_values
         WHERE tenant_id = $1 AND subject_type = 'user_override' AND subject_id = $2
         ORDER BY setting_key`,
        [ids.tenantA, ids.actorA],
      );
      expect(rows.rows).toEqual([
        {
          locked: false,
          setting_key: "appearance.density.v1",
          value: "compact",
          version: 1,
        },
        {
          locked: false,
          setting_key: "appearance.high_contrast.v1",
          value: false,
          version: 1,
        },
        {
          locked: false,
          setting_key: "appearance.palette.v1",
          value: "dark",
          version: 1,
        },
        {
          locked: false,
          setting_key: "appearance.reduced_motion.v1",
          value: "reduce",
          version: 1,
        },
      ]);
      await stored.query("ROLLBACK");
    } finally {
      stored.release();
    }

    await pool.end();
    pool = createDatabasePool(process.env.DATABASE_URL ?? "", { max: 4 });
    expect(
      await getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA)),
    ).toMatchObject({
      appearance: {
        density: { effectiveValue: "compact", source: "user_global" },
        highContrast: { effectiveValue: false, source: "user_global" },
        palette: { effectiveValue: "dark", source: "user_global" },
        reducedMotion: { effectiveValue: "reduce", source: "user_global" },
      },
      canManageTenantDefaults: false,
      tenantVersion: 0,
      userVersion: 1,
    });
  });

  it("enforces current tenant capability, accessibility floors, CAS, reset and zero outbox", async () => {
    await setPresentationCapability(
      ids.tenantA,
      ids.actorAdminA,
      "platform.presentation.tenant_defaults.write",
      true,
    );
    const tenantContext = context(ids.tenantA, ids.actorAdminA);
    const tenantDefaults = await updateTenantPresentationDefaults(pool, tenantContext, {
      density: "comfortable",
      expectedVersion: 0,
      highContrast: true,
      lockDensity: true,
      palette: "light",
      reducedMotion: "reduce",
      requireHighContrast: true,
      requireReducedMotion: true,
    });
    expect(tenantDefaults).toMatchObject({
      billingState: "non_billable",
      canManageTenantDefaults: true,
      replayed: false,
      tenantVersion: 1,
      userVersion: 0,
    });
    expect(
      await updateTenantPresentationDefaults(pool, tenantContext, {
        density: "comfortable",
        expectedVersion: 0,
        highContrast: true,
        lockDensity: true,
        palette: "light",
        reducedMotion: "reduce",
        requireHighContrast: true,
        requireReducedMotion: true,
      }),
    ).toEqual({ ...tenantDefaults, replayed: true });

    const employee = await getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA));
    expect(employee).toMatchObject({
      appearance: {
        density: {
          effectiveValue: "comfortable",
          locked: true,
          lockReason: "tenant_density_lock",
          source: "tenant_global",
          tenantValue: "comfortable",
          userValue: "compact",
        },
        highContrast: {
          effectiveValue: true,
          locked: true,
          lockReason: "accessibility_high_contrast_floor",
          source: "tenant_global",
          tenantValue: true,
          userValue: false,
        },
        palette: {
          effectiveValue: "dark",
          locked: false,
          source: "user_global",
          tenantValue: "light",
          userValue: "dark",
        },
        reducedMotion: {
          effectiveValue: "reduce",
          locked: true,
          lockReason: "motion_reduction_floor",
          source: "tenant_global",
          tenantValue: "reduce",
          userValue: "reduce",
        },
      },
      canManageTenantDefaults: false,
      tenantVersion: 1,
      userVersion: 1,
    });

    const hiddenOverride = await updateOwnPresentationPreferences(
      pool,
      context(ids.tenantA, ids.actorA),
      {
        density: "compact",
        expectedVersion: 1,
        highContrast: false,
        palette: "dark",
        reducedMotion: "auto",
      },
    );
    expect(hiddenOverride).toMatchObject({
      appearance: {
        density: { effectiveValue: "comfortable", userValue: "compact" },
        highContrast: { effectiveValue: true, userValue: false },
        palette: { effectiveValue: "dark", userValue: "dark" },
        reducedMotion: { effectiveValue: "reduce", userValue: "auto" },
      },
      tenantVersion: 1,
      userVersion: 2,
    });

    const beforeDenied = await preferenceProofSnapshot(ids.tenantA);
    await setPresentationCapability(
      ids.tenantA,
      ids.actorAdminA,
      "platform.presentation.tenant_defaults.write",
      false,
    );
    await expect(
      updateTenantPresentationDefaults(pool, context(ids.tenantA, ids.actorAdminA), {
        density: "compact",
        expectedVersion: 1,
        highContrast: false,
        lockDensity: false,
        palette: "dark",
        reducedMotion: "auto",
        requireHighContrast: false,
        requireReducedMotion: false,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await preferenceProofSnapshot(ids.tenantA)).toEqual(beforeDenied);
    await expect(
      updateTenantPresentationDefaults(pool, context(ids.tenantB, ids.actorAdminA), {
        density: "compact",
        expectedVersion: 1,
        highContrast: false,
        lockDensity: false,
        palette: "dark",
        reducedMotion: "auto",
        requireHighContrast: false,
        requireReducedMotion: false,
      }),
    ).rejects.toMatchObject({
      code: "ACTOR_NOT_ACTIVE_MEMBER",
    } satisfies Partial<PlatformError>);

    await setPresentationCapability(
      ids.tenantA,
      ids.actorAdminA,
      "platform.presentation.tenant_defaults.write",
      true,
    );
    const concurrent = await Promise.allSettled([
      updateTenantPresentationDefaults(pool, context(ids.tenantA, ids.actorAdminA), {
        density: "compact",
        expectedVersion: 1,
        highContrast: false,
        lockDensity: false,
        palette: "dark",
        reducedMotion: "auto",
        requireHighContrast: false,
        requireReducedMotion: false,
      }),
      updateTenantPresentationDefaults(pool, context(ids.tenantA, ids.actorAdminA), {
        density: "comfortable",
        expectedVersion: 1,
        highContrast: true,
        lockDensity: false,
        palette: "light",
        reducedMotion: "reduce",
        requireHighContrast: false,
        requireReducedMotion: false,
      }),
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(concurrent.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "IDEMPOTENCY_CONFLICT" },
      status: "rejected",
    });

    const tenantResetContext = context(ids.tenantA, ids.actorAdminA);
    const tenantReset = await resetTenantPresentationDefaults(pool, tenantResetContext, {
      expectedVersion: 2,
    });
    expect(tenantReset).toMatchObject({
      billingState: "non_billable",
      canManageTenantDefaults: true,
      replayed: false,
      tenantVersion: 0,
      userVersion: 0,
    });
    expect(
      await resetTenantPresentationDefaults(pool, tenantResetContext, {
        expectedVersion: 2,
      }),
    ).toEqual({ ...tenantReset, replayed: true });

    const ownResetContext = context(ids.tenantA, ids.actorA);
    const ownReset = await resetOwnPresentationPreferences(pool, ownResetContext, {
      expectedVersion: 2,
    });
    expect(ownReset).toMatchObject({
      appearance: {
        density: { effectiveValue: "comfortable", source: "product_default" },
        highContrast: { effectiveValue: false, source: "product_default" },
        palette: { effectiveValue: "light", source: "product_default" },
        reducedMotion: { effectiveValue: "auto", source: "product_default" },
      },
      canManageTenantDefaults: false,
      replayed: false,
      tenantVersion: 0,
      userVersion: 0,
    });
    expect(
      await resetOwnPresentationPreferences(pool, ownResetContext, {
        expectedVersion: 2,
      }),
    ).toEqual({ ...ownReset, replayed: true });
    expect((await preferenceProofSnapshot(ids.tenantA)).outbox_rows).toBe("[]");
  });

  it("lets any current capability holder succeed independent of role or prior writer", async () => {
    await setPresentationCapability(
      ids.tenantA,
      ids.actorA,
      "platform.presentation.tenant_defaults.write",
      true,
    );
    const firstWriter = await updateTenantPresentationDefaults(
      pool,
      context(ids.tenantA, ids.actorA),
      {
        density: "compact",
        expectedVersion: 0,
        highContrast: false,
        lockDensity: false,
        palette: "dark",
        reducedMotion: "auto",
        requireHighContrast: false,
        requireReducedMotion: false,
      },
    );
    expect(firstWriter).toMatchObject({
      canManageTenantDefaults: true,
      tenantVersion: 1,
    });

    const secondWriter = await updateTenantPresentationDefaults(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      {
        density: "comfortable",
        expectedVersion: 1,
        highContrast: true,
        lockDensity: false,
        palette: "light",
        reducedMotion: "reduce",
        requireHighContrast: false,
        requireReducedMotion: false,
      },
    );
    expect(secondWriter).toMatchObject({
      canManageTenantDefaults: true,
      tenantVersion: 2,
    });

    await resetTenantPresentationDefaults(pool, context(ids.tenantA, ids.actorAdminA), {
      expectedVersion: 2,
    });
    await setPresentationCapability(
      ids.tenantA,
      ids.actorA,
      "platform.presentation.tenant_defaults.write",
      false,
    );
  });

  it("materializes distinct bases and persists an own overlay through a pool restart", async () => {
    expect(await surfaceBaseCounts(ids.tenantA)).toEqual({ heads: 0, versions: 0 });

    const missionControl = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.mission-control",
    );
    const hrMissionControl = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.hr.mission-control",
    );
    expect(missionControl).toMatchObject({
      baseVersion: 1,
      overlayVersion: 0,
      source: "code_default",
      surfaceId: "surface.mission-control",
    });
    expect(hrMissionControl).toMatchObject({
      baseVersion: 1,
      overlayVersion: 0,
      source: "code_default",
      surfaceId: "surface.hr.mission-control",
    });
    expect(missionControl.baseDefinitionHash).not.toBe(hrMissionControl.baseDefinitionHash);

    expect(await surfaceBaseCounts(ids.tenantA)).toEqual({ heads: 0, versions: 0 });

    const mutationContext = context(ids.tenantA, ids.actorA);
    const updated = await updateOwnPresentationSurfaceOverlay(
      pool,
      mutationContext,
      "surface.mission-control",
      {
        expectedVersion: 0,
        placements: [
          {
            column: 2,
            columnSpan: 4,
            instanceId: "mission-control.my-leave",
            row: 5,
            rowSpan: 3,
            widgetDefinitionId: "hr.leave.my-requests",
            widgetDefinitionVersion: 1,
          },
        ],
      },
    );
    expect(updated).toMatchObject({
      billingState: "non_billable",
      overlayVersion: 1,
      replayed: false,
      source: "user_overlay",
    });
    expect(
      await updateOwnPresentationSurfaceOverlay(pool, mutationContext, "surface.mission-control", {
        expectedVersion: 0,
        placements: updated.effectivePlacements,
      }),
    ).toEqual({ ...updated, replayed: true });

    expect(await surfaceBaseCounts(ids.tenantA)).toEqual({ heads: 2, versions: 2 });

    await pool.end();
    pool = createDatabasePool(process.env.DATABASE_URL ?? "", { max: 4 });
    expect(
      await getOwnPresentationSurfaceLayout(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.mission-control",
      ),
    ).toMatchObject({
      effectivePlacements: updated.effectivePlacements,
      overlayVersion: 1,
      source: "user_overlay",
    });

    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, true);
    const expandedEligibility = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.mission-control",
    );
    expect(expandedEligibility.effectivePlacements.map(({ instanceId }) => instanceId)).toEqual([
      "mission-control.my-leave",
    ]);
    expect(
      expandedEligibility.effectivePlacements.find(
        ({ instanceId }) => instanceId === "mission-control.my-leave",
      ),
    ).toMatchObject({ column: 2, row: 5 });
    expect(expandedEligibility.diagnostics).toEqual([]);

    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, false);
    expect(
      (
        await getOwnPresentationSurfaceLayout(
          pool,
          context(ids.tenantA, ids.actorA),
          "surface.mission-control",
        )
      ).effectivePlacements,
    ).toEqual(updated.effectivePlacements);
  });

  it("filters discovery and blocks layout mutation after capability loss or deactivation", async () => {
    const eligible = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.mission-control",
    );
    expect(eligible.effectivePlacements).toHaveLength(1);

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own"],
    });
    const capabilityRevoked = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorA),
      "surface.mission-control",
    );
    expect(capabilityRevoked.basePlacements).toEqual([]);
    expect(capabilityRevoked.effectivePlacements).toEqual([]);
    await expect(
      getOwnPresentationSurfaceLayout(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.hr.mission-control",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    await expect(
      updateOwnPresentationSurfaceOverlay(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.mission-control",
        {
          expectedVersion: eligible.overlayVersion,
          placements: eligible.effectivePlacements,
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: false,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    expect(
      (
        await getOwnPresentationSurfaceLayout(
          pool,
          context(ids.tenantA, ids.actorA),
          "surface.mission-control",
        )
      ).effectivePlacements,
    ).toEqual([]);
    await expect(
      getOwnPresentationSurfaceLayout(
        pool,
        context(ids.tenantA, ids.actorA),
        "surface.hr.mission-control",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_assigned", "hr.leave.view"],
    });
    expect(
      (
        await getOwnPresentationSurfaceLayout(
          pool,
          context(ids.tenantA, ids.actorA),
          "surface.mission-control",
        )
      ).effectivePlacements.map(({ widgetDefinitionId }) => widgetDefinitionId),
    ).toEqual([]);
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
  });

  it("filters the direct-reports widget by current manager role and exact capabilities", async () => {
    await setPresentationActorRole(ids.tenantA, ids.actorA, "manager");
    await setPresentationCapability(ids.tenantA, ids.actorA, "hr.workforce.list_authorized", true);
    await setPresentationCapability(
      ids.tenantA,
      ids.actorA,
      "hr.workforce.view_authorized_detail",
      true,
    );
    try {
      expect(
        (
          await getOwnPresentationSurfaceLayout(
            pool,
            context(ids.tenantA, ids.actorA),
            "surface.mission-control",
          )
        ).basePlacements.map(({ instanceId }) => instanceId),
      ).toContain("mission-control.direct-reports");

      await setWorkforceManagerVisibility(ids.tenantA, "none");
      expect(
        (
          await getOwnPresentationSurfaceLayout(
            pool,
            context(ids.tenantA, ids.actorA),
            "surface.mission-control",
          )
        ).basePlacements.map(({ instanceId }) => instanceId),
      ).not.toContain("mission-control.direct-reports");
      await setWorkforceManagerVisibility(ids.tenantA, null);

      await setPresentationActorRole(ids.tenantA, ids.actorA, "hr_operator");
      expect(
        (
          await getOwnPresentationSurfaceLayout(
            pool,
            context(ids.tenantA, ids.actorA),
            "surface.mission-control",
          )
        ).basePlacements.map(({ instanceId }) => instanceId),
      ).not.toContain("mission-control.direct-reports");

      await setPresentationActorRole(ids.tenantA, ids.actorA, "manager");
      await setPresentationCapability(
        ids.tenantA,
        ids.actorA,
        "hr.workforce.view_authorized_detail",
        false,
      );
      expect(
        (
          await getOwnPresentationSurfaceLayout(
            pool,
            context(ids.tenantA, ids.actorA),
            "surface.mission-control",
          )
        ).basePlacements.map(({ instanceId }) => instanceId),
      ).not.toContain("mission-control.direct-reports");
    } finally {
      await setWorkforceManagerVisibility(ids.tenantA, null);
      await setPresentationCapability(
        ids.tenantA,
        ids.actorA,
        "hr.workforce.list_authorized",
        false,
      );
      await setPresentationCapability(
        ids.tenantA,
        ids.actorA,
        "hr.workforce.view_authorized_detail",
        false,
      );
      await setPresentationActorRole(ids.tenantA, ids.actorA, "employee");
    }
  });

  it("discovers HR from any active actor-eligible included service without loading service data", async () => {
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: ["hr"],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: false,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: [],
    });
    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, true);
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: ["hr"],
    });
    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, false);
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: [],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.submit"],
    });
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: [],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
  });

  it("discovers only active actor-eligible navigation destinations in canonical order", async () => {
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [{ destinationIds: ["hr.leave.own"], serviceGroupId: "hr" }],
    });
    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, true);
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [
        {
          destinationIds: ["hr.workforce.own", "hr.leave.own"],
          serviceGroupId: "hr",
        },
      ],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.submit"],
    });
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [{ destinationIds: ["hr.workforce.own"], serviceGroupId: "hr" }],
    });
    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, false);
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [],
    });
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });

    await setPresentationActorRole(ids.tenantA, ids.actorA, "manager");
    await setPresentationCapability(ids.tenantA, ids.actorA, "hr.workforce.list_authorized", true);
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [
        {
          destinationIds: ["hr.workforce.direct_reports"],
          serviceGroupId: "hr",
        },
      ],
    });

    await setPresentationActorRole(ids.tenantA, ids.actorA, "hr_operator");
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [{ destinationIds: ["hr.workforce.admin"], serviceGroupId: "hr" }],
    });

    await setPresentationActorRole(ids.tenantA, ids.actorA, "tenant_admin");
    await setPresentationCapability(ids.tenantA, ids.actorA, "hr.workforce.list_authorized", false);
    await setPresentationCapability(
      ids.tenantA,
      ids.actorA,
      "hr.workforce.view_service_control",
      true,
    );
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [{ destinationIds: ["hr.workforce.settings"], serviceGroupId: "hr" }],
    });

    await setPresentationCapability(
      ids.tenantA,
      ids.actorA,
      "hr.workforce.view_service_control",
      false,
    );
    await setPresentationActorRole(ids.tenantA, ids.actorA, "employee");
  });

  it("replays simultaneous first shortcut writes with one durable receipt", async () => {
    const mutationContext = context(ids.tenantA, ids.actorAdminA);
    const input = {
      contextId: "global",
      contextKind: "global",
      expectedVersion: 0,
      operation: "append",
      settingKey: "navigation.universal_shortcuts.v1",
      targetId: "platform.mission_control",
    } as const;
    const results = await Promise.all([
      updateOwnPresentationShortcut(pool, mutationContext, input),
      updateOwnPresentationShortcut(pool, mutationContext, input),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(({ evidenceEventId }) => evidenceEventId)).size).toBe(1);
    expect(results.every(({ set }) => set.version === 1)).toBe(true);
    expect(
      results.every(({ set }) => set.items.map(({ id }) => id).join() === input.targetId),
    ).toBe(true);
    const durable = await presentationRows<{
      evidence_count: number;
      patch_count: number;
    }>(
      ids.tenantA,
      ids.actorAdminA,
      `SELECT
         (
           SELECT count(*)::integer
           FROM evidence_events
           WHERE tenant_id = $1 AND actor_principal_id = $2
             AND subject_type = 'platform_presentation_shortcuts'
             AND correlation_id = $3
         ) AS evidence_count,
         (
           SELECT count(*)::integer
           FROM presentation_shortcut_user_patches
           WHERE tenant_id = $1 AND principal_id = $2
             AND setting_key = 'navigation.universal_shortcuts.v1'
             AND context_kind = 'global' AND context_id = 'global'
         ) AS patch_count`,
      [ids.tenantA, ids.actorAdminA, mutationContext.correlationId],
    );
    expect(durable).toEqual([{ evidence_count: 1, patch_count: 1 }]);

    const divergentContext = context(ids.tenantA, ids.actorAdminA);
    const divergentBase = {
      contextId: "hr",
      contextKind: "service",
      expectedVersion: 0,
      operation: "append",
      settingKey: "navigation.contextual_shortcuts.v1",
    } as const;
    const divergentResults = await Promise.allSettled([
      updateOwnPresentationShortcut(pool, divergentContext, {
        ...divergentBase,
        targetId: "service_group.hr.mission_control",
      }),
      updateOwnPresentationShortcut(pool, divergentContext, {
        ...divergentBase,
        targetId: "hr.leave.own",
      }),
    ]);
    const divergentFulfilled = divergentResults.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof updateOwnPresentationShortcut>>
      > => result.status === "fulfilled",
    );
    const divergentRejected = divergentResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(divergentFulfilled).toHaveLength(1);
    expect(divergentRejected).toHaveLength(1);
    expect(divergentRejected[0]?.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const divergentDurable = await presentationRows<{
      evidence_count: number;
      patch_count: number;
    }>(
      ids.tenantA,
      ids.actorAdminA,
      `SELECT
         (
           SELECT count(*)::integer
           FROM evidence_events
           WHERE tenant_id = $1 AND actor_principal_id = $2
             AND subject_type = 'platform_presentation_shortcuts'
             AND correlation_id = $3
         ) AS evidence_count,
         (
           SELECT count(*)::integer
           FROM presentation_shortcut_user_patches
           WHERE tenant_id = $1 AND principal_id = $2
             AND setting_key = 'navigation.contextual_shortcuts.v1'
             AND context_kind = 'service' AND context_id = 'hr'
         ) AS patch_count`,
      [ids.tenantA, ids.actorAdminA, divergentContext.correlationId],
    );
    expect(divergentDurable).toEqual([{ evidence_count: 1, patch_count: 1 }]);
    expect(divergentFulfilled[0]?.value).toMatchObject({
      billingState: "non_billable",
      replayed: false,
      set: { version: 1 },
    });
  });

  it("persists exact own shortcut scopes with CAS, evidence and current eligibility", async () => {
    const initial = await getOwnPresentationShortcuts(pool, context(ids.tenantA, ids.actorA), {
      contextServiceGroupId: "hr",
    });
    expect(initial).toMatchObject({
      contextual: {
        contextId: "hr",
        contextKind: "service",
        items: [],
        settingKey: "navigation.contextual_shortcuts.v1",
        tombstoneCount: 0,
        version: 0,
      },
      universal: {
        contextId: "global",
        contextKind: "global",
        items: [],
        settingKey: "navigation.universal_shortcuts.v1",
        tombstoneCount: 0,
        version: 0,
      },
    });
    expect(initial.universal.eligibleTargets.map(({ id }) => id)).toEqual([
      "platform.mission_control",
      "service_group.hr.mission_control",
      "hr.leave.own",
    ]);
    expect(initial.contextual?.eligibleTargets.map(({ id }) => id)).toEqual([
      "service_group.hr.mission_control",
      "hr.leave.own",
    ]);

    const universalContext = context(ids.tenantA, ids.actorA);
    const universal = await updateOwnPresentationShortcut(pool, universalContext, {
      contextId: "global",
      contextKind: "global",
      expectedVersion: 0,
      operation: "append",
      settingKey: "navigation.universal_shortcuts.v1",
      targetId: "hr.leave.own",
    });
    expect(universal).toMatchObject({
      billingState: "non_billable",
      replayed: false,
      set: {
        items: [expect.objectContaining({ id: "hr.leave.own" })],
        tombstoneCount: 0,
        version: 1,
      },
    });
    expect(
      await updateOwnPresentationShortcut(pool, universalContext, {
        contextId: "global",
        contextKind: "global",
        expectedVersion: 0,
        operation: "append",
        settingKey: "navigation.universal_shortcuts.v1",
        targetId: "hr.leave.own",
      }),
    ).toEqual({ ...universal, replayed: true });

    const contextual = await updateOwnPresentationShortcut(pool, context(ids.tenantA, ids.actorA), {
      contextId: "hr",
      contextKind: "service",
      expectedVersion: 0,
      operation: "append",
      settingKey: "navigation.contextual_shortcuts.v1",
      targetId: "hr.leave.own",
    });
    expect(contextual).toMatchObject({
      billingState: "non_billable",
      replayed: false,
      set: {
        contextId: "hr",
        items: [expect.objectContaining({ id: "hr.leave.own" })],
        version: 1,
      },
    });

    const beforeConflict = await migrationPool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM evidence_events
       WHERE tenant_id = $1 AND subject_type = 'platform_presentation_shortcuts'`,
      [ids.tenantA],
    );
    await expect(
      updateOwnPresentationShortcut(pool, context(ids.tenantA, ids.actorA), {
        contextId: "global",
        contextKind: "global",
        expectedVersion: 0,
        operation: "append",
        settingKey: "navigation.universal_shortcuts.v1",
        targetId: "service_group.hr.mission_control",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    } satisfies Partial<PlatformError>);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM evidence_events
           WHERE tenant_id = $1 AND subject_type = 'platform_presentation_shortcuts'`,
          [ids.tenantA],
        )
      ).rows[0]?.count,
    ).toBe(beforeConflict.rows[0]?.count);

    await pool.end();
    pool = createDatabasePool(process.env.DATABASE_URL ?? "", { max: 4 });
    expect(
      (
        await getOwnPresentationShortcuts(pool, context(ids.tenantA, ids.actorA), {
          contextServiceGroupId: "hr",
        })
      ).universal,
    ).toMatchObject({
      items: [expect.objectContaining({ id: "hr.leave.own" })],
      version: 1,
    });

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: false,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    const deactivated = await getOwnPresentationShortcuts(pool, context(ids.tenantA, ids.actorA), {
      contextServiceGroupId: "hr",
    });
    expect(deactivated.contextual).toBeNull();
    expect(deactivated.universal).toMatchObject({
      items: [],
      tombstoneCount: 1,
      version: 1,
    });
    expect(deactivated.universal.eligibleTargets.map(({ id }) => id)).toEqual([
      "platform.mission_control",
    ]);
    const beforeDeniedAppend = await migrationPool.query<{
      evidence_count: number;
      patch_version: number;
    }>(
      `SELECT
         (
           SELECT count(*)::integer
           FROM evidence_events
           WHERE tenant_id = $1 AND subject_type = 'platform_presentation_shortcuts'
         ) AS evidence_count,
         (
           SELECT version
           FROM presentation_shortcut_user_patches
           WHERE tenant_id = $1 AND principal_id = $2
             AND setting_key = 'navigation.universal_shortcuts.v1'
             AND context_kind = 'global' AND context_id = 'global'
         ) AS patch_version`,
      [ids.tenantA, ids.actorA],
    );
    await expect(
      updateOwnPresentationShortcut(pool, context(ids.tenantA, ids.actorA), {
        contextId: "global",
        contextKind: "global",
        expectedVersion: 1,
        operation: "append",
        settingKey: "navigation.universal_shortcuts.v1",
        targetId: "service_group.hr.mission_control",
      }),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
    } satisfies Partial<PlatformError>);
    expect(
      (
        await migrationPool.query<{
          evidence_count: number;
          patch_version: number;
        }>(
          `SELECT
             (
               SELECT count(*)::integer
               FROM evidence_events
               WHERE tenant_id = $1 AND subject_type = 'platform_presentation_shortcuts'
             ) AS evidence_count,
             (
               SELECT version
               FROM presentation_shortcut_user_patches
               WHERE tenant_id = $1 AND principal_id = $2
                 AND setting_key = 'navigation.universal_shortcuts.v1'
                 AND context_kind = 'global' AND context_id = 'global'
             ) AS patch_version`,
          [ids.tenantA, ids.actorA],
        )
      ).rows,
    ).toEqual(beforeDeniedAppend.rows);

    const removed = await updateOwnPresentationShortcut(pool, context(ids.tenantA, ids.actorA), {
      contextId: "global",
      contextKind: "global",
      expectedVersion: 1,
      operation: "remove",
      settingKey: "navigation.universal_shortcuts.v1",
      targetId: "hr.leave.own",
    });
    expect(removed.set).toMatchObject({ items: [], version: 2 });
    expect(
      (
        await migrationPool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM outbox_events
           WHERE tenant_id = $1 AND event_type LIKE 'platform.presentation.shortcut%'`,
          [ids.tenantA],
        )
      ).rows[0]?.count,
    ).toBe(0);
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
  });

  it("fails service-group discovery closed after role demotion with stale capabilities", async () => {
    await setWorkforcePresentationEligibility(ids.tenantA, ids.actorA, false);
    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_assigned", "hr.leave.view"],
    });
    await setPresentationActorRole(ids.tenantA, ids.actorA, "manager");
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: ["hr"],
    });
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [{ destinationIds: [], serviceGroupId: "hr" }],
    });

    await setPresentationActorRole(ids.tenantA, ids.actorA, "employee");
    expect(await getOwnPresentationServiceGroups(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroupIds: [],
    });
    expect(await getOwnPresentationNavigation(pool, context(ids.tenantA, ids.actorA))).toEqual({
      serviceGroups: [],
    });

    await setLeavePresentationEligibility(ids.tenantA, ids.actorA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
  });

  it("versions a tenant base and deterministically rebases then resets an exact personal overlay", async () => {
    const surfaceId = "surface.mission-control" as const;
    const adminContext = context(ids.tenantA, ids.actorAdminA);
    const initialLayout = await getOwnPresentationSurfaceLayout(pool, adminContext, surfaceId);
    const movedOnlyByColumn = initialLayout.effectivePlacements.map((placement) => ({
      ...placement,
      column: 2,
    }));
    const personalContext = context(ids.tenantA, ids.actorAdminA);
    const personal = await updateOwnPresentationSurfaceOverlay(pool, personalContext, surfaceId, {
      expectedVersion: 0,
      placements: movedOnlyByColumn,
    });
    expect(personal).toMatchObject({
      baseVersion: 1,
      overlayVersion: 1,
      source: "user_overlay",
    });
    await rewriteSurfaceEvidenceAsLegacyV1(ids.tenantA, ids.actorAdminA, personal.evidenceEventId);
    expect(
      await updateOwnPresentationSurfaceOverlay(pool, personalContext, surfaceId, {
        expectedVersion: 0,
        placements: movedOnlyByColumn,
      }),
    ).toEqual({ ...personal, replayed: true });

    const beforeDeniedRead = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      getTenantPresentationSurfaceBaseWorkspace(pool, adminContext, surfaceId),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeDeniedRead);

    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities,
    );
    const initialWorkspace = await getTenantPresentationSurfaceBaseWorkspace(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      surfaceId,
    );
    expect(initialWorkspace).toMatchObject({
      currentBase: { baseVersion: 1, basedOnVersion: null },
      draft: null,
      headRowVersion: 1,
    });
    expect(initialWorkspace.history).toHaveLength(1);

    const draftContext = context(ids.tenantA, ids.actorAdminA);
    const proposedBase = initialWorkspace.currentBase.placements.map((placement) => ({
      ...placement,
      row: placement.row + 3,
    }));
    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities.filter(
        (capability) => capability !== "platform.studio.surface_base.draft",
      ),
    );
    const beforeDeniedDraft = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      upsertTenantPresentationSurfaceDraft(pool, context(ids.tenantA, ids.actorAdminA), surfaceId, {
        expectedDraftVersion: 0,
        expectedHeadRowVersion: 1,
        placements: proposedBase,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeDeniedDraft);
    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities,
    );

    const drafted = await upsertTenantPresentationSurfaceDraft(pool, draftContext, surfaceId, {
      expectedDraftVersion: 0,
      expectedHeadRowVersion: 1,
      placements: proposedBase,
    });
    expect(drafted).toMatchObject({
      billingState: "non_billable",
      draft: {
        basedOnVersion: 1,
        candidateBaseVersion: 2,
        draftVersion: 1,
        placements: proposedBase,
      },
      replayed: false,
    });
    const legacyDraftRequestHash = createHash("sha256")
      .update(
        legacyCanonicalJson({
          expectedDraftVersion: 0,
          expectedHeadRowVersion: 1,
          placements: withoutWidgetDefinitionVersions(proposedBase),
          surfaceId,
        }),
      )
      .digest("hex");
    await rewriteSurfaceEvidenceAsLegacyV1(
      ids.tenantA,
      ids.actorAdminA,
      drafted.evidenceEventId,
      legacyDraftRequestHash,
    );
    expect(
      await upsertTenantPresentationSurfaceDraft(pool, draftContext, surfaceId, {
        expectedDraftVersion: 0,
        expectedHeadRowVersion: 1,
        placements: proposedBase,
      }),
    ).toEqual({ ...drafted, replayed: true });

    const beforeStaleDraftCas = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      upsertTenantPresentationSurfaceDraft(pool, context(ids.tenantA, ids.actorAdminA), surfaceId, {
        expectedDraftVersion: 0,
        expectedHeadRowVersion: 1,
        placements: proposedBase,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<PlatformError>);
    await expect(
      validateTenantPresentationSurfaceDraft(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedDraftVersion: 0, expectedHeadRowVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<PlatformError>);
    await expect(
      publishTenantPresentationSurfaceDraft(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedDraftVersion: 0, expectedHeadRowVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeStaleDraftCas);

    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities.filter(
        (capability) => capability !== "platform.studio.surface_base.validate",
      ),
    );
    const beforeDeniedValidate = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      validateTenantPresentationSurfaceDraft(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedDraftVersion: 1, expectedHeadRowVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeDeniedValidate);
    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities,
    );

    expect(
      await validateTenantPresentationSurfaceDraft(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedDraftVersion: 1, expectedHeadRowVersion: 1 },
      ),
    ).toMatchObject({
      billingState: "non_billable",
      diagnostics: [],
      draftVersion: 1,
      valid: true,
    });

    await setStudioSurfaceBaseCapabilities(ids.tenantA, ids.actorAdminA, [
      "platform.studio.surface_base.read",
      "platform.studio.surface_base.draft",
      "platform.studio.surface_base.validate",
      "platform.studio.surface_base.rollback",
    ]);
    const beforeDeniedPublish = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      publishTenantPresentationSurfaceDraft(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedDraftVersion: 1, expectedHeadRowVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeDeniedPublish);

    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities,
    );
    const publishContext = context(ids.tenantA, ids.actorAdminA);
    const published = await publishTenantPresentationSurfaceDraft(pool, publishContext, surfaceId, {
      expectedDraftVersion: 1,
      expectedHeadRowVersion: 1,
    });
    expect(published).toMatchObject({
      baseVersion: 2,
      basedOnVersion: 1,
      billingState: "non_billable",
      headRowVersion: 2,
      replayed: false,
    });
    await rewriteSurfaceEvidenceAsLegacyV1(ids.tenantA, ids.actorAdminA, published.evidenceEventId);
    expect(
      await publishTenantPresentationSurfaceDraft(pool, publishContext, surfaceId, {
        expectedDraftVersion: 1,
        expectedHeadRowVersion: 1,
      }),
    ).toEqual({ ...published, replayed: true });

    const rebased = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      surfaceId,
    );
    expect(rebased).toMatchObject({
      baseVersion: 2,
      overlayVersion: 1,
      source: "user_overlay",
    });
    expect(rebased.effectivePlacements).toEqual(
      initialLayout.effectivePlacements.map((placement) => ({
        ...placement,
        column: 2,
        row: placement.row + 3,
      })),
    );
    const savedRebase = await updateOwnPresentationSurfaceOverlay(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      surfaceId,
      { expectedVersion: 1, placements: rebased.effectivePlacements },
    );
    expect(savedRebase).toMatchObject({
      baseVersion: 2,
      overlayVersion: 2,
    });

    const beforeStaleDraft = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      upsertTenantPresentationSurfaceDraft(pool, context(ids.tenantA, ids.actorAdminA), surfaceId, {
        expectedDraftVersion: 0,
        expectedHeadRowVersion: 1,
        placements: proposedBase,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeStaleDraft);

    await expect(
      rollbackTenantPresentationSurfaceBase(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedHeadRowVersion: 1, sourceBaseVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<PlatformError>);
    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities.filter(
        (capability) => capability !== "platform.studio.surface_base.rollback",
      ),
    );
    const beforeDeniedRollback = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      rollbackTenantPresentationSurfaceBase(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedHeadRowVersion: 2, sourceBaseVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeDeniedRollback);
    await setStudioSurfaceBaseCapabilities(
      ids.tenantA,
      ids.actorAdminA,
      studioSurfaceBaseCapabilities,
    );
    const rollbackContext = context(ids.tenantA, ids.actorAdminA);
    const rolledBack = await rollbackTenantPresentationSurfaceBase(
      pool,
      rollbackContext,
      surfaceId,
      { expectedHeadRowVersion: 2, sourceBaseVersion: 1 },
    );
    expect(rolledBack).toMatchObject({
      baseVersion: 3,
      basedOnVersion: 1,
      billingState: "non_billable",
      headRowVersion: 3,
      replayed: false,
    });
    await rewriteSurfaceEvidenceAsLegacyV1(
      ids.tenantA,
      ids.actorAdminA,
      rolledBack.evidenceEventId,
    );
    expect(
      await rollbackTenantPresentationSurfaceBase(pool, rollbackContext, surfaceId, {
        expectedHeadRowVersion: 2,
        sourceBaseVersion: 1,
      }),
    ).toEqual({ ...rolledBack, replayed: true });

    const resetContext = context(ids.tenantA, ids.actorAdminA);
    const reset = await resetOwnPresentationSurfaceOverlay(pool, resetContext, surfaceId, {
      expectedVersion: 2,
    });
    expect(reset).toMatchObject({
      baseVersion: 3,
      billingState: "non_billable",
      overlayVersion: 0,
      replayed: false,
      source: "tenant_base",
    });
    await rewriteSurfaceEvidenceAsLegacyV1(ids.tenantA, ids.actorAdminA, reset.evidenceEventId);
    expect(
      await resetOwnPresentationSurfaceOverlay(pool, resetContext, surfaceId, {
        expectedVersion: 2,
      }),
    ).toEqual({ ...reset, replayed: true });

    const evidenceClient = await migrationPool.connect();
    await evidenceClient.query("BEGIN");
    await evidenceClient.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
    await evidenceClient.query("SELECT set_config('app.actor_principal_id', $1, true)", [
      ids.actorAdminA,
    ]);
    const evidence = await evidenceClient.query<{
      actor_principal_id: string;
      correlation_id: string;
      event_type: string;
      evidence_event_id: string;
      subject_id: string;
      subject_type: string;
      tenant_id: string;
    }>(
      `SELECT evidence_event_id, tenant_id, event_type, subject_type, subject_id,
              actor_principal_id, correlation_id
       FROM evidence_events
       WHERE evidence_event_id = ANY($1::uuid[])
       ORDER BY event_type`,
      [
        [
          drafted.evidenceEventId,
          published.evidenceEventId,
          rolledBack.evidenceEventId,
          reset.evidenceEventId,
        ],
      ],
    );
    await evidenceClient.query("ROLLBACK");
    evidenceClient.release();
    expect(evidence.rows).toEqual([
      {
        actor_principal_id: ids.actorAdminA,
        correlation_id: resetContext.correlationId,
        event_type: "platform.presentation.surface_overlay.reset",
        evidence_event_id: reset.evidenceEventId,
        subject_id: expect.any(String),
        subject_type: "platform_presentation_surface_overlay",
        tenant_id: ids.tenantA,
      },
      {
        actor_principal_id: ids.actorAdminA,
        correlation_id: draftContext.correlationId,
        event_type: "platform.studio.surface_base.draft.updated",
        evidence_event_id: drafted.evidenceEventId,
        subject_id: expect.any(String),
        subject_type: "platform_presentation_surface_base",
        tenant_id: ids.tenantA,
      },
      {
        actor_principal_id: ids.actorAdminA,
        correlation_id: publishContext.correlationId,
        event_type: "platform.studio.surface_base.published",
        evidence_event_id: published.evidenceEventId,
        subject_id: expect.any(String),
        subject_type: "platform_presentation_surface_base",
        tenant_id: ids.tenantA,
      },
      {
        actor_principal_id: ids.actorAdminA,
        correlation_id: rollbackContext.correlationId,
        event_type: "platform.studio.surface_base.rolled_back",
        evidence_event_id: rolledBack.evidenceEventId,
        subject_id: expect.any(String),
        subject_type: "platform_presentation_surface_base",
        tenant_id: ids.tenantA,
      },
    ]);
    expect(new Set(evidence.rows.map(({ evidence_event_id }) => evidence_event_id)).size).toBe(4);

    await pool.end();
    pool = createDatabasePool(process.env.DATABASE_URL ?? "", { max: 4 });
    expect(
      await getTenantPresentationSurfaceBaseWorkspace(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
      ),
    ).toMatchObject({
      currentBase: { baseVersion: 3, basedOnVersion: 1 },
      draft: null,
      headRowVersion: 3,
      history: [
        { baseVersion: 3, basedOnVersion: 1 },
        { baseVersion: 2, basedOnVersion: 1 },
        { baseVersion: 1, basedOnVersion: null },
      ],
    });
    await setStudioSurfaceBaseCapabilities(ids.tenantB, ids.actorB, [
      "platform.studio.surface_base.read",
    ]);
    expect(
      await getTenantPresentationSurfaceBaseWorkspace(
        pool,
        context(ids.tenantB, ids.actorB),
        surfaceId,
      ),
    ).toMatchObject({
      currentBase: { baseVersion: 1, basedOnVersion: null },
      draft: null,
      history: [{ baseVersion: 1, basedOnVersion: null }],
    });
    expect((await surfaceMutationFootprint(ids.tenantA, surfaceId)).outboxCount).toBe(
      beforeDeniedRead.outboxCount,
    );
  });

  it("returns one deterministic CAS conflict for concurrent first-overlay writers", async () => {
    const surfaceId = "surface.mission-control" as const;
    await setLeavePresentationEligibility(ids.tenantA, ids.actorAdminA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    const initial = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      surfaceId,
    );
    expect(initial.overlayVersion).toBe(0);
    const before = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    const attempts = await Promise.allSettled([
      updateOwnPresentationSurfaceOverlay(pool, context(ids.tenantA, ids.actorAdminA), surfaceId, {
        expectedVersion: 0,
        placements: initial.effectivePlacements.map((placement) => ({
          ...placement,
          column: 2,
        })),
      }),
      updateOwnPresentationSurfaceOverlay(pool, context(ids.tenantA, ids.actorAdminA), surfaceId, {
        expectedVersion: 0,
        placements: initial.effectivePlacements.map((placement) => ({
          ...placement,
          column: 3,
        })),
      }),
    ]);
    const succeeded = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof updateOwnPresentationSurfaceOverlay>>
      > => attempt.status === "fulfilled",
    );
    const failed = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    if (succeeded[0]) {
      await resetOwnPresentationSurfaceOverlay(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
        { expectedVersion: succeeded[0].value.overlayVersion },
      );
    }
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toMatchObject({
      headBaseVersion: before.headBaseVersion,
      headRowVersion: before.headRowVersion,
      outboxCount: before.outboxCount,
      versionCount: before.versionCount,
    });
  });

  it("replays one exact same-correlation concurrent first-overlay mutation", async () => {
    const surfaceId = "surface.mission-control" as const;
    await setLeavePresentationEligibility(ids.tenantA, ids.actorAdminA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    const initial = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      surfaceId,
    );
    expect(initial.overlayVersion).toBe(0);
    const sharedContext = context(ids.tenantA, ids.actorAdminA);
    const input = {
      expectedVersion: 0,
      placements: initial.effectivePlacements.map((placement) => ({
        ...placement,
        column: 2,
      })),
    } as const;
    let attempts: readonly PromiseSettledResult<
      Awaited<ReturnType<typeof updateOwnPresentationSurfaceOverlay>>
    >[] = [];
    let exactMutationState:
      | {
          readonly evidence_count: number;
          readonly overlay_count: number;
          readonly outbox_count: number;
        }
      | undefined;
    try {
      attempts = await Promise.allSettled([
        updateOwnPresentationSurfaceOverlay(pool, sharedContext, surfaceId, input),
        updateOwnPresentationSurfaceOverlay(pool, sharedContext, surfaceId, input),
      ]);
      const storedClient = await migrationPool.connect();
      try {
        await storedClient.query("BEGIN");
        await storedClient.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
        await storedClient.query("SELECT set_config('app.actor_principal_id', $1, true)", [
          ids.actorAdminA,
        ]);
        const stored = await storedClient.query<{
          evidence_count: number;
          overlay_count: number;
          outbox_count: number;
        }>(
          `SELECT
             (SELECT count(*)::integer
              FROM presentation_surface_overlays
              WHERE tenant_id = $1 AND principal_id = $2 AND surface_id = $3) AS overlay_count,
             (SELECT count(*)::integer
              FROM evidence_events
              WHERE tenant_id = $1
                AND actor_principal_id = $2
                AND event_type = 'platform.presentation.surface_overlay.updated'
                AND correlation_id = $4) AS evidence_count,
             (SELECT count(*)::integer
              FROM outbox_events
              WHERE tenant_id = $1 AND correlation_id = $4) AS outbox_count`,
          [ids.tenantA, ids.actorAdminA, surfaceId, sharedContext.correlationId],
        );
        exactMutationState = stored.rows[0];
        await storedClient.query("ROLLBACK");
      } catch (error) {
        await storedClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        storedClient.release();
      }
    } finally {
      const current = await getOwnPresentationSurfaceLayout(
        pool,
        context(ids.tenantA, ids.actorAdminA),
        surfaceId,
      );
      if (current.overlayVersion > 0) {
        await resetOwnPresentationSurfaceOverlay(
          pool,
          context(ids.tenantA, ids.actorAdminA),
          surfaceId,
          { expectedVersion: current.overlayVersion },
        );
      }
    }

    const fulfilled = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof updateOwnPresentationSurfaceOverlay>>
      > => attempt.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(2);
    const original = fulfilled.find(({ value }) => !value.replayed)?.value;
    const replay = fulfilled.find(({ value }) => value.replayed)?.value;
    if (!original || !replay) {
      throw new Error(
        "Concurrent same-correlation mutation did not return one original and replay",
      );
    }
    expect(replay).toEqual({ ...original, replayed: true });
    expect(exactMutationState).toEqual({
      evidence_count: 1,
      outbox_count: 0,
      overlay_count: 1,
    });
    expect(
      await getOwnPresentationSurfaceLayout(pool, context(ids.tenantA, ids.actorAdminA), surfaceId),
    ).toMatchObject({ overlayVersion: 0, source: "tenant_base" });
  });

  it("holds service activation current through personal overlay update and reset commits", async () => {
    const surfaceId = "surface.mission-control" as const;
    await setLeavePresentationEligibility(ids.tenantA, ids.actorAdminA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    const initial = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      surfaceId,
    );
    const created = await updateOwnPresentationSurfaceOverlay(
      pool,
      context(ids.tenantA, ids.actorAdminA),
      surfaceId,
      {
        expectedVersion: 0,
        placements: initial.effectivePlacements.map((placement) => ({
          ...placement,
          column: 2,
        })),
      },
    );
    const updateRace = await racePresentationMutationWithDeactivation(surfaceId, () =>
      updateOwnPresentationSurfaceOverlay(pool, context(ids.tenantA, ids.actorAdminA), surfaceId, {
        expectedVersion: created.overlayVersion,
        placements: created.effectivePlacements.map((placement) => ({
          ...placement,
          column: 3,
        })),
      }),
    );
    await setLeavePresentationEligibility(ids.tenantA, ids.actorAdminA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    expect(updateRace.mutationReachedWrite).toBe(true);
    expect(updateRace.deactivationBlocked).toBe(true);
    expect(updateRace.mutationResult).toMatchObject({
      status: "fulfilled",
      value: { overlayVersion: created.overlayVersion + 1 },
    });
    expect(updateRace.deactivationResult).toEqual({
      status: "fulfilled",
      value: undefined,
    });

    const resetRace = await racePresentationMutationWithDeactivation(surfaceId, () =>
      resetOwnPresentationSurfaceOverlay(pool, context(ids.tenantA, ids.actorAdminA), surfaceId, {
        expectedVersion: created.overlayVersion + 1,
      }),
    );
    await setLeavePresentationEligibility(ids.tenantA, ids.actorAdminA, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    expect(resetRace.mutationReachedWrite).toBe(true);
    expect(resetRace.deactivationBlocked).toBe(true);
    expect(resetRace.mutationResult).toMatchObject({
      status: "fulfilled",
      value: { overlayVersion: 0 },
    });
    expect(resetRace.deactivationResult).toEqual({
      status: "fulfilled",
      value: undefined,
    });
  });

  it("supports remove-all and re-add while current layout capabilities fail closed", async () => {
    const surfaceId = "surface.mission-control" as const;
    await setLeavePresentationEligibility(ids.tenantB, ids.actorB, {
      active: true,
      capabilities: ["hr.leave.list_own", "hr.leave.view"],
    });
    for (const capabilityId of [
      "platform.presentation.layouts.read_own",
      "platform.presentation.layouts.reset_own",
      "platform.presentation.layouts.write_own",
    ]) {
      await setPresentationCapability(ids.tenantB, ids.actorB, capabilityId, true);
    }
    const initial = await getOwnPresentationSurfaceLayout(
      pool,
      context(ids.tenantB, ids.actorB),
      surfaceId,
    );
    expect(initial.effectivePlacements).toHaveLength(1);

    const removedAll = await updateOwnPresentationSurfaceOverlay(
      pool,
      context(ids.tenantB, ids.actorB),
      surfaceId,
      { expectedVersion: 0, placements: [] },
    );
    expect(removedAll).toMatchObject({
      effectivePlacements: [],
      overlayVersion: 1,
      source: "user_overlay",
    });

    await setPresentationCapability(
      ids.tenantB,
      ids.actorB,
      "platform.presentation.layouts.write_own",
      false,
    );
    const beforeDeniedWrite = await surfaceMutationFootprint(ids.tenantB, surfaceId);
    await expect(
      updateOwnPresentationSurfaceOverlay(pool, context(ids.tenantB, ids.actorB), surfaceId, {
        expectedVersion: 1,
        placements: initial.effectivePlacements,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantB, surfaceId)).toEqual(beforeDeniedWrite);

    await setPresentationCapability(
      ids.tenantB,
      ids.actorB,
      "platform.presentation.layouts.write_own",
      true,
    );
    const restored = await updateOwnPresentationSurfaceOverlay(
      pool,
      context(ids.tenantB, ids.actorB),
      surfaceId,
      { expectedVersion: 1, placements: initial.effectivePlacements },
    );
    expect(restored).toMatchObject({
      effectivePlacements: initial.effectivePlacements,
      overlayVersion: 2,
    });

    await setPresentationCapability(
      ids.tenantB,
      ids.actorB,
      "platform.presentation.layouts.reset_own",
      false,
    );
    const beforeDeniedReset = await surfaceMutationFootprint(ids.tenantB, surfaceId);
    await expect(
      resetOwnPresentationSurfaceOverlay(pool, context(ids.tenantB, ids.actorB), surfaceId, {
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantB, surfaceId)).toEqual(beforeDeniedReset);

    await setPresentationCapability(
      ids.tenantB,
      ids.actorB,
      "platform.presentation.layouts.reset_own",
      true,
    );
    await expect(
      resetOwnPresentationSurfaceOverlay(pool, context(ids.tenantB, ids.actorB), surfaceId, {
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ overlayVersion: 0 });
  });

  it("persists a tenant-surface personalization lock and blocks editor mutations unchanged", async () => {
    const surfaceId = "surface.mission-control" as const;
    await setPresentationCapability(
      ids.tenantA,
      ids.actorAdminA,
      "platform.presentation.tenant_defaults.write",
      true,
    );
    await setSurfacePersonalization(ids.tenantA, surfaceId, ids.actorAdminA, true);
    const sharedLockClient = await pool.connect();
    const settingWriter = await pool.connect();
    try {
      const lockKey = `platform.presentation.surface.personalization:${ids.tenantA}:${surfaceId}`;
      await sharedLockClient.query("BEGIN");
      await sharedLockClient.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [
        lockKey,
      ]);
      await settingWriter.query("BEGIN");
      await settingWriter.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await settingWriter.query("SELECT set_config('app.actor_principal_id', $1, true)", [
        ids.actorAdminA,
      ]);
      await settingWriter.query("SET LOCAL lock_timeout = '250ms'");
      await expect(
        settingWriter.query(
          `UPDATE presentation_surface_settings
           SET personalization_enabled=false,version=version+1,
               updated_at=now(),updated_by_principal_id=$2
           WHERE tenant_id=$1 AND surface_id=$3`,
          [ids.tenantA, ids.actorAdminA, surfaceId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await settingWriter.query("ROLLBACK");
      expect(
        await presentationRows<{ personalization_enabled: boolean }>(
          ids.tenantA,
          ids.actorAdminA,
          `SELECT personalization_enabled
           FROM presentation_surface_settings
           WHERE tenant_id=$1 AND surface_id=$2`,
          [ids.tenantA, surfaceId],
        ),
      ).toEqual([{ personalization_enabled: true }]);
      await sharedLockClient.query("COMMIT");

      await settingWriter.query("BEGIN");
      await settingWriter.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await settingWriter.query("SELECT set_config('app.actor_principal_id', $1, true)", [
        ids.actorAdminA,
      ]);
      const disabled = await settingWriter.query(
        `UPDATE presentation_surface_settings
         SET personalization_enabled=false,version=version+1,
             updated_at=now(),updated_by_principal_id=$2
         WHERE tenant_id=$1 AND surface_id=$3`,
        [ids.tenantA, ids.actorAdminA, surfaceId],
      );
      expect(disabled.rowCount).toBe(1);
      await settingWriter.query("COMMIT");
    } finally {
      await sharedLockClient.query("ROLLBACK").catch(() => undefined);
      await settingWriter.query("ROLLBACK").catch(() => undefined);
      sharedLockClient.release();
      settingWriter.release();
    }
    const locked = await getOwnPresentationPersonalSurfaceEditorWorkspace(
      pool,
      context(ids.tenantA, ids.actorA),
      surfaceId,
    );
    expect(locked).toMatchObject({
      editable: false,
      lockReason: "tenant_personalization_disabled",
      resettable: false,
    });
    const beforeDenied = await surfaceMutationFootprint(ids.tenantA, surfaceId);
    await expect(
      updateOwnPresentationSurfaceOverlay(pool, context(ids.tenantA, ids.actorA), surfaceId, {
        expectedVersion: locked.layout.overlayVersion,
        placements: locked.layout.effectivePlacements,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeDenied);
    await expect(
      resetOwnPresentationSurfaceOverlay(pool, context(ids.tenantA, ids.actorA), surfaceId, {
        expectedVersion: locked.layout.overlayVersion,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" } satisfies Partial<PlatformError>);
    expect(await surfaceMutationFootprint(ids.tenantA, surfaceId)).toEqual(beforeDenied);
    await setSurfacePersonalization(ids.tenantA, surfaceId, ids.actorAdminA, true);
    await setPresentationCapability(
      ids.tenantA,
      ids.actorAdminA,
      "platform.presentation.tenant_defaults.write",
      false,
    );
  });

  it("fails closed across tenants, suspended actors, and stale CAS writers", async () => {
    const shortcutProofBefore = await shortcutProofSnapshot(ids.tenantA, ids.actorA);
    await expect(
      getOwnPresentationShortcuts(pool, context(ids.tenantA, ids.actorB), {}),
    ).rejects.toMatchObject({
      code: "ACTOR_NOT_ACTIVE_MEMBER",
    } satisfies Partial<PlatformError>);
    await expect(
      updateOwnPresentationShortcut(pool, context(ids.tenantA, ids.actorB), {
        contextId: "global",
        contextKind: "global",
        expectedVersion: 2,
        operation: "append",
        settingKey: "navigation.universal_shortcuts.v1",
        targetId: "platform.mission_control",
      }),
    ).rejects.toMatchObject({
      code: "ACTOR_NOT_ACTIVE_MEMBER",
    } satisfies Partial<PlatformError>);
    await expect(
      getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorB)),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" } satisfies Partial<PlatformError>);

    await expect(
      updateOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA), {
        density: "comfortable",
        expectedVersion: 999,
        highContrast: false,
        palette: "light",
        reducedMotion: "auto",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<PlatformError>);

    const client = await migrationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await client.query(
        `UPDATE memberships SET status = 'suspended'
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenantA, ids.actorA],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expect(
      getOwnPresentationPreferences(pool, context(ids.tenantA, ids.actorA)),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" } satisfies Partial<PlatformError>);
    await expect(
      getOwnPresentationShortcuts(pool, context(ids.tenantA, ids.actorA), {}),
    ).rejects.toMatchObject({
      code: "ACTOR_NOT_ACTIVE_MEMBER",
    } satisfies Partial<PlatformError>);
    await expect(
      updateOwnPresentationShortcut(pool, context(ids.tenantA, ids.actorA), {
        contextId: "global",
        contextKind: "global",
        expectedVersion: 2,
        operation: "append",
        settingKey: "navigation.universal_shortcuts.v1",
        targetId: "platform.mission_control",
      }),
    ).rejects.toMatchObject({
      code: "ACTOR_NOT_ACTIVE_MEMBER",
    } satisfies Partial<PlatformError>);
    const shortcutProofAfter = await shortcutProofSnapshot(ids.tenantA, ids.actorA);
    expect(shortcutProofAfter).toEqual(shortcutProofBefore);
  });
});
