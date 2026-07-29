"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  parseRouteBackedWidgetFallbackHref,
  ROUTE_BACKED_WIDGET_RETURN_FOCUS_KEY,
  serializeRouteBackedWidgetReturnFocus,
} from "../../../lib/route-backed-widget-navigation-core";
import { SemanticIcon } from "./semantic-icons";

interface RouteBackedWidgetOverlayProps {
  readonly children: ReactNode;
  readonly fallbackHref: string;
  readonly label: string;
  readonly returnFocusId: string;
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");
const RouteBackedWidgetCloseContext = createContext<(() => void) | null>(null);

export function RouteBackedWidgetOverlay({
  children,
  fallbackHref,
  label,
  returnFocusId,
}: RouteBackedWidgetOverlayProps) {
  const safeFallbackHref = parseRouteBackedWidgetFallbackHref(fallbackHref) ?? "/";
  const dialog = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const exitRequested = useRef(false);
  const fallbackTimer = useRef<number | undefined>(undefined);
  const guardToken = useRef<string | undefined>(undefined);
  const originScroll = useRef({ left: 0, top: 0 });
  const [mounted, setMounted] = useState(false);
  const navigateToFreshOrigin = useCallback(() => {
    if (fallbackTimer.current !== undefined) window.clearTimeout(fallbackTimer.current);
    try {
      window.sessionStorage.setItem(
        ROUTE_BACKED_WIDGET_RETURN_FOCUS_KEY,
        serializeRouteBackedWidgetReturnFocus({
          fallbackHref: safeFallbackHref,
          returnFocusId,
          scrollLeft: originScroll.current.left,
          scrollTop: originScroll.current.top,
        }),
      );
    } catch {}
    window.location.assign(safeFallbackHref);
  }, [returnFocusId, safeFallbackHref]);
  const requestFreshOrigin = useCallback(
    (historyDelta: number) => {
      exitRequested.current = true;
      window.history.go(historyDelta);
      fallbackTimer.current = window.setTimeout(navigateToFreshOrigin, 250);
    },
    [navigateToFreshOrigin],
  );
  const close = useCallback(() => {
    if (
      dirty.current &&
      !window.confirm("Discard unsaved changes and close this full-screen view?")
    ) {
      return;
    }
    requestFreshOrigin(-2);
  }, [requestFreshOrigin]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const face = dialog.current;
    if (!face) return;
    const activeFace: HTMLDivElement = face;
    const originFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originScrollOwner = document.querySelector<HTMLElement>(".surface-scroll");
    const currentOriginScroll = {
      left: Math.max(0, Math.round(originScrollOwner?.scrollLeft ?? 0)),
      top: Math.max(0, Math.round(originScrollOwner?.scrollTop ?? 0)),
    };
    originScroll.current = currentOriginScroll;
    const priorDocumentOverflow = document.documentElement.style.overflow;
    const priorBodyOverflow = document.body.style.overflow;
    const concealed = [...document.body.children]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== activeFace,
      )
      .map((element) => ({
        ariaHidden: element.getAttribute("aria-hidden"),
        element,
        inert: element.inert,
      }));
    for (const entry of concealed) {
      entry.element.inert = true;
      entry.element.setAttribute("aria-hidden", "true");
    }
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    activeFace.focus();
    const token = guardToken.current ?? window.crypto.randomUUID();
    guardToken.current = token;
    if (
      !window.history.state ||
      (window.history.state as Record<string, unknown>).__esblaRouteBackedWidgetGuard !== token
    ) {
      window.history.pushState(
        {
          ...(window.history.state as Record<string, unknown> | null),
          __esblaRouteBackedWidgetGuard: token,
        },
        "",
        window.location.href,
      );
    }

    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...activeFace.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        activeFace.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (
        (event.shiftKey &&
          (document.activeElement === first || document.activeElement === activeFace)) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
    function markDirty(event: Event) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        dirty.current = true;
      }
    }
    function markSubmitted() {
      dirty.current = false;
    }
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirty.current || exitRequested.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function handleHistoryTraversal(event: PopStateEvent) {
      const state =
        typeof event.state === "object" && event.state !== null
          ? (event.state as Record<string, unknown>)
          : undefined;
      if (state?.__esblaRouteBackedWidgetGuard === token) return;
      if (exitRequested.current) {
        navigateToFreshOrigin();
        return;
      }
      if (
        dirty.current &&
        !window.confirm("Discard unsaved changes and close this full-screen view?")
      ) {
        window.history.forward();
        return;
      }
      requestFreshOrigin(-1);
    }
    document.addEventListener("keydown", handleKeys);
    activeFace.addEventListener("change", markDirty);
    activeFace.addEventListener("input", markDirty);
    activeFace.addEventListener("submit", markSubmitted);
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handleHistoryTraversal);
    return () => {
      document.removeEventListener("keydown", handleKeys);
      activeFace.removeEventListener("change", markDirty);
      activeFace.removeEventListener("input", markDirty);
      activeFace.removeEventListener("submit", markSubmitted);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handleHistoryTraversal);
      if (fallbackTimer.current !== undefined && !exitRequested.current) {
        window.clearTimeout(fallbackTimer.current);
      }
      document.documentElement.style.overflow = priorDocumentOverflow;
      document.body.style.overflow = priorBodyOverflow;
      for (const entry of concealed) {
        entry.element.inert = entry.inert;
        if (entry.ariaHidden === null) entry.element.removeAttribute("aria-hidden");
        else entry.element.setAttribute("aria-hidden", entry.ariaHidden);
      }
      originScrollOwner?.scrollTo(currentOriginScroll);
      if (!exitRequested.current) {
        requestAnimationFrame(() => {
          const returnTarget = document.getElementById(returnFocusId) ?? originFocus;
          if (returnTarget?.isConnected && !returnTarget.closest("[inert]")) returnTarget.focus();
        });
      }
    };
  }, [close, mounted, navigateToFreshOrigin, requestFreshOrigin, returnFocusId]);

  if (!mounted) return null;
  return createPortal(
    <RouteBackedWidgetCloseContext.Provider value={close}>
      <div
        aria-label={label}
        aria-modal="true"
        className="zen-widget-overlay"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </div>
    </RouteBackedWidgetCloseContext.Provider>,
    document.body,
  );
}

export function RouteBackedWidgetOverlayCloseButton({
  fallbackHref,
  label,
}: {
  readonly fallbackHref: string;
  readonly label: string;
}) {
  const router = useRouter();
  const overlayClose = useContext(RouteBackedWidgetCloseContext);
  const safeFallbackHref = parseRouteBackedWidgetFallbackHref(fallbackHref) ?? "/";
  return (
    <button
      aria-label={label}
      className="icon-command"
      onClick={() => {
        if (overlayClose) overlayClose();
        else if (window.history.length > 1) router.back();
        else router.replace(safeFallbackHref);
      }}
      title="Close full screen"
      type="button"
    >
      <SemanticIcon aria-hidden="true" semanticKey="x" size={17} />
    </button>
  );
}

export function RouteBackedWidgetFullScreenFace({
  children,
  closeLabel,
  fallbackHref,
}: {
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly fallbackHref: string;
}) {
  return (
    <div className="zen-widget-full-screen-face">
      <div className="zen-widget-full-screen-close">
        <RouteBackedWidgetOverlayCloseButton fallbackHref={fallbackHref} label={closeLabel} />
      </div>
      {children}
    </div>
  );
}
