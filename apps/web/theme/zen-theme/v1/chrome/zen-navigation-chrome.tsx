"use client";

import type { PresentationNavigationDiscovery } from "@esbla/contracts";
import { usePathname } from "next/navigation";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { buildZenNavigationModel } from "../../../../lib/presentation-navigation-core";
import { SemanticIcon } from "../semantic-icons";

type OpenMenu = "contextual" | "service-groups" | undefined;
const ROUTE_HEADING_FOCUS_KEY = "esbla.zen-navigation.focus-heading";

function prepareRouteHeadingFocus(event: MouseEvent<HTMLAnchorElement>) {
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

export function ZenNavigationChrome({
  discovery,
}: Readonly<{ discovery: PresentationNavigationDiscovery }>) {
  const pathname = usePathname();
  const contextualMenuId = useId();
  const serviceGroupsMenuId = useId();
  const root = useRef<HTMLElement>(null);
  const contextualLauncher = useRef<HTMLButtonElement>(null);
  const contextualPanel = useRef<HTMLElement>(null);
  const serviceGroupsLauncher = useRef<HTMLButtonElement>(null);
  const serviceGroupsPanel = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);
  const [openMenu, setOpenMenu] = useState<OpenMenu>();
  const model = buildZenNavigationModel(discovery, pathname);

  useEffect(() => {
    if (previousPathname.current !== pathname) {
      previousPathname.current = pathname;
      setOpenMenu(undefined);
    }
  }, [pathname]);

  useEffect(() => {
    let targetPathname: string | null = null;
    try {
      targetPathname = window.sessionStorage.getItem(ROUTE_HEADING_FOCUS_KEY);
      if (targetPathname) window.sessionStorage.removeItem(ROUTE_HEADING_FOCUS_KEY);
    } catch {}
    if (targetPathname !== pathname) return;
    const frame = requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>("main h1");
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    if (!openMenu) return;
    const panel = openMenu === "contextual" ? contextualPanel.current : serviceGroupsPanel.current;
    const focusFrame = requestAnimationFrame(() =>
      panel?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus(),
    );
    const restoreFocus = () => {
      const launcher =
        openMenu === "contextual" ? contextualLauncher.current : serviceGroupsLauncher.current;
      setOpenMenu(undefined);
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
  }, [openMenu]);

  return (
    <nav aria-label="Primary navigation" className="zen-primary-navigation" ref={root}>
      <a
        aria-label="Mission Control"
        className="chrome-button chrome-home"
        href="/"
        onClick={prepareRouteHeadingFocus}
        title="Home"
      >
        <SemanticIcon aria-hidden="true" semanticKey="home" size={19} strokeWidth={1.75} />
      </a>

      {model.contextualMenu ? (
        <div className="zen-contextual-navigation">
          <button
            aria-controls={contextualMenuId}
            aria-expanded={openMenu === "contextual"}
            aria-label={model.contextualMenu.label}
            className="chrome-button chrome-contextual"
            onClick={() =>
              setOpenMenu((current) => (current === "contextual" ? undefined : "contextual"))
            }
            ref={contextualLauncher}
            title={model.contextualMenu.label}
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
                <a
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
                    setOpenMenu(undefined);
                  }}
                >
                  <SemanticIcon
                    aria-hidden="true"
                    semanticKey={destination.semanticIcon}
                    size={18}
                    strokeWidth={1.75}
                  />
                  <span>{destination.label}</span>
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}

      {model.serviceGroups.length > 0 ? (
        <div className="zen-service-groups-navigation">
          <button
            aria-controls={serviceGroupsMenuId}
            aria-expanded={openMenu === "service-groups"}
            aria-label="Service Groups"
            className="chrome-button chrome-service-groups"
            onClick={() =>
              setOpenMenu((current) =>
                current === "service-groups" ? undefined : "service-groups",
              )
            }
            ref={serviceGroupsLauncher}
            title="Service Groups"
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
                <a
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
                    setOpenMenu(undefined);
                  }}
                >
                  <SemanticIcon
                    aria-hidden="true"
                    semanticKey={group.semanticIcon}
                    size={18}
                    strokeWidth={1.75}
                  />
                  <span>{group.label}</span>
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
