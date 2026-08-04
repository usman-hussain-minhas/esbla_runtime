export interface ZenSurfaceScrollAnchorGeometry {
  readonly bottom: number;
  readonly top: number;
}

export interface ZenSurfaceScrollRowCandidate extends ZenSurfaceScrollAnchorGeometry {
  readonly id: string;
  readonly label: string;
  readonly left: number;
  readonly sourceIndex: number;
}

export interface ZenSurfaceScrollRow extends ZenSurfaceScrollAnchorGeometry {
  readonly id: string;
  readonly label: string;
  readonly memberIds: readonly string[];
}

export interface ZenSurfaceScrollViewportGeometry {
  readonly bottom: number;
  readonly top: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

export function groupZenSurfaceScrollRows(
  candidates: readonly ZenSurfaceScrollRowCandidate[],
  topTolerance = 2,
): readonly ZenSurfaceScrollRow[] {
  if (
    !finite(topTolerance) ||
    topTolerance < 0 ||
    candidates.some(
      ({ bottom, id, label, left, sourceIndex, top }) =>
        !id ||
        !label ||
        !finite(top) ||
        !finite(bottom) ||
        bottom <= top ||
        !finite(left) ||
        !Number.isSafeInteger(sourceIndex) ||
        sourceIndex < 0,
    )
  ) {
    throw new Error("Invalid Zen surface row candidates");
  }

  const sorted = [...candidates].sort(
    (left, right) =>
      left.top - right.top || left.left - right.left || left.sourceIndex - right.sourceIndex,
  );
  const rows: ZenSurfaceScrollRowCandidate[][] = [];

  for (const candidate of sorted) {
    const current = rows.at(-1);
    if (!current || Math.abs(candidate.top - (current[0]?.top ?? candidate.top)) > topTolerance) {
      rows.push([candidate]);
      continue;
    }
    current.push(candidate);
  }

  return rows.map((row, index) => {
    const members = [...row].sort(
      (left, right) => left.left - right.left || left.sourceIndex - right.sourceIndex,
    );
    const memberIds = members.map(({ id }) => id);
    return {
      bottom: Math.max(...members.map(({ bottom }) => bottom)),
      id: `row-${index + 1}:${memberIds.join("+")}`,
      label: `Row ${index + 1}: ${members.map(({ label }) => label).join(", ")}`,
      memberIds,
      top: Math.min(...members.map(({ top }) => top)),
    };
  });
}

export function resolveActiveZenSurfaceScrollAnchor(
  viewport: ZenSurfaceScrollViewportGeometry,
  anchors: readonly ZenSurfaceScrollAnchorGeometry[],
): number {
  if (
    !finite(viewport.top) ||
    !finite(viewport.bottom) ||
    viewport.bottom <= viewport.top ||
    anchors.some(({ bottom, top }) => !finite(top) || !finite(bottom) || bottom <= top)
  ) {
    throw new Error("Invalid Zen surface scroll geometry");
  }
  const viewportCenter = viewport.top + (viewport.bottom - viewport.top) / 2;
  let selectedIndex = 0;
  let selectedDistance = Number.POSITIVE_INFINITY;
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let foundVisibleAnchor = false;

  anchors.forEach((anchor, index) => {
    const center = anchor.top + (anchor.bottom - anchor.top) / 2;
    const distance = Math.abs(center - viewportCenter);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
    const visibleHeight =
      Math.min(anchor.bottom, viewport.bottom) - Math.max(anchor.top, viewport.top);
    if (visibleHeight <= 0) return;
    if (distance < selectedDistance) {
      foundVisibleAnchor = true;
      selectedDistance = distance;
      selectedIndex = index;
    }
  });

  return foundVisibleAnchor ? selectedIndex : nearestIndex;
}

export function shouldShowZenSurfaceScrollRail(
  clientHeight: number,
  scrollHeight: number,
  anchorCount: number,
): boolean {
  if (
    !finite(clientHeight) ||
    !finite(scrollHeight) ||
    clientHeight < 0 ||
    scrollHeight < 0 ||
    !Number.isSafeInteger(anchorCount) ||
    anchorCount < 0
  ) {
    throw new Error("Invalid Zen surface scroll metrics");
  }
  return clientHeight > 0 && scrollHeight - clientHeight > 1 && anchorCount > 1;
}

export function resolveZenSurfaceScrollInputValue(value: number, anchorCount: number): number {
  if (!finite(value) || !Number.isSafeInteger(anchorCount) || anchorCount < 1) {
    throw new Error("Invalid Zen surface scroll input");
  }
  return Math.max(0, Math.min(anchorCount - 1, Math.round(value)));
}
