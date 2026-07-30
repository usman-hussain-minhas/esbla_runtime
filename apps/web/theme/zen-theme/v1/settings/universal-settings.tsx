"use client";

import {
  type EffectivePresentationPreference,
  type PresentationPreferences,
  type PresentationShortcutDiscovery,
  type PresentationShortcutSet,
  type PresentationSurfaceLayout,
  type PresentationSurfaceLayoutSource,
  parseResetPresentationSurfaceOverlayResponse,
  parseUpdatePresentationPreferencesResponse,
  parseUpdatePresentationShortcutResponse,
  type UpdatePresentationPreferencesResponse,
  type ZenV1SurfaceId,
} from "@esbla/contracts";
import { Check, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { replacePresentationShortcutSet } from "../../../../lib/presentation-shortcuts-core";
import { writePresentationThemeCache } from "../../../../lib/presentation-theme-cache-core";
import {
  deriveTenantPresentationDraft,
  parseUniversalSettingsUpdate,
  shouldNotifyUniversalSettingsUpdate,
  type TenantPresentationDraft,
  UNIVERSAL_SETTINGS_CHANNEL,
  type UniversalSettingsUpdateSubject,
} from "../../../../lib/universal-settings-core";
import { ZEN_THEME_CACHE_KEY } from "../identity";
import { SemanticIcon } from "../semantic-icons";

type AppearanceDraft = Readonly<{
  density: "comfortable" | "compact";
  highContrast: boolean;
  palette: "light" | "dark";
  reducedMotion: "auto" | "reduce";
}>;

interface SettingsLayout {
  readonly label: string;
  readonly layout: PresentationSurfaceLayout | null;
  readonly surfaceId: ZenV1SurfaceId;
}

class SettingsRequestError extends Error {
  readonly kind: "conflict" | "forbidden" | "unavailable";

  constructor(kind: "conflict" | "forbidden" | "unavailable") {
    super("Universal Settings request failed");
    this.kind = kind;
  }
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    throw new SettingsRequestError("unavailable");
  }
  if (response.status !== 200) {
    throw new SettingsRequestError(
      response.status === 409 ? "conflict" : response.status === 403 ? "forbidden" : "unavailable",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new SettingsRequestError("unavailable");
  }
}

function personalDraft(preferences: PresentationPreferences): AppearanceDraft {
  const appearance = preferences.appearance;
  return {
    density: appearance.density.userValue ?? appearance.density.effectiveValue,
    highContrast: appearance.highContrast.userValue ?? appearance.highContrast.effectiveValue,
    palette: appearance.palette.userValue ?? appearance.palette.effectiveValue,
    reducedMotion: appearance.reducedMotion.userValue ?? appearance.reducedMotion.effectiveValue,
  };
}

function sourceLabel(source: PresentationPreferences["appearance"]["palette"]["source"]): string {
  if (source === "user_global") return "Your preference";
  if (source === "tenant_global") return "Tenant default";
  return "Product default";
}

function layoutSourceLabel(source: PresentationSurfaceLayoutSource): string {
  if (source === "user_overlay") return "Personal layout";
  if (source === "tenant_base") return "Published tenant layout";
  return "Product layout";
}

function errorMessage(error: unknown): string {
  if (error instanceof SettingsRequestError && error.kind === "conflict") {
    return "This value changed elsewhere. Your choices are preserved—review them, then load the latest values.";
  }
  if (error instanceof SettingsRequestError && error.kind === "forbidden") {
    return "Your current access no longer permits this change. Nothing was saved.";
  }
  return "This change could not be saved. The previous authoritative value remains active.";
}

function applyAppearance(
  preferences: UpdatePresentationPreferencesResponse,
  cacheScope: string | null,
) {
  const root = document.documentElement;
  const appearance = preferences.appearance;
  root.dataset.density = appearance.density.effectiveValue;
  root.dataset.densityLocked = String(appearance.density.locked);
  root.dataset.highContrast = String(appearance.highContrast.effectiveValue);
  root.dataset.highContrastLocked = String(appearance.highContrast.locked);
  root.dataset.palette = appearance.palette.effectiveValue;
  root.dataset.preferenceVersion = String(preferences.userVersion);
  root.dataset.reducedMotion = appearance.reducedMotion.effectiveValue;
  root.dataset.reducedMotionLocked = String(appearance.reducedMotion.locked);
  root.dataset.userDensity = appearance.density.userValue ?? appearance.density.effectiveValue;
  root.dataset.userHighContrast = String(
    appearance.highContrast.userValue ?? appearance.highContrast.effectiveValue,
  );
  root.dataset.userPalette = appearance.palette.userValue ?? appearance.palette.effectiveValue;
  root.dataset.userReducedMotion =
    appearance.reducedMotion.userValue ?? appearance.reducedMotion.effectiveValue;
  root.dataset.preferenceStatus = "authoritative";
  root.style.colorScheme = appearance.palette.effectiveValue;
  try {
    writePresentationThemeCache(localStorage, ZEN_THEME_CACHE_KEY, cacheScope, {
      density: appearance.density.effectiveValue,
      highContrast: appearance.highContrast.effectiveValue,
      palette: appearance.palette.effectiveValue,
      reducedMotion: appearance.reducedMotion.effectiveValue,
      version: preferences.userVersion,
    });
  } catch {
    // Browser storage remains a disposable hydration cache.
  }
}

function EffectivePreference({
  label,
  preference,
}: Readonly<{
  label: string;
  preference: EffectivePresentationPreference<string, boolean | string>;
}>) {
  return (
    <div className="effective-setting">
      <span>{label}</span>
      <strong>{String(preference.effectiveValue)}</strong>
      <small>
        {sourceLabel(preference.source)}
        {preference.locked ? ` · Locked: ${preference.lockReason}` : " · You may override"}
      </small>
    </div>
  );
}

function ShortcutSetEditor({
  disabled,
  onMutate,
  set,
  title,
}: Readonly<{
  disabled: boolean;
  onMutate: (
    set: PresentationShortcutSet,
    targetId: PresentationShortcutSet["items"][number]["id"],
    operation: "append" | "remove",
  ) => void;
  set: PresentationShortcutSet;
  title: string;
}>) {
  const selected = new Set(set.items.map(({ id }) => id));
  return (
    <article className="universal-settings-card shortcut-settings-card">
      <div className="settings-card-heading">
        <div>
          <p className="settings-card-kicker">
            {set.contextKind === "global" ? "Everywhere" : "HR"}
          </p>
          <h3>{title}</h3>
        </div>
        <span className="settings-version">v{set.version}</span>
      </div>
      {set.items.length > 0 ? (
        <ul className="settings-selection-list">
          {set.items.map((target) => (
            <li key={target.id}>
              <span>{target.label}</span>
              <button
                className="settings-inline-command"
                disabled={disabled || !set.editable}
                onClick={() => onMutate(set, target.id, "remove")}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-empty">No personal shortcuts in this scope.</p>
      )}
      <div className="settings-target-grid">
        {set.eligibleTargets
          .filter(({ id }) => !selected.has(id))
          .map((target) => (
            <button
              className="settings-target-command"
              disabled={disabled || !set.editable}
              key={target.id}
              onClick={() => onMutate(set, target.id, "append")}
              type="button"
            >
              <SemanticIcon aria-hidden="true" semanticKey={target.semanticIcon} size={16} />
              <span>Add {target.label}</span>
            </button>
          ))}
      </div>
      {set.tombstoneCount > 0 ? (
        <p className="settings-note">
          {set.tombstoneCount} stale or unauthorized shortcut
          {set.tombstoneCount === 1 ? " is" : "s are"} safely hidden.
        </p>
      ) : null}
    </article>
  );
}

export function UniversalSettings({
  cacheScope,
  initialLayouts,
  initialPreferences,
  initialShortcuts,
}: Readonly<{
  cacheScope: string | null;
  initialLayouts: readonly SettingsLayout[];
  initialPreferences: PresentationPreferences | null;
  initialShortcuts: PresentationShortcutDiscovery | undefined;
}>) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [draft, setDraft] = useState<AppearanceDraft | null>(() =>
    initialPreferences ? personalDraft(initialPreferences) : null,
  );
  const [tenant, setTenant] = useState<TenantPresentationDraft | null>(() =>
    initialPreferences ? deriveTenantPresentationDraft(initialPreferences) : null,
  );
  const [shortcuts, setShortcuts] = useState(initialShortcuts);
  const [layouts, setLayouts] = useState(initialLayouts);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [externalUpdate, setExternalUpdate] = useState<string>();
  const channel = useRef<BroadcastChannel | null>(null);
  const sourceTabId = useRef<string | null>(null);

  useEffect(() => {
    if (!cacheScope || typeof BroadcastChannel === "undefined") return;
    const active = new BroadcastChannel(UNIVERSAL_SETTINGS_CHANNEL);
    channel.current = active;
    sourceTabId.current ??= crypto.randomUUID();
    const tabId = sourceTabId.current;
    active.onmessage = ({ data }) => {
      try {
        const update = parseUniversalSettingsUpdate(data);
        if (!shouldNotifyUniversalSettingsUpdate(update, { cacheScope, sourceTabId: tabId })) {
          return;
        }
        setExternalUpdate(
          update.subject.startsWith("surface.")
            ? "A personal layout changed in another tab."
            : update.subject === "shortcuts"
              ? "Your shortcuts changed in another tab."
              : "Presentation settings changed in another tab.",
        );
      } catch {
        // Malformed and cross-subject messages are ignored without changing local drafts.
      }
    };
    return () => {
      channel.current = null;
      active.close();
    };
  }, [cacheScope]);

  function broadcast(subject: UniversalSettingsUpdateSubject, mutationId: string) {
    if (!cacheScope || !channel.current) return;
    sourceTabId.current ??= crypto.randomUUID();
    channel.current.postMessage({
      mutationId,
      schemaVersion: 1,
      scope: cacheScope,
      sourceTabId: sourceTabId.current,
      subject,
    });
  }

  function start(operation: string) {
    setPending(operation);
    setError(undefined);
    setSuccess(undefined);
  }

  function finish() {
    setPending(undefined);
  }

  function updatePersonalDraft(patch: Partial<AppearanceDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateTenantDraft(patch: Partial<TenantPresentationDraft>) {
    setTenant((current) => (current ? { ...current, ...patch } : current));
  }

  async function savePersonal() {
    if (!preferences || !draft) return;
    start("appearance");
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = parseUpdatePresentationPreferencesResponse(
        await postJson("/presentation/preferences", {
          ...draft,
          expectedVersion: preferences.userVersion,
          idempotencyKey,
        }),
      );
      setPreferences(response);
      setDraft(personalDraft(response));
      setTenant(deriveTenantPresentationDraft(response));
      applyAppearance(response, cacheScope);
      broadcast("appearance", response.evidenceEventId);
      setSuccess("Your appearance preferences are saved.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  async function resetPersonal() {
    if (!preferences) return;
    start("appearance-reset");
    try {
      const response = parseUpdatePresentationPreferencesResponse(
        await postJson("/presentation/preferences/reset", {
          expectedVersion: preferences.userVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setPreferences(response);
      setDraft(personalDraft(response));
      setTenant(deriveTenantPresentationDraft(response));
      applyAppearance(response, cacheScope);
      broadcast("appearance", response.evidenceEventId);
      setSuccess("Your personal appearance overrides were reset.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  async function saveTenantDefaults() {
    if (!preferences || !tenant) return;
    start("tenant-defaults");
    try {
      const response = parseUpdatePresentationPreferencesResponse(
        await postJson("/presentation/tenant-defaults", {
          ...tenant,
          expectedVersion: preferences.tenantVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setPreferences(response);
      setDraft(personalDraft(response));
      setTenant(deriveTenantPresentationDraft(response));
      applyAppearance(response, cacheScope);
      broadcast("tenant-defaults", response.evidenceEventId);
      setSuccess("Tenant presentation defaults and floors are saved.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  async function resetTenantDefaults() {
    if (!preferences) return;
    start("tenant-defaults-reset");
    try {
      const response = parseUpdatePresentationPreferencesResponse(
        await postJson("/presentation/tenant-defaults/reset", {
          expectedVersion: preferences.tenantVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setPreferences(response);
      setDraft(personalDraft(response));
      setTenant(deriveTenantPresentationDraft(response));
      applyAppearance(response, cacheScope);
      broadcast("tenant-defaults", response.evidenceEventId);
      setSuccess("Tenant presentation defaults were restored to Product defaults.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  async function mutateShortcut(
    set: PresentationShortcutSet,
    targetId: PresentationShortcutSet["items"][number]["id"],
    operation: "append" | "remove",
  ) {
    if (!shortcuts) return;
    start(`shortcut:${set.contextId}:${targetId}`);
    try {
      const response = parseUpdatePresentationShortcutResponse(
        await postJson("/presentation/shortcuts", {
          contextId: set.contextId,
          contextKind: set.contextKind,
          expectedVersion: set.version,
          idempotencyKey: crypto.randomUUID(),
          operation,
          settingKey: set.settingKey,
          targetId,
        }),
      );
      setShortcuts(replacePresentationShortcutSet(shortcuts, response.set));
      broadcast("shortcuts", response.evidenceEventId);
      setSuccess(
        `${response.set.contextKind === "global" ? "Universal" : "HR"} shortcuts updated.`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  async function resetLayout(layout: SettingsLayout) {
    if (!layout.layout || layout.layout.overlayVersion < 1) return;
    start(`layout:${layout.surfaceId}`);
    try {
      const response = parseResetPresentationSurfaceOverlayResponse(
        await postJson(`/presentation/surfaces/${layout.surfaceId}/reset`, {
          expectedVersion: layout.layout.overlayVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setLayouts((current) =>
        current.map((candidate) =>
          candidate.surfaceId === layout.surfaceId ? { ...candidate, layout: response } : candidate,
        ),
      );
      broadcast(layout.surfaceId, response.evidenceEventId);
      setSuccess(`${layout.label} now uses its published base.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      finish();
    }
  }

  const appearance = preferences?.appearance;
  const busy = pending !== undefined;

  return (
    <div className="universal-settings">
      {externalUpdate ? (
        <div className="settings-update-banner" role="status">
          <RefreshCw aria-hidden="true" size={18} />
          <div>
            <strong>{externalUpdate}</strong>
            <span>
              Your unsaved choices remain here. Load the latest values when you are ready.
            </span>
          </div>
          <button onClick={() => window.location.reload()} type="button">
            Load latest
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="form-error-summary" role="alert">
          <SemanticIcon aria-hidden="true" semanticKey="warning" size={18} />
          <p>{error}</p>
        </div>
      ) : null}
      {success ? (
        <div className="success-banner" role="status">
          <Check aria-hidden="true" size={18} />
          <strong>{success}</strong>
        </div>
      ) : null}

      <section aria-labelledby="appearance-settings-heading" className="settings-section">
        <header>
          <p className="settings-section-index">01</p>
          <div>
            <h2 id="appearance-settings-heading">Appearance &amp; accessibility</h2>
            <p>Choose personal values without hiding where the effective result comes from.</p>
          </div>
        </header>
        {preferences && appearance && draft ? (
          <div className="settings-grid">
            <article className="universal-settings-card settings-form-card">
              <h3>Your preference</h3>
              <div className="form-grid-two">
                <label className="form-field">
                  <span>Palette</span>
                  <select
                    disabled={busy}
                    onChange={(event) =>
                      updatePersonalDraft({
                        palette: event.target.value as AppearanceDraft["palette"],
                      })
                    }
                    value={draft.palette}
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>Density</span>
                  <select
                    disabled={busy || appearance.density.locked}
                    onChange={(event) =>
                      updatePersonalDraft({
                        density: event.target.value as AppearanceDraft["density"],
                      })
                    }
                    value={draft.density}
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </label>
              </div>
              <label className="settings-choice-row">
                <input
                  checked={draft.highContrast}
                  disabled={busy || appearance.highContrast.locked}
                  onChange={(event) => updatePersonalDraft({ highContrast: event.target.checked })}
                  type="checkbox"
                />
                High contrast
              </label>
              <label className="settings-choice-row">
                <input
                  checked={draft.reducedMotion === "reduce"}
                  disabled={busy || appearance.reducedMotion.locked}
                  onChange={(event) =>
                    updatePersonalDraft({
                      reducedMotion: event.target.checked ? "reduce" : "auto",
                    })
                  }
                  type="checkbox"
                />
                Reduce motion
              </label>
              <div className="settings-actions">
                <button
                  className="command-button command-button-primary"
                  disabled={busy}
                  onClick={savePersonal}
                  type="button"
                >
                  Save my appearance
                </button>
                <button
                  className="command-button"
                  disabled={busy || preferences.userVersion < 1}
                  onClick={resetPersonal}
                  type="button"
                >
                  Reset my overrides
                </button>
              </div>
            </article>
            <article className="universal-settings-card effective-settings-card">
              <h3>Effective values</h3>
              <EffectivePreference label="Palette" preference={appearance.palette} />
              <EffectivePreference label="Density" preference={appearance.density} />
              <EffectivePreference label="High contrast" preference={appearance.highContrast} />
              <EffectivePreference label="Reduced motion" preference={appearance.reducedMotion} />
              <details>
                <summary>Advanced source detail</summary>
                <p>
                  Personal version {preferences.userVersion} · Tenant version{" "}
                  {preferences.tenantVersion}. Changes use expected-version conflict checks and
                  append evidence without billing or outbox delivery.
                </p>
              </details>
            </article>
          </div>
        ) : (
          <div className="settings-inline-unavailable" role="status">
            Appearance preferences are unavailable. Existing values remain unchanged.
          </div>
        )}
      </section>

      <section aria-labelledby="navigation-settings-heading" className="settings-section">
        <header>
          <p className="settings-section-index">02</p>
          <div>
            <h2 id="navigation-settings-heading">Navigation shortcuts</h2>
            <p>Only current, authorized internal destinations can be added.</p>
          </div>
        </header>
        {shortcuts ? (
          <div className="settings-grid">
            <ShortcutSetEditor
              disabled={busy}
              onMutate={mutateShortcut}
              set={shortcuts.universal}
              title="Universal shortcuts"
            />
            {shortcuts.contextual ? (
              <ShortcutSetEditor
                disabled={busy}
                onMutate={mutateShortcut}
                set={shortcuts.contextual}
                title="HR shortcuts"
              />
            ) : null}
          </div>
        ) : (
          <div className="settings-inline-unavailable" role="status">
            Shortcuts are unavailable. Existing shortcuts remain unchanged.
          </div>
        )}
      </section>

      <section aria-labelledby="layout-settings-heading" className="settings-section">
        <header>
          <p className="settings-section-index">03</p>
          <div>
            <h2 id="layout-settings-heading">Personal layouts</h2>
            <p>See each effective surface and reset only your overlay—not the tenant base.</p>
          </div>
        </header>
        <div className="settings-grid">
          {layouts.map((layout) => (
            <article
              className="universal-settings-card layout-settings-card"
              key={layout.surfaceId}
            >
              <div className="settings-card-heading">
                <div>
                  <p className="settings-card-kicker">Surface</p>
                  <h3>{layout.label}</h3>
                </div>
                {layout.layout ? (
                  <span className="settings-version">v{layout.layout.overlayVersion}</span>
                ) : null}
              </div>
              {layout.layout ? (
                <>
                  <dl>
                    <div>
                      <dt>Effective source</dt>
                      <dd>{layoutSourceLabel(layout.layout.source)}</dd>
                    </div>
                    <div>
                      <dt>Published base</dt>
                      <dd>Version {layout.layout.baseVersion}</dd>
                    </div>
                    <div>
                      <dt>Personal overlay</dt>
                      <dd>
                        {layout.layout.overlayVersion > 0
                          ? `Version ${layout.layout.overlayVersion}`
                          : "Not set"}
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="command-button"
                    disabled={busy || layout.layout.overlayVersion < 1}
                    onClick={() => resetLayout(layout)}
                    type="button"
                  >
                    Reset personal layout
                  </button>
                </>
              ) : (
                <p className="settings-empty">This layout is currently unavailable.</p>
              )}
            </article>
          ))}
        </div>
      </section>

      {preferences?.canManageTenantDefaults && tenant ? (
        <section aria-labelledby="tenant-settings-heading" className="settings-section">
          <header>
            <p className="settings-section-index">04</p>
            <div>
              <h2 id="tenant-settings-heading">Tenant presentation defaults</h2>
              <p>
                Authorized defaults and accessibility floors apply without changing domain data.
              </p>
            </div>
          </header>
          <article className="universal-settings-card settings-form-card tenant-settings-card">
            <div className="form-grid-two">
              <label className="form-field">
                <span>Default palette</span>
                <select
                  disabled={busy}
                  onChange={(event) =>
                    updateTenantDraft({
                      palette: event.target.value as TenantPresentationDraft["palette"],
                    })
                  }
                  value={tenant.palette}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="form-field">
                <span>Default density</span>
                <select
                  disabled={busy}
                  onChange={(event) =>
                    updateTenantDraft({
                      density: event.target.value as TenantPresentationDraft["density"],
                    })
                  }
                  value={tenant.density}
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
            </div>
            <label className="settings-choice-row">
              <input
                checked={tenant.lockDensity}
                disabled={busy}
                onChange={(event) => updateTenantDraft({ lockDensity: event.target.checked })}
                type="checkbox"
              />
              Lock the selected density
            </label>
            <label className="settings-choice-row">
              <input
                checked={tenant.highContrast}
                disabled={busy || tenant.requireHighContrast}
                onChange={(event) => updateTenantDraft({ highContrast: event.target.checked })}
                type="checkbox"
              />
              Default to high contrast
            </label>
            <label className="settings-choice-row">
              <input
                checked={tenant.reducedMotion === "reduce"}
                disabled={busy || tenant.requireReducedMotion}
                onChange={(event) =>
                  updateTenantDraft({
                    reducedMotion: event.target.checked ? "reduce" : "auto",
                  })
                }
                type="checkbox"
              />
              Default to reduced motion
            </label>
            <label className="settings-choice-row">
              <input
                checked={tenant.requireHighContrast}
                disabled={busy}
                onChange={(event) =>
                  updateTenantDraft({
                    highContrast: event.target.checked ? true : tenant.highContrast,
                    requireHighContrast: event.target.checked,
                  })
                }
                type="checkbox"
              />
              Require high contrast
            </label>
            <label className="settings-choice-row">
              <input
                checked={tenant.requireReducedMotion}
                disabled={busy}
                onChange={(event) =>
                  updateTenantDraft({
                    reducedMotion: event.target.checked ? "reduce" : tenant.reducedMotion,
                    requireReducedMotion: event.target.checked,
                  })
                }
                type="checkbox"
              />
              Require reduced motion
            </label>
            <div className="settings-actions">
              <button
                className="command-button command-button-primary"
                disabled={busy}
                onClick={saveTenantDefaults}
                type="button"
              >
                Save tenant defaults
              </button>
              <button
                className="command-button"
                disabled={busy || preferences.tenantVersion < 1}
                onClick={resetTenantDefaults}
                type="button"
              >
                Restore Product defaults
              </button>
            </div>
          </article>
        </section>
      ) : null}
    </div>
  );
}
