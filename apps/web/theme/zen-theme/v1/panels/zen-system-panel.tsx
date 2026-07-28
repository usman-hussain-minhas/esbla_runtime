"use client";

import { parseUpdatePresentationPreferencesResponse } from "@esbla/contracts";
import { Check } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { ZenNavigationModel } from "../../../../lib/presentation-navigation-core";
import { prepareRouteHeadingFocus, type ZenDirectOpenMenu } from "../chrome/zen-navigation-chrome";
import { ZEN_THEME_CACHE_KEY, type ZenPalette } from "../identity";
import { SemanticIcon } from "../semantic-icons";

interface AppearanceState {
  readonly highContrast: boolean;
  readonly palette: ZenPalette;
  readonly version: number;
}

export type ZenSystemPanelView = "appearance" | "contextual" | "service-groups" | "system";

export interface ZenSystemPanelState {
  readonly origin: "system" | "theme";
  readonly view: ZenSystemPanelView;
}

function currentAppearance(): AppearanceState {
  const root = document.documentElement;
  return {
    highContrast: root.dataset.highContrast === "true",
    palette: root.dataset.palette === "dark" ? "dark" : "light",
    version: Number.isSafeInteger(Number(root.dataset.preferenceVersion))
      ? Math.max(0, Number(root.dataset.preferenceVersion))
      : 0,
  };
}

function applyAppearance(next: AppearanceState) {
  const root = document.documentElement;
  root.dataset.palette = next.palette;
  root.dataset.highContrast = String(next.highContrast);
  root.dataset.preferenceVersion = String(next.version);
  root.dataset.preferenceStatus = "authoritative";
  root.style.colorScheme = next.palette;
  try {
    localStorage.setItem(ZEN_THEME_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Browser storage is a disposable hydration cache, never preference authority.
  }
}

function panelLabel(view: ZenSystemPanelView, model: ZenNavigationModel): string {
  if (view === "appearance") return "Appearance settings";
  if (view === "contextual") return model.contextualMenu?.label ?? "Current pages";
  if (view === "service-groups") return "Service Groups";
  return "User and system";
}

function panelHeadingText(view: ZenSystemPanelView, model: ZenNavigationModel): string {
  if (view === "appearance") return "Appearance";
  if (view === "contextual") return model.contextualMenu?.label ?? "Current pages";
  if (view === "service-groups") return "Service Groups";
  return "User and system";
}

export function UserSystemControl({
  appearanceAvailable,
  collapsedMenus,
  model,
  onOpenStateChange,
  openState,
  showAppearanceDirect,
  systemRequired,
}: Readonly<{
  appearanceAvailable: boolean;
  collapsedMenus: ReadonlySet<Exclude<ZenDirectOpenMenu, undefined>>;
  model: ZenNavigationModel;
  onOpenStateChange: (state: ZenSystemPanelState | undefined) => void;
  openState: ZenSystemPanelState | undefined;
  showAppearanceDirect: boolean;
  systemRequired: boolean;
}>) {
  const pathname = usePathname();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const systemLauncher = useRef<HTMLButtonElement>(null);
  const themeLauncher = useRef<HTMLButtonElement>(null);
  const [appearance, setAppearance] = useState<AppearanceState>({
    highContrast: false,
    palette: "light",
    version: 0,
  });
  const [error, setError] = useState<string>();
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setAppearance(currentAppearance());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!openState) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelHeading.current?.closest<HTMLElement>(".theme-panel");
      if (openState.view === "contextual" || openState.view === "service-groups") {
        panel?.querySelector<HTMLElement>("a[href]")?.focus();
        return;
      }
      panelHeading.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [openState]);

  useEffect(() => {
    if (!openState) return;
    const activeState = openState;
    const restoreLauncher = () => {
      const launcher =
        activeState.origin === "system" ? systemLauncher.current : themeLauncher.current;
      onOpenStateChange(undefined);
      requestAnimationFrame(() => launcher?.focus());
    };
    function dismiss(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) restoreLauncher();
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (activeState.origin === "system" && activeState.view !== "system") {
        onOpenStateChange({ origin: "system", view: "system" });
        return;
      }
      restoreLauncher();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [onOpenStateChange, openState]);

  function closePanel() {
    const launcher =
      openState?.origin === "system" ? systemLauncher.current : themeLauncher.current;
    onOpenStateChange(undefined);
    requestAnimationFrame(() => launcher?.focus());
  }

  async function persist(next: Omit<AppearanceState, "version">) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/presentation/preferences", {
        body: JSON.stringify({
          expectedVersion: appearance.version,
          highContrast: next.highContrast,
          idempotencyKey: crypto.randomUUID(),
          palette: next.palette,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.status !== 200) throw new Error("unavailable");
      const body = parseUpdatePresentationPreferencesResponse(await response.json());
      const updated: AppearanceState = {
        highContrast: body.highContrast,
        palette: body.palette,
        version: body.version,
      };
      applyAppearance(updated);
      setAppearance(updated);
    } catch {
      setError("Appearance could not be saved. Your previous setting is still active.");
    } finally {
      setPending(false);
    }
  }

  if (!systemRequired) return null;

  const systemExpanded = openState?.origin === "system";
  const themeExpanded = openState?.origin === "theme";
  const label = openState ? panelLabel(openState.view, model) : "User and system";

  return (
    <div className="theme-control" ref={root}>
      <button
        aria-controls={panelId}
        aria-expanded={systemExpanded}
        aria-label="User and system"
        className="chrome-button system-launcher"
        data-tooltip="User and system"
        onClick={() =>
          onOpenStateChange(systemExpanded ? undefined : { origin: "system", view: "system" })
        }
        ref={systemLauncher}
        type="button"
      >
        <SemanticIcon aria-hidden="true" semanticKey="user" size={18} strokeWidth={1.75} />
      </button>
      {appearanceAvailable && showAppearanceDirect ? (
        <button
          aria-controls={panelId}
          aria-expanded={themeExpanded}
          aria-label="Appearance settings"
          className="chrome-button theme-direct-launcher"
          data-tooltip="Appearance settings"
          disabled={!hydrated}
          onClick={() =>
            onOpenStateChange(themeExpanded ? undefined : { origin: "theme", view: "appearance" })
          }
          ref={themeLauncher}
          type="button"
        >
          <SemanticIcon
            aria-hidden="true"
            semanticKey={appearance.palette === "dark" ? "moon" : "sun"}
            size={18}
            strokeWidth={1.75}
          />
        </button>
      ) : null}
      {openState ? (
        <section aria-label={label} className="theme-panel" id={panelId}>
          <header>
            <div>
              <p className="panel-kicker">
                {openState.view === "system"
                  ? "Universal controls"
                  : openState.view === "appearance"
                    ? "Universal preference"
                    : "Available navigation"}
              </p>
              <h2 ref={panelHeading} tabIndex={-1}>
                {panelHeadingText(openState.view, model)}
              </h2>
            </div>
            <div className="panel-header-actions">
              {openState.origin === "system" && openState.view !== "system" ? (
                <button
                  className="panel-back-command"
                  onClick={() => onOpenStateChange({ origin: "system", view: "system" })}
                  type="button"
                >
                  Back
                </button>
              ) : null}
              <button
                aria-label={`Close ${label.toLowerCase()}`}
                className="icon-command"
                data-tooltip={`Close ${label.toLowerCase()}`}
                onClick={closePanel}
                type="button"
              >
                <SemanticIcon aria-hidden="true" semanticKey="x" size={17} />
              </button>
            </div>
          </header>

          {openState.view === "system" ? (
            <div className="system-panel-choices">
              {collapsedMenus.has("contextual") && model.contextualMenu ? (
                <button
                  className="theme-choice theme-choice-wide"
                  onClick={() => onOpenStateChange({ origin: "system", view: "contextual" })}
                  type="button"
                >
                  <SemanticIcon aria-hidden="true" semanticKey="menu" size={17} />
                  <span>{model.contextualMenu.label}</span>
                  <span aria-hidden="true">›</span>
                </button>
              ) : null}
              {collapsedMenus.has("service-groups") && model.serviceGroups.length > 0 ? (
                <button
                  className="theme-choice theme-choice-wide"
                  onClick={() => onOpenStateChange({ origin: "system", view: "service-groups" })}
                  type="button"
                >
                  <SemanticIcon aria-hidden="true" semanticKey="modules" size={17} />
                  <span>Service Groups</span>
                  <span aria-hidden="true">›</span>
                </button>
              ) : null}
              {appearanceAvailable ? (
                <button
                  className="theme-choice theme-choice-wide"
                  onClick={() => onOpenStateChange({ origin: "system", view: "appearance" })}
                  type="button"
                >
                  <SemanticIcon
                    aria-hidden="true"
                    semanticKey={appearance.palette === "dark" ? "moon" : "sun"}
                    size={17}
                  />
                  <span>Appearance</span>
                  <span aria-hidden="true">›</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {openState.view === "contextual" && model.contextualMenu ? (
            <nav aria-label={model.contextualMenu.label} className="system-panel-navigation">
              {model.contextualMenu.destinations.map((destination) => (
                <Link
                  aria-current={
                    destination.id === model.contextualMenu?.activeDestinationId
                      ? "page"
                      : undefined
                  }
                  className="chrome-popover-link"
                  href={destination.href}
                  key={destination.id}
                  onClick={(event) => {
                    prepareRouteHeadingFocus(event);
                    onOpenStateChange(undefined);
                  }}
                >
                  <SemanticIcon
                    aria-hidden="true"
                    semanticKey={destination.semanticIcon}
                    size={18}
                    strokeWidth={1.75}
                  />
                  <span>{destination.label}</span>
                </Link>
              ))}
            </nav>
          ) : null}

          {openState.view === "service-groups" ? (
            <nav aria-label="Eligible service groups" className="system-panel-navigation">
              {model.serviceGroups.map((group) => (
                <Link
                  aria-current={
                    pathname === group.href || pathname.startsWith(`${group.href}/`)
                      ? "page"
                      : undefined
                  }
                  className="chrome-popover-link"
                  href={group.href}
                  key={group.serviceGroupId}
                  onClick={(event) => {
                    prepareRouteHeadingFocus(event);
                    onOpenStateChange(undefined);
                  }}
                >
                  <SemanticIcon
                    aria-hidden="true"
                    semanticKey={group.semanticIcon}
                    size={18}
                    strokeWidth={1.75}
                  />
                  <span>{group.label}</span>
                </Link>
              ))}
            </nav>
          ) : null}

          {openState.view === "appearance" ? (
            <>
              <fieldset disabled={pending || !hydrated}>
                <legend>Palette</legend>
                {(["light", "dark"] as const).map((palette) => (
                  <button
                    aria-pressed={appearance.palette === palette}
                    className="theme-choice"
                    key={palette}
                    onClick={() => persist({ ...appearance, palette })}
                    type="button"
                  >
                    <SemanticIcon
                      aria-hidden="true"
                      semanticKey={palette === "light" ? "sun" : "moon"}
                      size={17}
                    />
                    <span>{palette === "light" ? "Light" : "Dark"}</span>
                    {appearance.palette === palette ? <Check aria-hidden="true" size={15} /> : null}
                  </button>
                ))}
              </fieldset>
              <button
                aria-pressed={appearance.highContrast}
                className="theme-choice theme-choice-wide"
                disabled={pending || !hydrated}
                onClick={() => persist({ ...appearance, highContrast: !appearance.highContrast })}
                type="button"
              >
                <SemanticIcon aria-hidden="true" semanticKey="contrast" size={17} />
                <span>High contrast</span>
                {appearance.highContrast ? <Check aria-hidden="true" size={15} /> : null}
              </button>
              {pending ? (
                <p aria-live="polite" className="panel-note">
                  Saving preference…
                </p>
              ) : null}
              {error ? (
                <p className="panel-error" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
