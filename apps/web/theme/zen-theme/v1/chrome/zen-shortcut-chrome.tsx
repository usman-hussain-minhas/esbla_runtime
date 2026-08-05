"use client";

import {
  getPresentationShortcutContextLabel,
  type PresentationShortcutDiscovery,
  type PresentationShortcutSet,
  type PresentationShortcutTarget,
  parseUpdatePresentationShortcutResponse,
  type ZenV1SurfaceId,
} from "@esbla/contracts";
import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { replacePresentationShortcutSet } from "../../../../lib/presentation-shortcuts-core";
import type { ZenResponsiveChromeResult } from "../../../../lib/zen-responsive-chrome-core";
import { resolveZenShortcutVisibleItemCount } from "../../../../lib/zen-shortcut-layout-core";
import { SemanticIcon } from "../semantic-icons";
import { prepareRouteHeadingFocus } from "./zen-navigation-chrome";

export type ZenShortcutScope = "contextual" | "universal";

function scopeLabel(scope: ZenShortcutScope, set: PresentationShortcutSet): string {
  if (scope === "universal") return "Universal shortcuts";
  if (set.contextKind === "surface") {
    return `${getPresentationShortcutContextLabel(set.contextKind, set.contextId)} shortcuts`;
  }
  return `${set.contextId.toUpperCase()} shortcuts`;
}

function ShortcutLink({
  onNavigate,
  scope,
  target,
}: Readonly<{
  onNavigate: () => void;
  scope: ZenShortcutScope;
  target: PresentationShortcutTarget;
}>) {
  return (
    <Link
      aria-label={target.label}
      className={`chrome-button zen-shortcut-button zen-shortcut-${scope}-button`}
      data-tooltip={target.label}
      href={target.href}
      onClick={(event) => {
        prepareRouteHeadingFocus(event);
        onNavigate();
      }}
    >
      <SemanticIcon
        aria-hidden="true"
        semanticKey={target.semanticIcon}
        size={18}
        strokeWidth={1.75}
      />
    </Link>
  );
}

function ShortcutPicker({
  error,
  mode,
  onCatalogModeChange,
  onClose,
  onMutate,
  pendingTargetId,
  scope,
  set,
}: Readonly<{
  error: string | undefined;
  mode: "catalog" | "list";
  onCatalogModeChange: (catalogOpen: boolean) => void;
  onClose: () => void;
  onMutate: (
    set: PresentationShortcutSet,
    target: PresentationShortcutTarget,
    operation: "append" | "remove",
  ) => void;
  pendingTargetId: string | undefined;
  scope: ZenShortcutScope;
  set: PresentationShortcutSet;
}>) {
  const heading = useRef<HTMLHeadingElement>(null);
  const label = scopeLabel(scope, set);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (heading.current?.dataset.shortcutMode === mode) heading.current.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);
  const selectedIds = new Set(set.items.map(({ id }) => id));
  const availableTargets = set.eligibleTargets.filter(({ id }) => !selectedIds.has(id));
  const catalogOpen = mode === "catalog";
  return (
    <section
      aria-label={label}
      className={`zen-shortcut-panel zen-shortcut-${scope}-panel`}
      role="dialog"
    >
      <header>
        <div>
          <p className="panel-kicker">
            {catalogOpen
              ? "Registered destinations"
              : scope === "universal"
                ? "Available everywhere"
                : set.contextKind === "surface"
                  ? "Current surface"
                  : "Current service"}
          </p>
          <h2 data-shortcut-mode={mode} ref={heading} tabIndex={-1}>
            {catalogOpen ? `Add to ${label.toLowerCase()}` : label}
          </h2>
        </div>
        <div className="panel-header-actions">
          {catalogOpen ? (
            <button
              className="panel-back-command"
              onClick={() => onCatalogModeChange(false)}
              type="button"
            >
              Back
            </button>
          ) : null}
          <button
            aria-label={`Close ${label.toLowerCase()}`}
            className="icon-command"
            data-tooltip={`Close ${label.toLowerCase()}`}
            onClick={onClose}
            type="button"
          >
            <SemanticIcon aria-hidden="true" semanticKey="x" size={17} />
          </button>
        </div>
      </header>

      {catalogOpen ? (
        <div className="zen-shortcut-picker-grid">
          {availableTargets.map((target) => (
            <button
              aria-label={`Add ${target.label} to ${label}`}
              className="zen-shortcut-picker-item zen-shortcut-catalog-item"
              disabled={pendingTargetId !== undefined}
              key={target.id}
              onClick={() => onMutate(set, target, "append")}
              type="button"
            >
              <span className="zen-shortcut-picker-link">
                <SemanticIcon
                  aria-hidden="true"
                  semanticKey={target.semanticIcon}
                  size={20}
                  strokeWidth={1.75}
                />
                <span>{target.label}</span>
              </span>
              <span aria-hidden="true" className="zen-shortcut-picker-action">
                <SemanticIcon semanticKey="plus" size={15} strokeWidth={2} />
              </span>
            </button>
          ))}
        </div>
      ) : set.items.length > 0 || set.editable ? (
        <div className="zen-shortcut-picker-grid">
          {set.items.map((target) => (
            <article className="zen-shortcut-picker-item" data-selected="true" key={target.id}>
              <Link
                className="zen-shortcut-picker-link"
                href={target.href}
                onClick={(event) => {
                  prepareRouteHeadingFocus(event);
                  onClose();
                }}
              >
                <SemanticIcon
                  aria-hidden="true"
                  semanticKey={target.semanticIcon}
                  size={20}
                  strokeWidth={1.75}
                />
                <span>{target.label}</span>
              </Link>
              {set.editable ? (
                <button
                  aria-label={`Remove ${target.label} from ${label}`}
                  className="zen-shortcut-picker-action"
                  disabled={pendingTargetId !== undefined}
                  onClick={() => onMutate(set, target, "remove")}
                  type="button"
                >
                  <SemanticIcon aria-hidden="true" semanticKey="x" size={15} strokeWidth={2} />
                </button>
              ) : null}
            </article>
          ))}
          {set.editable && availableTargets.length > 0 ? (
            <button
              className="zen-shortcut-add-item"
              onClick={() => onCatalogModeChange(true)}
              type="button"
            >
              <SemanticIcon aria-hidden="true" semanticKey="plus" size={20} strokeWidth={1.8} />
              <span>Add shortcut</span>
            </button>
          ) : null}
        </div>
      ) : (
        <p className="panel-note">No shortcuts are available for this scope.</p>
      )}
      {catalogOpen && availableTargets.length === 0 ? (
        <p className="panel-note">All eligible internal destinations are already selected.</p>
      ) : null}
      {set.tombstoneCount > 0 ? (
        <p className="panel-note">
          {set.tombstoneCount} unavailable{" "}
          {set.tombstoneCount === 1 ? "shortcut is" : "shortcuts are"} hidden.
        </p>
      ) : null}
      {pendingTargetId ? (
        <p aria-live="polite" className="panel-note">
          Saving shortcut…
        </p>
      ) : null}
      {error ? (
        <p className="panel-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function ZenShortcutChrome({
  activeSurfaceId,
  initialDiscovery,
  onOpenScopeChange,
  openScope,
  responsiveClass,
}: Readonly<{
  activeSurfaceId: ZenV1SurfaceId | undefined;
  initialDiscovery: PresentationShortcutDiscovery;
  onOpenScopeChange: (scope: ZenShortcutScope | undefined) => void;
  openScope: ZenShortcutScope | undefined;
  responsiveClass: ZenResponsiveChromeResult["breakpoint"];
}>) {
  const universalPanelId = useId();
  const contextualPanelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const universalLauncher = useRef<HTMLButtonElement>(null);
  const contextualLauncher = useRef<HTMLButtonElement>(null);
  const buttonProbe = useRef<HTMLSpanElement>(null);
  const gapProbe = useRef<HTMLSpanElement>(null);
  const startInsetProbe = useRef<HTMLSpanElement>(null);
  const endInsetProbe = useRef<HTMLSpanElement>(null);
  const topChromeProbe = useRef<HTMLSpanElement>(null);
  const [discovery, setDiscovery] = useState(initialDiscovery);
  const [desktopVisibleItems, setDesktopVisibleItems] = useState(5);
  const [error, setError] = useState<string>();
  const [pendingTargetId, setPendingTargetId] = useState<string>();
  const [pickerMode, setPickerMode] = useState<"catalog" | "list">("list");

  const measure = useCallback(() => {
    if (responsiveClass !== "desktop") return;
    const next = resolveZenShortcutVisibleItemCount({
      availableBlockSize: window.visualViewport?.height ?? document.documentElement.clientHeight,
      buttonBlockSize: buttonProbe.current?.getBoundingClientRect().height ?? 0,
      controlGap: gapProbe.current?.getBoundingClientRect().height ?? 0,
      endInset: endInsetProbe.current?.getBoundingClientRect().height ?? 0,
      startInset: startInsetProbe.current?.getBoundingClientRect().height ?? 0,
      topChromeBlockSize: topChromeProbe.current?.getBoundingClientRect().height ?? 0,
    });
    setDesktopVisibleItems((current) => (current === next ? current : next));
  }, [responsiveClass]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure);
    const probes = [
      buttonProbe.current,
      gapProbe.current,
      startInsetProbe.current,
      endInsetProbe.current,
      topChromeProbe.current,
    ].filter((probe): probe is HTMLSpanElement => probe !== null);
    const observer = new ResizeObserver(measure);
    for (const probe of probes) observer.observe(probe);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [measure]);

  useEffect(() => {
    if (!openScope) return;
    const activeScope = openScope;
    const restoreFocus = () => {
      const launcher =
        activeScope === "universal" ? universalLauncher.current : contextualLauncher.current;
      onOpenScopeChange(undefined);
      requestAnimationFrame(() => launcher?.focus());
    };
    function dismissOutside(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) {
        onOpenScopeChange(undefined);
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") restoreFocus();
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [onOpenScopeChange, openScope]);

  async function mutate(
    set: PresentationShortcutSet,
    target: PresentationShortcutTarget,
    operation: "append" | "remove",
  ) {
    if (pendingTargetId || !set.editable) return;
    setPendingTargetId(target.id);
    setError(undefined);
    try {
      const response = await fetch("/presentation/shortcuts", {
        body: JSON.stringify({
          contextId: set.contextId,
          contextKind: set.contextKind,
          expectedVersion: set.version,
          idempotencyKey: crypto.randomUUID(),
          operation,
          settingKey: set.settingKey,
          targetId: target.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.status !== 200) throw new Error("unavailable");
      const updated = parseUpdatePresentationShortcutResponse(await response.json());
      setDiscovery((current) =>
        replacePresentationShortcutSet(current, updated.set, activeSurfaceId),
      );
      if (operation === "append") setPickerMode("list");
    } catch {
      setError("Shortcut could not be saved. Reload this page and try again.");
    } finally {
      setPendingTargetId(undefined);
    }
  }

  const visibleItemCount = responsiveClass === "desktop" ? desktopVisibleItems : 0;
  const universalExpanded = openScope === "universal";
  const contextualExpanded = openScope === "contextual";
  const showUniversalScope =
    discovery.universal.editable ||
    (responsiveClass === "desktop"
      ? discovery.universal.items.length > 0
      : discovery.universal.eligibleTargets.length > 0);
  const showContextualScope =
    discovery.contextual !== null &&
    discovery.contextual.eligibleTargets.length > 0 &&
    (discovery.contextual.editable ||
      (responsiveClass === "desktop"
        ? discovery.contextual.items.length > 0
        : discovery.contextual.eligibleTargets.length > 0));
  const contextualScopeLabel = discovery.contextual
    ? scopeLabel("contextual", discovery.contextual)
    : undefined;
  const toggleScope = (scope: ZenShortcutScope) => {
    setPickerMode("list");
    setError(undefined);
    onOpenScopeChange(openScope === scope ? undefined : scope);
  };
  return (
    <div className="zen-shortcut-controls" ref={root}>
      {showUniversalScope ? (
        <div className="zen-shortcut-stack zen-shortcut-universal">
          {discovery.universal.items.slice(0, visibleItemCount).map((target) => (
            <ShortcutLink
              key={target.id}
              onNavigate={() => onOpenScopeChange(undefined)}
              scope="universal"
              target={target}
            />
          ))}
          {discovery.universal.editable || responsiveClass !== "desktop" ? (
            <button
              aria-controls={universalPanelId}
              aria-expanded={universalExpanded}
              aria-label="Universal shortcuts"
              className="chrome-button zen-shortcut-launcher zen-shortcut-universal-launcher"
              data-tooltip="Universal shortcuts"
              onClick={() => toggleScope("universal")}
              ref={universalLauncher}
              type="button"
            >
              <SemanticIcon
                aria-hidden="true"
                semanticKey={discovery.universal.editable ? "plus" : "menu"}
                size={19}
                strokeWidth={1.8}
              />
            </button>
          ) : null}
        </div>
      ) : null}
      {showContextualScope && discovery.contextual ? (
        <div className="zen-shortcut-stack zen-shortcut-contextual">
          {discovery.contextual.items.slice(0, visibleItemCount).map((target) => (
            <ShortcutLink
              key={target.id}
              onNavigate={() => onOpenScopeChange(undefined)}
              scope="contextual"
              target={target}
            />
          ))}
          {discovery.contextual.editable || responsiveClass !== "desktop" ? (
            <button
              aria-controls={contextualPanelId}
              aria-expanded={contextualExpanded}
              aria-label={contextualScopeLabel}
              className="chrome-button zen-shortcut-launcher zen-shortcut-contextual-launcher"
              data-tooltip={contextualScopeLabel}
              onClick={() => toggleScope("contextual")}
              ref={contextualLauncher}
              type="button"
            >
              <SemanticIcon
                aria-hidden="true"
                semanticKey={discovery.contextual.editable ? "plus" : "menu"}
                size={19}
                strokeWidth={1.8}
              />
            </button>
          ) : null}
        </div>
      ) : null}

      {universalExpanded ? (
        <div id={universalPanelId}>
          <ShortcutPicker
            error={error}
            mode={pickerMode}
            onCatalogModeChange={(catalogOpen) => setPickerMode(catalogOpen ? "catalog" : "list")}
            onClose={() => {
              onOpenScopeChange(undefined);
              requestAnimationFrame(() => universalLauncher.current?.focus());
            }}
            onMutate={mutate}
            pendingTargetId={pendingTargetId}
            scope="universal"
            set={discovery.universal}
          />
        </div>
      ) : null}
      {contextualExpanded && discovery.contextual ? (
        <div id={contextualPanelId}>
          <ShortcutPicker
            error={error}
            mode={pickerMode}
            onCatalogModeChange={(catalogOpen) => setPickerMode(catalogOpen ? "catalog" : "list")}
            onClose={() => {
              onOpenScopeChange(undefined);
              requestAnimationFrame(() => contextualLauncher.current?.focus());
            }}
            onMutate={mutate}
            pendingTargetId={pendingTargetId}
            scope="contextual"
            set={discovery.contextual}
          />
        </div>
      ) : null}

      <div aria-hidden="true" className="zen-shortcut-measure">
        <span className="zen-shortcut-button-probe" ref={buttonProbe} />
        <span className="zen-shortcut-gap-probe" ref={gapProbe} />
        <span className="zen-shortcut-start-inset-probe" ref={startInsetProbe} />
        <span className="zen-shortcut-end-inset-probe" ref={endInsetProbe} />
        <span className="zen-shortcut-top-chrome-probe" ref={topChromeProbe} />
      </div>
    </div>
  );
}
