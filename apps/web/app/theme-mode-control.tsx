"use client";

import { parseUpdatePresentationPreferencesResponse } from "@esbla/contracts";
import { ArrowLeft, Check, Palette } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { SemanticIcon } from "../theme/zen-theme/v1/semantic-icons";
import { ESBLA_THEME_CACHE_KEY, type EsblaThemePalette } from "./theme-contract";

interface AppearanceState {
  readonly highContrast: boolean;
  readonly palette: EsblaThemePalette;
  readonly version: number;
}

type PanelState =
  | {
      readonly launcher: "system" | "theme";
      readonly panel: "appearance" | "system";
    }
  | undefined;

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
    localStorage.setItem(ESBLA_THEME_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Browser storage is a disposable hydration cache, never preference authority.
  }
}

export function UserSystemControl() {
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
  const [openState, setOpenState] = useState<PanelState>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setAppearance(currentAppearance());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!openState) return;
    const frame = requestAnimationFrame(() => panelHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [openState]);

  useEffect(() => {
    if (!openState) return;
    const restoreLauncher = () => {
      const launcher =
        openState.launcher === "system" ? systemLauncher.current : themeLauncher.current;
      setOpenState(undefined);
      requestAnimationFrame(() => launcher?.focus());
    };
    function dismiss(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) restoreLauncher();
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") restoreLauncher();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [openState]);

  function closePanel() {
    const launcher =
      openState?.launcher === "system" ? systemLauncher.current : themeLauncher.current;
    setOpenState(undefined);
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

  return (
    <div className="theme-control" ref={root}>
      <button
        aria-controls={panelId}
        aria-expanded={openState?.launcher === "system"}
        aria-label="User and system"
        className="chrome-button system-launcher"
        disabled={!hydrated}
        onClick={() =>
          setOpenState((value) =>
            value?.launcher === "system" ? undefined : { launcher: "system", panel: "system" },
          )
        }
        ref={systemLauncher}
        title="User and system"
        type="button"
      >
        <SemanticIcon aria-hidden="true" semanticKey="user" size={18} strokeWidth={1.75} />
      </button>
      <button
        aria-controls={panelId}
        aria-expanded={openState?.launcher === "theme"}
        aria-label="Appearance settings"
        className="chrome-button theme-direct-launcher"
        disabled={!hydrated}
        onClick={() =>
          setOpenState((value) =>
            value?.launcher === "theme" ? undefined : { launcher: "theme", panel: "appearance" },
          )
        }
        ref={themeLauncher}
        title="Appearance"
        type="button"
      >
        <Palette aria-hidden="true" size={18} strokeWidth={1.75} />
      </button>
      {openState ? (
        <section
          aria-label={openState.panel === "system" ? "User and system" : "Appearance settings"}
          className="theme-panel"
          id={panelId}
        >
          <header>
            <div>
              <p className="panel-kicker">
                {openState.panel === "system" ? "Universal controls" : "Universal preference"}
              </p>
              <h2 ref={panelHeading} tabIndex={-1}>
                {openState.panel === "system" ? "User and system" : "Appearance"}
              </h2>
            </div>
            <div className="panel-header-actions">
              {openState.panel === "appearance" && openState.launcher === "system" ? (
                <button
                  aria-label="Back to user and system"
                  className="icon-command"
                  onClick={() => setOpenState({ launcher: "system", panel: "system" })}
                  type="button"
                >
                  <ArrowLeft aria-hidden="true" size={17} />
                </button>
              ) : null}
              <button
                aria-label={
                  openState.panel === "system"
                    ? "Close user and system"
                    : "Close appearance settings"
                }
                className="icon-command"
                onClick={closePanel}
                type="button"
              >
                <SemanticIcon aria-hidden="true" semanticKey="x" size={17} />
              </button>
            </div>
          </header>
          {openState.panel === "system" ? (
            <button
              aria-label="Appearance"
              className="theme-choice theme-choice-wide"
              onClick={() => setOpenState({ launcher: "system", panel: "appearance" })}
              type="button"
            >
              <Palette aria-hidden="true" size={17} />
              <span>Appearance</span>
              <span aria-hidden="true">›</span>
            </button>
          ) : (
            <>
              <fieldset disabled={pending}>
                <legend>Palette</legend>
                {(["light", "dark"] as const).map((palette) => {
                  return (
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
                      {appearance.palette === palette ? (
                        <Check aria-hidden="true" size={15} />
                      ) : null}
                    </button>
                  );
                })}
              </fieldset>
              <button
                aria-pressed={appearance.highContrast}
                className="theme-choice theme-choice-wide"
                disabled={pending}
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
          )}
        </section>
      ) : null}
    </div>
  );
}
