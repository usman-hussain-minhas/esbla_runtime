"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type MouseEvent, useEffect, useId, useRef } from "react";
import type { ZenNavigationModel } from "../../../../lib/presentation-navigation-core";
import { SemanticIcon } from "../semantic-icons";

export type ZenDirectOpenMenu = "contextual" | "service-groups" | undefined;
const ROUTE_HEADING_FOCUS_KEY = "esbla.zen-navigation.focus-heading";

export function prepareRouteHeadingFocus(event: MouseEvent<HTMLAnchorElement>) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  try {
    window.sessionStorage.setItem(
      ROUTE_HEADING_FOCUS_KEY,
      new URL(event.currentTarget.href).pathname,
    );
  } catch {}
}

export function consumeRouteHeadingFocus(pathname: string): boolean {
  try {
    const targetPathname = window.sessionStorage.getItem(ROUTE_HEADING_FOCUS_KEY);
    if (targetPathname) window.sessionStorage.removeItem(ROUTE_HEADING_FOCUS_KEY);
    return targetPathname === pathname;
  } catch {
    return false;
  }
}

export function ZenNavigationChrome({
  model,
  onOpenMenuChange,
  openMenu,
  showContextualMenu,
  showServiceGroups,
}: Readonly<{
  model: ZenNavigationModel;
  onOpenMenuChange: (menu: ZenDirectOpenMenu) => void;
  openMenu: ZenDirectOpenMenu;
  showContextualMenu: boolean;
  showServiceGroups: boolean;
}>) {
  const pathname = usePathname();
  const contextualMenuId = useId();
  const serviceGroupsMenuId = useId();
  const root = useRef<HTMLElement>(null);
  const contextualLauncher = useRef<HTMLButtonElement>(null);
  const contextualPanel = useRef<HTMLElement>(null);
  const serviceGroupsLauncher = useRef<HTMLButtonElement>(null);
  const serviceGroupsPanel = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (previousPathname.current !== pathname) {
      previousPathname.current = pathname;
      onOpenMenuChange(undefined);
    }
  }, [onOpenMenuChange, pathname]);

  useEffect(() => {
    if (!openMenu) return;
    const panel = openMenu === "contextual" ? contextualPanel.current : serviceGroupsPanel.current;
    const focusFrame = requestAnimationFrame(() =>
      panel?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus(),
    );
    const restoreFocus = () => {
      const launcher =
        openMenu === "contextual" ? contextualLauncher.current : serviceGroupsLauncher.current;
      onOpenMenuChange(undefined);
      requestAnimationFrame(() => launcher?.focus());
    };
    function dismissOutside(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) restoreFocus();
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") restoreFocus();
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [onOpenMenuChange, openMenu]);

  return (
    <nav aria-label="Primary navigation" className="zen-primary-navigation" ref={root}>
      <Link
        aria-label="Mission Control"
        className="chrome-button chrome-home"
        data-tooltip="Mission Control"
        href="/"
        onClick={prepareRouteHeadingFocus}
      >
        <SemanticIcon aria-hidden="true" semanticKey="home" size={19} strokeWidth={1.75} />
      </Link>

      {showContextualMenu && model.contextualMenu ? (
        <div className="zen-contextual-navigation">
          <button
            aria-controls={contextualMenuId}
            aria-expanded={openMenu === "contextual"}
            aria-label={model.contextualMenu.label}
            className="chrome-button chrome-contextual"
            data-tooltip={model.contextualMenu.label}
            onClick={() => onOpenMenuChange(openMenu === "contextual" ? undefined : "contextual")}
            ref={contextualLauncher}
            type="button"
          >
            <SemanticIcon aria-hidden="true" semanticKey="menu" size={19} strokeWidth={1.75} />
          </button>
          {openMenu === "contextual" ? (
            <nav
              aria-label={model.contextualMenu.label}
              className="chrome-popover chrome-contextual-popover"
              id={contextualMenuId}
              ref={contextualPanel}
            >
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
                    onOpenMenuChange(undefined);
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
        </div>
      ) : null}

      {showServiceGroups && model.serviceGroups.length > 0 ? (
        <div className="zen-service-groups-navigation">
          <button
            aria-controls={serviceGroupsMenuId}
            aria-expanded={openMenu === "service-groups"}
            aria-label="Service Groups"
            className="chrome-button chrome-service-groups"
            data-tooltip="Service Groups"
            onClick={() =>
              onOpenMenuChange(openMenu === "service-groups" ? undefined : "service-groups")
            }
            ref={serviceGroupsLauncher}
            type="button"
          >
            <SemanticIcon aria-hidden="true" semanticKey="modules" size={19} strokeWidth={1.75} />
          </button>
          {openMenu === "service-groups" ? (
            <nav
              aria-label="Eligible service groups"
              className="chrome-popover chrome-service-groups-popover"
              id={serviceGroupsMenuId}
              ref={serviceGroupsPanel}
            >
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
                    onOpenMenuChange(undefined);
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
        </div>
      ) : null}
    </nav>
  );
}
