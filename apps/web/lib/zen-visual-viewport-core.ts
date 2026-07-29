export interface ZenVisualViewportInput {
  readonly layoutBlockSize: number;
  readonly layoutInlineSize: number;
  readonly viewportBlockSize?: number;
  readonly viewportBlockStart?: number;
  readonly viewportInlineSize?: number;
  readonly viewportInlineStart?: number;
}

export interface ZenVisualViewportResult {
  readonly blockEnd: number;
  readonly blockSize: number;
  readonly blockStart: number;
  readonly inlineEnd: number;
  readonly inlineSize: number;
  readonly inlineStart: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clampViewportAxis(
  layoutSize: number,
  viewportSize: number,
  viewportStart: number,
): Readonly<{ end: number; size: number; start: number }> {
  const size = Math.min(Math.max(viewportSize, 0), layoutSize);
  const start = Math.min(Math.max(viewportStart, 0), layoutSize - size);
  return {
    end: Math.max(0, layoutSize - start - size),
    size,
    start,
  };
}

export function resolveZenVisualViewport(input: ZenVisualViewportInput): ZenVisualViewportResult {
  if (!isPositiveFinite(input.layoutBlockSize) || !isPositiveFinite(input.layoutInlineSize)) {
    throw new Error("Zen visual viewport requires a positive finite layout");
  }

  const optionalGeometry = [
    input.viewportBlockSize,
    input.viewportBlockStart,
    input.viewportInlineSize,
    input.viewportInlineStart,
  ];
  if (
    optionalGeometry.some((value) => value === undefined || !Number.isFinite(value)) ||
    !isPositiveFinite(input.viewportBlockSize ?? 0) ||
    !isPositiveFinite(input.viewportInlineSize ?? 0)
  ) {
    return {
      blockEnd: 0,
      blockSize: input.layoutBlockSize,
      blockStart: 0,
      inlineEnd: 0,
      inlineSize: input.layoutInlineSize,
      inlineStart: 0,
    };
  }

  const block = clampViewportAxis(
    input.layoutBlockSize,
    input.viewportBlockSize as number,
    input.viewportBlockStart as number,
  );
  const inline = clampViewportAxis(
    input.layoutInlineSize,
    input.viewportInlineSize as number,
    input.viewportInlineStart as number,
  );
  return {
    blockEnd: block.end,
    blockSize: block.size,
    blockStart: block.start,
    inlineEnd: inline.end,
    inlineSize: inline.size,
    inlineStart: inline.start,
  };
}
