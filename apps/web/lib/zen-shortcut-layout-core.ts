export interface ZenShortcutStackGeometry {
  readonly availableBlockSize: number;
  readonly buttonBlockSize: number;
  readonly controlGap: number;
  readonly endInset: number;
  readonly startInset: number;
  readonly topChromeBlockSize: number;
}

export function resolveZenShortcutVisibleItemCount(geometry: ZenShortcutStackGeometry): number {
  const values = Object.values(geometry);
  if (
    values.some((value) => !Number.isFinite(value)) ||
    geometry.availableBlockSize <= 0 ||
    geometry.buttonBlockSize <= 0 ||
    geometry.controlGap < 0 ||
    geometry.endInset < 0 ||
    geometry.startInset < 0 ||
    geometry.topChromeBlockSize < 0
  ) {
    return 0;
  }
  const available =
    geometry.availableBlockSize -
    geometry.startInset -
    geometry.endInset -
    geometry.topChromeBlockSize;
  const slots = Math.floor(
    (available - geometry.buttonBlockSize) / (geometry.buttonBlockSize + geometry.controlGap),
  );
  return Math.max(0, Math.min(5, slots));
}
