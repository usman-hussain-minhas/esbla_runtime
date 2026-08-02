"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  parseRouteBackedWidgetFallbackHref,
  ROUTE_BACKED_WIDGET_RETURN_FOCUS_KEY,
  serializeRouteBackedWidgetReturnFocus,
} from "../../../lib/route-backed-widget-navigation-core";
import { SemanticIcon } from "./semantic-icons";

interface RouteBackedWidgetOverlayProps {
  readonly browserBackMode?: "close-origin" | "return-master";
  readonly children: ReactNode;
  readonly fallbackHref: string;
  readonly label: string;
  readonly returnFocusId: string;
}

interface RouteBackedWidgetNavigation {
  readonly clearDirty: () => void;
  readonly close: () => void;
  readonly confirmNestedNavigation: () => boolean;
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");
const RouteBackedWidgetNavigationContext = createContext<RouteBackedWidgetNavigation | null>(null);

export function RouteBackedWidgetOverlay({
  browserBackMode = "close-origin",
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
  const confirmNestedNavigation = useCallback(() => {
    if (!dirty.current) return true;
    if (!window.confirm("Discard unsaved changes and leave this view?")) return false;
    dirty.current = false;
    return true;
  }, []);
  const clearDirty = useCallback(() => {
    dirty.current = false;
  }, []);
  const close = useCallback(() => {
    if (
      dirty.current &&
      !window.confirm("Discard unsaved changes and close this full-screen view?")
    ) {
      return;
    }
    if (browserBackMode === "close-origin") requestFreshOrigin(-2);
    else {
      exitRequested.current = true;
      navigateToFreshOrigin();
    }
  }, [browserBackMode, navigateToFreshOrigin, requestFreshOrigin]);

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
    const historyState =
      typeof window.history.state === "object" && window.history.state !== null
        ? (window.history.state as Record<string, unknown>)
        : undefined;
    const existingToken =
      typeof historyState?.__esblaRouteBackedWidgetGuard === "string"
        ? historyState.__esblaRouteBackedWidgetGuard
        : undefined;
    const token = guardToken.current ?? existingToken ?? window.crypto.randomUUID();
    guardToken.current = token;
    if (browserBackMode === "close-origin" && existingToken !== token) {
      window.history.pushState(
        {
          ...historyState,
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
    function markSubmitted(event: SubmitEvent) {
      if (
        event.target instanceof HTMLFormElement &&
        event.target.dataset.routeDirtySubmit === "retain"
      ) {
        return;
      }
      queueMicrotask(() => {
        if (!event.defaultPrevented) dirty.current = false;
      });
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
      if (browserBackMode === "close-origin" && state?.__esblaRouteBackedWidgetGuard === token) {
        return;
      }
      if (exitRequested.current) {
        navigateToFreshOrigin();
        return;
      }
      if (browserBackMode === "return-master") {
        if (!confirmNestedNavigation()) window.history.forward();
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
  }, [
    browserBackMode,
    close,
    confirmNestedNavigation,
    mounted,
    navigateToFreshOrigin,
    requestFreshOrigin,
    returnFocusId,
  ]);

  const navigation = useMemo(
    () => ({ clearDirty, close, confirmNestedNavigation }),
    [clearDirty, close, confirmNestedNavigation],
  );
  if (!mounted) return null;
  return createPortal(
    <RouteBackedWidgetNavigationContext.Provider value={navigation}>
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
    </RouteBackedWidgetNavigationContext.Provider>,
    document.body,
  );
}

export function RouteBackedWidgetGetForm({
  action,
  children,
  className,
}: {
  readonly action: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const router = useRouter();
  const navigation = useContext(RouteBackedWidgetNavigationContext);
  if (
    !action.startsWith("/") ||
    action.startsWith("//") ||
    action.includes("?") ||
    action.includes("#")
  ) {
    throw new Error("Route-backed widget form action is invalid");
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    const parameters = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget).entries()) {
      if (typeof value !== "string" || parameters.has(key)) {
        event.preventDefault();
        return;
      }
      parameters.set(key, value);
    }
    event.preventDefault();
    navigation?.clearDirty();
    const query = parameters.toString();
    router.push(query ? `${action}?${query}` : action);
  }
  return (
    <form action={action} className={className} method="get" onSubmit={submit}>
      {children}
    </form>
  );
}

export function RouteBackedWidgetPostForm({
  action,
  children,
  className,
}: {
  readonly action: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const router = useRouter();
  const navigation = useContext(RouteBackedWidgetNavigationContext);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  if (
    !action.startsWith("/") ||
    action.startsWith("//") ||
    action.includes("?") ||
    action.includes("#")
  ) {
    throw new Error("Route-backed widget form action is invalid");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const parameters = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget).entries()) {
      if (typeof value !== "string" || parameters.has(key)) {
        setError("The action could not be submitted. Reload this view and try again.");
        return;
      }
      parameters.set(key, value);
    }
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(action, {
        body: parameters,
        cache: "no-store",
        credentials: "same-origin",
        method: "POST",
        redirect: "follow",
      });
      const destination = new URL(response.url, window.location.origin);
      if (
        !response.ok ||
        !response.redirected ||
        destination.origin !== window.location.origin ||
        !destination.pathname.startsWith("/") ||
        destination.pathname.startsWith("//")
      ) {
        throw new Error("Unsafe route-backed form response");
      }
      navigation?.clearDirty();
      router.push(`${destination.pathname}${destination.search}${destination.hash}`);
    } catch {
      setError("The action could not be completed. Review current values and try again.");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form
      action={action}
      aria-busy={submitting}
      className={className}
      data-route-submitting={submitting ? "true" : "false"}
      method="post"
      onSubmit={submit}
    >
      {error ? <p role="alert">{error}</p> : null}
      {children}
    </form>
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
  const overlayNavigation = useContext(RouteBackedWidgetNavigationContext);
  const safeFallbackHref = parseRouteBackedWidgetFallbackHref(fallbackHref) ?? "/";
  return (
    <button
      aria-label={label}
      className="chrome-button zen-focus-close-button"
      data-tooltip="Close"
      onClick={() => {
        if (overlayNavigation) overlayNavigation.close();
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

export function RouteBackedWidgetNestedBackLink({
  children,
  className = "text-command",
  href,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly href: string;
}) {
  const navigation = useContext(RouteBackedWidgetNavigationContext);
  return (
    <Link
      className={className}
      href={href}
      onClick={(event) => {
        if (navigation && !navigation.confirmNestedNavigation()) event.preventDefault();
      }}
    >
      {children}
    </Link>
  );
}

export function RouteBackedWidgetFocusPane({
  children,
  kind,
}: {
  readonly children: ReactNode;
  readonly kind: "detail" | "master";
}) {
  return (
    <div className={`zen-focus-pane zen-focus-pane-${kind}`} data-focus-pane={kind}>
      {children}
    </div>
  );
}

export function RouteBackedWidgetFocusWorkspace({
  activePane,
  children,
  closeLabel,
  fallbackHref,
  layout,
  workspaceId,
}: {
  readonly activePane: "detail" | "master";
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly fallbackHref: string;
  readonly layout: "master-detail" | "single";
  readonly workspaceId: string;
}) {
  return (
    <div
      className="zen-focus-workspace"
      data-active-pane={activePane}
      data-focus-layout={layout}
      data-focus-workspace={workspaceId}
    >
      <div className="zen-widget-full-screen-close">
        <RouteBackedWidgetOverlayCloseButton fallbackHref={fallbackHref} label={closeLabel} />
      </div>
      {children}
    </div>
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
      <RouteBackedWidgetFocusWorkspace
        activePane="detail"
        closeLabel={closeLabel}
        fallbackHref={fallbackHref}
        layout="single"
        workspaceId="single"
      >
        <RouteBackedWidgetFocusPane kind="detail">{children}</RouteBackedWidgetFocusPane>
      </RouteBackedWidgetFocusWorkspace>
    </div>
  );
}
