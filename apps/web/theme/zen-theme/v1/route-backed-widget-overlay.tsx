"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

export function RouteBackedWidgetOverlay({
  children,
  fallbackHref,
  label,
  returnFocusId,
}: RouteBackedWidgetOverlayProps) {
  const router = useRouter();
  const dialog = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

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
    const originScroll = { left: window.scrollX, top: window.scrollY };
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

    function close() {
      if (window.history.length > 1) router.back();
      else router.replace(fallbackHref);
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
    document.addEventListener("keydown", handleKeys);
    return () => {
      document.removeEventListener("keydown", handleKeys);
      document.documentElement.style.overflow = priorDocumentOverflow;
      document.body.style.overflow = priorBodyOverflow;
      for (const entry of concealed) {
        entry.element.inert = entry.inert;
        if (entry.ariaHidden === null) entry.element.removeAttribute("aria-hidden");
        else entry.element.setAttribute("aria-hidden", entry.ariaHidden);
      }
      window.scrollTo(originScroll);
      requestAnimationFrame(() => {
        const returnTarget = document.getElementById(returnFocusId) ?? originFocus;
        if (returnTarget?.isConnected && !returnTarget.closest("[inert]")) returnTarget.focus();
      });
    };
  }, [fallbackHref, mounted, returnFocusId, router]);

  if (!mounted) return null;
  const close = () => {
    if (window.history.length > 1) router.back();
    else router.replace(fallbackHref);
  };
  return createPortal(
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
    </div>,
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
  return (
    <button
      aria-label={label}
      className="icon-command"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.replace(fallbackHref);
      }}
      title="Close full screen"
      type="button"
    >
      <SemanticIcon aria-hidden="true" semanticKey="x" size={17} />
    </button>
  );
}
