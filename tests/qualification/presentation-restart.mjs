import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getOwnPresentationPreferences,
  getOwnPresentationShortcuts,
  getOwnPresentationSurfaceLayout,
  updateOwnPresentationPreferences,
  updateOwnPresentationShortcut,
  updateOwnPresentationSurfaceOverlay,
} from "../../modules/platform-core/dist/index.js";
import {
  createDatabase,
  createDatabasePool,
  migrateDatabase,
} from "../../packages/db/dist/index.js";

const ids = Object.freeze({
  actor: "a1000000-0000-4000-8000-000000000001",
  membership: "a2000000-0000-4000-8000-000000000001",
  tenant: "a0000000-0000-4000-8000-000000000001",
});
const restartCount = process.env.ESBLA_TEST_POSTGRES_RESTART_COUNT;
if (restartCount !== "0" && restartCount !== "1") {
  throw new Error("Presentation restart proof must run through its bounded PostgreSQL owner");
}
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const applicationUrl = process.env.DATABASE_URL;
const applicationRole = process.env.ESBLA_TEST_APPLICATION_ROLE;
if (
  !migrationUrl ||
  !applicationUrl ||
  !applicationRole ||
  !/^[a-z_][a-z0-9_]*$/.test(applicationRole)
) {
  throw new Error("Presentation restart proof database context is missing");
}

const migrationPool = createDatabasePool(migrationUrl, { max: 2 });
const applicationPool = createDatabasePool(applicationUrl, { max: 2 });
const context = () => ({
  actorPrincipalId: ids.actor,
  correlationId: randomUUID(),
  tenantId: ids.tenant,
});

try {
  if (restartCount === "0") {
    await migrateDatabase(createDatabase(migrationPool));
    await migrationPool.query(`GRANT SELECT, INSERT ON evidence_events TO ${applicationRole}`);
    await migrationPool.query(`GRANT SELECT ON membership_capabilities TO ${applicationRole}`);
    await migrationPool.query(`GRANT SELECT, UPDATE ON service_activations TO ${applicationRole}`);
    const client = await migrationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
      await client.query(
        `INSERT INTO tenants (tenant_id, name) VALUES ($1, 'Presentation Restart Proof')`,
        [ids.tenant],
      );
      await client.query(
        `INSERT INTO principals (principal_id, display_name) VALUES ($1, 'Restart Actor')`,
        [ids.actor],
      );
      await client.query(
        `INSERT INTO memberships
           (membership_id, tenant_id, principal_id, role_key, status)
         VALUES ($1, $2, $3, 'employee', 'active')`,
        [ids.membership, ids.tenant, ids.actor],
      );
      await client.query(
        `INSERT INTO membership_capabilities (tenant_id, principal_id, capability_id)
         VALUES ($1, $2, 'hr.leave.list_own'),
                ($1, $2, 'hr.leave.view'),
                ($1, $2, 'platform.presentation.layouts.read_own'),
                ($1, $2, 'platform.presentation.layouts.reset_own'),
                ($1, $2, 'platform.presentation.layouts.write_own'),
                ($1, $2, 'platform.presentation.shortcuts.read_own'),
                ($1, $2, 'platform.presentation.shortcuts.write_own')`,
        [ids.tenant, ids.actor],
      );
      await client.query(
        `INSERT INTO service_activations (tenant_id, service_key, state, version)
         VALUES ($1, 'hr.leave_request', 'active', 1)`,
        [ids.tenant],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await updateOwnPresentationPreferences(applicationPool, context(), {
      density: "compact",
      expectedVersion: 0,
      highContrast: true,
      palette: "dark",
      reducedMotion: "reduce",
    });
    const initialLayout = await getOwnPresentationSurfaceLayout(
      applicationPool,
      context(),
      "surface.mission-control",
    );
    assert.equal(initialLayout.overlayVersion, 0);
    await updateOwnPresentationSurfaceOverlay(
      applicationPool,
      context(),
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
    const shortcut = await updateOwnPresentationShortcut(applicationPool, context(), {
      contextId: "surface.mission-control",
      contextKind: "surface",
      expectedVersion: 0,
      operation: "append",
      settingKey: "navigation.contextual_shortcuts.v1",
      targetId: "hr.leave.own",
    });
    assert.equal(shortcut.billingState, "non_billable");
    assert.equal(shortcut.replayed, false);
    assert.equal(shortcut.set.version, 1);
    assert.deepEqual(
      shortcut.set.items.map(({ id }) => id),
      ["hr.leave.own"],
    );
  } else {
    assert.deepEqual(await getOwnPresentationPreferences(applicationPool, context()), {
      appearance: {
        density: {
          effectiveValue: "compact",
          key: "appearance.density.v1",
          locked: false,
          lockReason: null,
          source: "user_global",
          tenantValue: null,
          userValue: "compact",
        },
        highContrast: {
          effectiveValue: true,
          key: "appearance.high_contrast.v1",
          locked: false,
          lockReason: null,
          source: "user_global",
          tenantValue: null,
          userValue: true,
        },
        palette: {
          effectiveValue: "dark",
          key: "appearance.palette.v1",
          locked: false,
          lockReason: null,
          source: "user_global",
          tenantValue: null,
          userValue: "dark",
        },
        reducedMotion: {
          effectiveValue: "reduce",
          key: "appearance.reduced_motion.v1",
          locked: false,
          lockReason: null,
          source: "user_global",
          tenantValue: null,
          userValue: "reduce",
        },
      },
      canManageTenantDefaults: false,
      tenantVersion: 0,
      userVersion: 1,
    });
    const layout = await getOwnPresentationSurfaceLayout(
      applicationPool,
      context(),
      "surface.mission-control",
    );
    assert.equal(layout.baseVersion, 1);
    assert.equal(layout.overlayVersion, 1);
    assert.deepEqual(layout.effectivePlacements, [
      {
        column: 2,
        columnSpan: 4,
        instanceId: "mission-control.my-leave",
        row: 5,
        rowSpan: 3,
        widgetDefinitionId: "hr.leave.my-requests",
        widgetDefinitionVersion: 1,
      },
    ]);
    const shortcuts = await getOwnPresentationShortcuts(applicationPool, context(), {
      contextSurfaceId: "surface.mission-control",
    });
    assert.equal(shortcuts.contextual?.contextKind, "surface");
    assert.equal(shortcuts.contextual?.contextId, "surface.mission-control");
    assert.equal(shortcuts.contextual?.version, 1);
    assert.deepEqual(
      shortcuts.contextual?.items.map(({ id }) => id),
      ["hr.leave.own"],
    );
    const client = await migrationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
      await client.query("SELECT set_config('app.actor_principal_id', $1, true)", [ids.actor]);
      const evidence = await client.query(
        `SELECT count(*)::integer AS count
         FROM evidence_events
         WHERE tenant_id = $1
           AND event_type IN (
             'platform.presentation.preferences.updated',
             'platform.presentation.surface_overlay.updated',
             'platform.presentation.shortcut.updated'
           )`,
        [ids.tenant],
      );
      assert.equal(evidence.rows[0]?.count, 3);
      const shortcutStorage = await client.query(
        `SELECT setting_key, context_kind, context_id, version
         FROM presentation_shortcut_user_patches
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenant, ids.actor],
      );
      assert.deepEqual(shortcutStorage.rows, [
        {
          context_id: "surface.mission-control",
          context_kind: "surface",
          setting_key: "navigation.contextual_shortcuts.v1",
          version: 1,
        },
      ]);
      const shortcutOutbox = await client.query(
        `SELECT count(*)::integer AS count
         FROM outbox_events
         WHERE tenant_id = $1 AND event_type LIKE 'platform.presentation.shortcut%'`,
        [ids.tenant],
      );
      assert.equal(shortcutOutbox.rows[0]?.count, 0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    console.log("PRESENTATION_SHORTCUT_ACTUAL_DATABASE_RESTART_GREEN");
    console.log("PRESENTATION_ACTUAL_DATABASE_RESTART_GREEN");
  }
} finally {
  await Promise.all([applicationPool.end(), migrationPool.end()]);
}

if (restartCount === "0") process.exitCode = 75;
