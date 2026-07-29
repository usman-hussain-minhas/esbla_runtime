"use client";

import type {
  PresentationNavigationDiscovery,
  PresentationShortcutDiscovery,
} from "@esbla/contracts";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildZenNavigationModel,
  type ZenNavigationModel,
} from "../../../../lib/presentation-navigation-core";
import {
  resolveZenResponsiveChrome,
  type ZenResponsiveChromeResult,
} from "../../../../lib/zen-responsive-chrome-core";
import { UserSystemControl, type ZenSystemPanelState } from "../panels/zen-system-panel";
import {
  consumeRouteHeadingFocus,
  type ZenDirectOpenMenu,
  ZenNavigationChrome,
} from "./zen-navigation-chrome";
import { ZenShortcutChrome, type ZenShortcutScope } from "./zen-shortcut-chrome";

type ZenChromeLayer =
  | { readonly family: "navigation"; readonly menu: Exclude<ZenDirectOpenMenu, undefined> }
  | { readonly family: "shortcuts"; readonly scope: ZenShortcutScope }
  | { readonly family: "system"; readonly state: ZenSystemPanelState }
  | undefined;

function initialResolution(
  model: ZenNavigationModel,
  appearanceAvailable: boolean,
): ZenResponsiveChromeResult {
  return {
    breakpoint: "desktop",
    collapsed: [],
    direct: [
      ...(model.contextualMenu ? (["contextual"] as const) : []),
      ...(model.serviceGroups.length > 0 ? (["service-groups"] as const) : []),
      ...(appearanceAvailable ? (["appearance"] as const) : []),
    ],
    systemRequired: appearanceAvailable,
  };
}

function sameResolution(
  left: ZenResponsiveChromeResult,
  right: ZenResponsiveChromeResult,
): boolean {
  return (
    left.breakpoint === right.breakpoint &&
    left.systemRequired === right.systemRequired &&
    left.collapsed.join("\0") === right.collapsed.join("\0") &&
    left.direct.join("\0") === right.direct.join("\0")
  );
}

export function ZenShellChrome({
  appearanceAvailable,
  discovery,
  shortcutDiscovery,
}: Readonly<{
  appearanceAvailable: boolean;
  discovery: PresentationNavigationDiscovery;
  shortcutDiscovery: PresentationShortcutDiscovery | undefined;
}>) {
  const pathname = usePathname();
  const model = useMemo(() => buildZenNavigationModel(discovery, pathname), [discovery, pathname]);
  const [layer, setLayer] = useState<ZenChromeLayer>();
  const activeLayer = useRef(layer);
  const [resolution, setResolution] = useState(() => initialResolution(model, appearanceAvailable));
  const buttonProbe = useRef<HTMLSpanElement>(null);
  const clusterGapProbe = useRef<HTMLSpanElement>(null);
  const controlGapProbe = useRef<HTMLSpanElement>(null);
  const endInsetProbe = useRef<HTMLSpanElement>(null);
  const previousPathname = useRef(pathname);
  const startInsetProbe = useRef<HTMLSpanElement>(null);
  activeLayer.current = layer;

  const measure = useCallback(() => {
    const buttonInlineSize = buttonProbe.current?.getBoundingClientRect().width ?? 0;
    const clusterGap = clusterGapProbe.current?.getBoundingClientRect().width ?? 0;
    const controlGap = controlGapProbe.current?.getBoundingClientRect().width ?? 0;
    const endInset = endInsetProbe.current?.getBoundingClientRect().width ?? 0;
    const startInset = startInsetProbe.current?.getBoundingClientRect().width ?? 0;
    const next = resolveZenResponsiveChrome({
      availableInlineSize: document.documentElement.clientWidth,
      buttonInlineSize,
      clusterGap,
      controlGap,
      endInset,
      hasAppearance: appearanceAvailable,
      hasContextualMenu: Boolean(model.contextualMenu),
      hasServiceGroups: model.serviceGroups.length > 0,
      startInset,
    });
    setResolution((current) => (sameResolution(current, next) ? current : next));
    setLayer((current) => {
      if (current?.family === "navigation" && !next.direct.includes(current.menu)) {
        return {
          family: "system",
          state: { origin: "system", view: current.menu },
        };
      }
      if (
        current?.family === "system" &&
        current.state.origin === "theme" &&
        !next.direct.includes("appearance")
      ) {
        return {
          family: "system",
          state: { origin: "system", view: current.state.view },
        };
      }
      return current;
    });
  }, [appearanceAvailable, model.contextualMenu, model.serviceGroups.length]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure);
    const probes = [
      buttonProbe.current,
      clusterGapProbe.current,
      controlGapProbe.current,
      endInsetProbe.current,
      startInsetProbe.current,
    ].filter((probe): probe is HTMLSpanElement => probe !== null);
    const observer = new ResizeObserver(measure);
    for (const probe of probes) observer.observe(probe);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    const routeFocusRequested = consumeRouteHeadingFocus(pathname);
    const pathnameChanged = previousPathname.current !== pathname;
    if (!pathnameChanged && !routeFocusRequested) return;
    if (pathnameChanged) previousPathname.current = pathname;
    const chromeWasOpen = activeLayer.current !== undefined;
    if (pathnameChanged) setLayer(undefined);
    if (!chromeWasOpen && !routeFocusRequested) return;
    let observer: MutationObserver | undefined;
    let focusFrame: number | undefined;
    let focusedHeading: HTMLElement | undefined;
    let queuedHeading: HTMLElement | undefined;
    let queuedHeadingText: string | null | undefined;
    let settledFrame: number | undefined;
    let timeout: number | undefined;
    let explicitFocusIntervention = false;
    let transitionOwnsFocus = true;
    const cancelQueuedFocus = () => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      if (settledFrame !== undefined) cancelAnimationFrame(settledFrame);
      focusFrame = undefined;
      settledFrame = undefined;
    };
    const recordExplicitFocusIntervention = () => {
      explicitFocusIntervention = true;
    };
    const releaseRouteFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("main h1")) {
        focusedHeading = target;
        return;
      }
      if (
        !explicitFocusIntervention &&
        target instanceof HTMLElement &&
        target.closest(".zen-shell-chrome")
      ) {
        return;
      }
      transitionOwnsFocus = false;
      cancelQueuedFocus();
      observer?.disconnect();
      if (timeout !== undefined) window.clearTimeout(timeout);
      document.removeEventListener("focusin", releaseRouteFocus, true);
      document.removeEventListener("keydown", recordExplicitFocusIntervention, true);
      document.removeEventListener("pointerdown", recordExplicitFocusIntervention, true);
    };
    const queueCurrentHeadingFocus = (force: boolean) => {
      if (!transitionOwnsFocus) return;
      const heading = document.querySelector<HTMLElement>("main h1");
      if (!heading) return;
      const headingText = heading.textContent;
      if (!force && heading === queuedHeading && headingText === queuedHeadingText) return;
      const routeFocusRequired = force || focusedHeading === undefined;
      queuedHeading = heading;
      queuedHeadingText = headingText;
      cancelQueuedFocus();
      focusFrame = requestAnimationFrame(() => {
        settledFrame = requestAnimationFrame(() => {
          const currentHeading = document.querySelector<HTMLElement>("main h1");
          if (!currentHeading) return;
          const activeElement = document.activeElement;
          if (
            !routeFocusRequired &&
            activeElement !== document.body &&
            activeElement !== focusedHeading &&
            activeElement?.isConnected
          ) {
            return;
          }
          currentHeading.tabIndex = -1;
          focusedHeading = currentHeading;
          queuedHeading = currentHeading;
          queuedHeadingText = currentHeading.textContent;
          currentHeading.focus();
        });
      });
    };
    document.addEventListener("focusin", releaseRouteFocus, true);
    document.addEventListener("keydown", recordExplicitFocusIntervention, true);
    document.addEventListener("pointerdown", recordExplicitFocusIntervention, true);
    observer = new MutationObserver(() => queueCurrentHeadingFocus(false));
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    queueCurrentHeadingFocus(true);
    timeout = window.setTimeout(() => {
      observer?.disconnect();
      cancelQueuedFocus();
      document.removeEventListener("focusin", releaseRouteFocus, true);
      document.removeEventListener("keydown", recordExplicitFocusIntervention, true);
      document.removeEventListener("pointerdown", recordExplicitFocusIntervention, true);
    }, 5_000);
    return () => {
      document.removeEventListener("focusin", releaseRouteFocus, true);
      document.removeEventListener("keydown", recordExplicitFocusIntervention, true);
      document.removeEventListener("pointerdown", recordExplicitFocusIntervention, true);
      observer?.disconnect();
      cancelQueuedFocus();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [pathname]);

  const onOpenMenuChange = useCallback((menu: ZenDirectOpenMenu) => {
    setLayer(menu ? { family: "navigation", menu } : undefined);
  }, []);
  const onOpenSystemStateChange = useCallback((state: ZenSystemPanelState | undefined) => {
    setLayer(state ? { family: "system", state } : undefined);
  }, []);
  const onOpenShortcutScopeChange = useCallback((scope: ZenShortcutScope | undefined) => {
    setLayer(scope ? { family: "shortcuts", scope } : undefined);
  }, []);

  const openMenu = layer?.family === "navigation" ? layer.menu : undefined;
  const openShortcutScope = layer?.family === "shortcuts" ? layer.scope : undefined;
  const openSystemState = layer?.family === "system" ? layer.state : undefined;
  const collapsedMenus = new Set<Exclude<ZenDirectOpenMenu, undefined>>();
  if (resolution.collapsed.includes("contextual")) collapsedMenus.add("contextual");
  if (resolution.collapsed.includes("service-groups")) collapsedMenus.add("service-groups");

  return (
    <div
      className="zen-shell-chrome"
      data-collapsed-controls={resolution.collapsed.join(" ")}
      data-responsive-class={resolution.breakpoint}
    >
      <ZenNavigationChrome
        model={model}
        onOpenMenuChange={onOpenMenuChange}
        openMenu={openMenu}
        showContextualMenu={resolution.direct.includes("contextual")}
        showServiceGroups={resolution.direct.includes("service-groups")}
      />

      <div className="system-controls">
        <UserSystemControl
          appearanceAvailable={appearanceAvailable}
          collapsedMenus={collapsedMenus}
          model={model}
          onOpenStateChange={onOpenSystemStateChange}
          openState={openSystemState}
          showAppearanceDirect={resolution.direct.includes("appearance")}
          systemRequired={resolution.systemRequired}
        />
      </div>

      {shortcutDiscovery ? (
        <ZenShortcutChrome
          initialDiscovery={shortcutDiscovery}
          key={`${pathname}:${shortcutDiscovery.universal.version}:${
            shortcutDiscovery.contextual?.version ?? "none"
          }`}
          onOpenScopeChange={onOpenShortcutScopeChange}
          openScope={openShortcutScope}
          responsiveClass={resolution.breakpoint}
        />
      ) : null}

      <div aria-hidden="true" className="zen-chrome-measure">
        <span className="zen-chrome-button-probe" ref={buttonProbe} />
        <span className="zen-chrome-cluster-gap-probe" ref={clusterGapProbe} />
        <span className="zen-chrome-control-gap-probe" ref={controlGapProbe} />
        <span className="zen-chrome-end-inset-probe" ref={endInsetProbe} />
        <span className="zen-chrome-start-inset-probe" ref={startInsetProbe} />
      </div>
    </div>
  );
}
