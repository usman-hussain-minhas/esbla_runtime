"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from "react";
import {
  groupZenSurfaceScrollRows,
  resolveActiveZenSurfaceScrollAnchor,
  resolveZenSurfaceScrollInputValue,
  shouldShowZenSurfaceScrollRail,
} from "../../../../lib/zen-surface-scroll-rail-core";

interface ScrollAnchor {
  readonly id: string;
  readonly label: string;
}

interface RenderedScrollAnchor extends ScrollAnchor {
  readonly bottom: number;
  readonly elements: readonly HTMLElement[];
  readonly top: number;
}

interface ScrollRailState {
  readonly activeIndex: number;
  readonly anchors: readonly ScrollAnchor[];
  readonly visible: boolean;
}

const hiddenState: ScrollRailState = { activeIndex: 0, anchors: [], visible: false };

function sameAnchors(left: readonly ScrollAnchor[], right: readonly ScrollAnchor[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (anchor, index) => anchor.id === right[index]?.id && anchor.label === right[index]?.label,
    )
  );
}

function tickDistance(index: number, focalIndex: number): "current" | "far" | "mid" | "near" {
  const distance = Math.abs(index - focalIndex);
  if (distance === 0) return "current";
  if (distance === 1) return "near";
  return distance === 2 ? "mid" : "far";
}

function widgetLabel(element: HTMLElement): string {
  const headingId = element.getAttribute("aria-labelledby");
  const heading = headingId ? document.getElementById(headingId) : undefined;
  return heading?.textContent?.trim() || element.dataset.surfaceInstance || "Surface widget";
}

function renderedScrollAnchors(scrollOwner: HTMLElement): readonly RenderedScrollAnchor[] {
  const explicit = [...scrollOwner.querySelectorAll<HTMLElement>("[data-zen-scroll-anchor]")]
    .filter((element) => element.getClientRects().length > 0)
    .map((element, sourceIndex) => ({
      bounds: element.getBoundingClientRect(),
      element,
      sourceIndex,
    }))
    .sort(
      (left, right) =>
        left.bounds.top - right.bounds.top ||
        left.bounds.left - right.bounds.left ||
        left.sourceIndex - right.sourceIndex,
    );
  if (explicit.length > 0) {
    return explicit.map(({ bounds, element, sourceIndex }) => ({
      bottom: bounds.bottom,
      elements: [element],
      id: element.dataset.zenScrollAnchor || `section-${sourceIndex + 1}`,
      label:
        element.dataset.zenScrollLabel ||
        element.getAttribute("aria-label") ||
        `Section ${sourceIndex + 1}`,
      top: bounds.top,
    }));
  }

  const widgets = [...scrollOwner.querySelectorAll<HTMLElement>("[data-surface-instance]")]
    .filter(
      (element) => element.getClientRects().length > 0 && Boolean(element.dataset.surfaceInstance),
    )
    .map((element, sourceIndex) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        element,
        id: element.dataset.surfaceInstance ?? "",
        label: widgetLabel(element),
        left: bounds.left,
        sourceIndex,
        top: bounds.top,
      };
    });
  const elementsById = new Map(widgets.map(({ element, id }) => [id, element]));
  return groupZenSurfaceScrollRows(widgets).map((row) => ({
    ...row,
    elements: row.memberIds.flatMap((id) => {
      const element = elementsById.get(id);
      return element ? [element] : [];
    }),
  }));
}

export function ZenSurfaceScrollRail({ scrollOwnerId }: Readonly<{ scrollOwnerId: string }>) {
  const [focused, setFocused] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number>();
  const [state, setState] = useState(hiddenState);
  const [scrollOwner, setScrollOwner] = useState<HTMLElement>();

  useEffect(() => {
    const currentOwner = document.getElementById(scrollOwnerId);
    if (currentOwner) {
      setScrollOwner(currentOwner);
      return;
    }
    const ownerObserver = new MutationObserver(() => {
      const nextOwner = document.getElementById(scrollOwnerId);
      if (!nextOwner) return;
      setScrollOwner(nextOwner);
      ownerObserver.disconnect();
    });
    ownerObserver.observe(document.documentElement, { childList: true, subtree: true });
    return () => ownerObserver.disconnect();
  }, [scrollOwnerId]);

  useEffect(() => {
    if (!scrollOwner) return;
    let animationFrame: number | undefined;
    const observedElements = new Set<Element>();
    let resizeObserver: ResizeObserver;

    const synchronizeResizeObservers = (anchors: readonly RenderedScrollAnchor[]) => {
      const nextElements = new Set<Element>([
        scrollOwner,
        ...(scrollOwner.firstElementChild ? [scrollOwner.firstElementChild] : []),
        ...anchors.flatMap(({ elements }) => elements),
      ]);
      for (const element of observedElements) {
        if (!nextElements.has(element)) {
          resizeObserver.unobserve(element);
          observedElements.delete(element);
        }
      }
      for (const element of nextElements) {
        if (!observedElements.has(element)) {
          resizeObserver.observe(element);
          observedElements.add(element);
        }
      }
    };

    const update = () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const anchors = renderedScrollAnchors(scrollOwner);
        synchronizeResizeObservers(anchors);
        const semanticSectionRail = scrollOwner.querySelector(".zen-section-rail");
        const visible =
          !semanticSectionRail &&
          shouldShowZenSurfaceScrollRail(
            scrollOwner.clientHeight,
            scrollOwner.scrollHeight,
            anchors.length,
          );
        if (!visible) {
          scrollOwner.removeAttribute("data-zen-scroll-rail");
          setState(hiddenState);
          return;
        }
        scrollOwner.dataset.zenScrollRail = "active";
        const viewport = scrollOwner.getBoundingClientRect();
        const activeIndex = resolveActiveZenSurfaceScrollAnchor(
          { bottom: viewport.bottom, top: viewport.top },
          anchors,
        );
        const stateAnchors = anchors.map(({ id, label }) => ({ id, label }));
        setState((current) =>
          current.visible &&
          current.activeIndex === activeIndex &&
          sameAnchors(current.anchors, stateAnchors)
            ? current
            : { activeIndex, anchors: stateAnchors, visible: true },
        );
      });
    };

    resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(scrollOwner, {
      attributeFilter: [
        "aria-label",
        "aria-labelledby",
        "class",
        "data-surface-instance",
        "data-zen-scroll-anchor",
        "data-zen-scroll-label",
        "style",
      ],
      attributes: true,
      childList: true,
      subtree: true,
    });
    scrollOwner.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();

    return () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      scrollOwner.removeAttribute("data-zen-scroll-rail");
      scrollOwner.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [scrollOwner]);

  if (!state.visible) return null;

  const activateAnchor = (index: number) => {
    const currentScrollOwner = document.getElementById(scrollOwnerId);
    const selectedAnchor = state.anchors[index];
    if (!currentScrollOwner || !selectedAnchor) return;
    const target = renderedScrollAnchors(currentScrollOwner).find(
      (anchor) => anchor.id === selectedAnchor.id,
    );
    if (!target) return;
    setState((current) => ({ ...current, activeIndex: index }));
    const reducedMotion =
      document.documentElement.dataset.reducedMotion === "reduce" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ownerBounds = currentScrollOwner.getBoundingClientRect();
    const ownerStyle = getComputedStyle(currentScrollOwner);
    const scrollPaddingStart = Number.parseFloat(ownerStyle.scrollPaddingBlockStart) || 0;
    const scrollPaddingEnd = Number.parseFloat(ownerStyle.scrollPaddingBlockEnd) || 0;
    const availableHeight = Math.max(
      0,
      currentScrollOwner.clientHeight - scrollPaddingStart - scrollPaddingEnd,
    );
    const anchorHeight = target.bottom - target.top;
    const anchorTop =
      currentScrollOwner.scrollTop + target.top - ownerBounds.top - scrollPaddingStart;
    const requestedScrollTop =
      anchorHeight <= availableHeight
        ? anchorTop - (availableHeight - anchorHeight) / 2
        : anchorTop;
    currentScrollOwner.scrollTo({
      behavior: reducedMotion ? "auto" : "smooth",
      top: Math.max(
        0,
        Math.min(
          currentScrollOwner.scrollHeight - currentScrollOwner.clientHeight,
          requestedScrollTop,
        ),
      ),
    });
  };

  const pointerIndex = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    return Math.round(progress * (state.anchors.length - 1));
  };

  const updateHoveredIndex = (event: ReactPointerEvent<HTMLDivElement>) => {
    setHoveredIndex(pointerIndex(event));
  };

  const handleNativeInput = (event: ChangeEvent<HTMLInputElement>) => {
    activateAnchor(
      resolveZenSurfaceScrollInputValue(event.currentTarget.valueAsNumber, state.anchors.length),
    );
  };

  const activeAnchor = state.anchors[state.activeIndex];
  const focalIndex = hoveredIndex ?? state.activeIndex;
  return (
    <div
      className="zen-surface-scroll-rail"
      data-focused={focused ? "true" : undefined}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        activateAnchor(pointerIndex(event));
      }}
      onPointerLeave={() => setHoveredIndex(undefined)}
      onPointerMove={(event) => {
        updateHoveredIndex(event);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          activateAnchor(pointerIndex(event));
        }
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      style={
        {
          "--zen-scroll-rail-natural-height": `${state.anchors.length * 9 - 7}px`,
          "--zen-scroll-tick-count": state.anchors.length,
        } as CSSProperties
      }
    >
      <div aria-hidden="true" className="zen-surface-scroll-ticks">
        {state.anchors.map((anchor, index) => (
          <span
            data-active={index === state.activeIndex ? "true" : undefined}
            data-distance={tickDistance(index, focalIndex)}
            data-scroll-anchor={anchor.id}
            key={anchor.id}
          />
        ))}
      </div>
      <input
        aria-controls={scrollOwnerId}
        aria-label="Surface scroll position"
        aria-orientation="vertical"
        aria-valuetext={activeAnchor?.label ?? "Surface widget"}
        className="zen-surface-scroll-input"
        max={state.anchors.length - 1}
        min="0"
        onBlur={() => setFocused(false)}
        onChange={handleNativeInput}
        onFocus={() => setFocused(true)}
        step="1"
        type="range"
        value={state.activeIndex}
      />
    </div>
  );
}
