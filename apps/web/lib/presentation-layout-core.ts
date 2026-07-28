import {
  getZenV1SurfaceContract,
  PRESENTATION_WIDGET_DEFINITIONS,
  type PresentationSurfaceLayout,
  type PresentationSurfaceLayoutSource,
  type PresentationWidgetBreakpointVariant,
  type PresentationWidgetDefinition,
  type PresentationWidgetPlacement,
  type ZenV1SurfaceId,
} from "@esbla/contracts";

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const breakpointColumns = {
  desktop: 12,
  phone: 4,
  tablet: 8,
} as const satisfies Readonly<Record<PresentationWidgetBreakpointVariant, number>>;

export type PresentationLayoutDiagnosticCode =
  | "collision_repositioned"
  | "column_position_clamped"
  | "column_span_clamped"
  | "row_span_clamped"
  | "unpositioned_placed"
  | "unsupported_breakpoint";

export interface PresentationLayoutDiagnostic {
  readonly code: PresentationLayoutDiagnosticCode;
  readonly instanceId: string;
}

export interface UnpositionedPresentationWidget {
  readonly instanceId: string;
  readonly widgetDefinitionId: string;
}

export type PresentationLayoutItem = PresentationWidgetPlacement | UnpositionedPresentationWidget;

export interface ResolvedPresentationBreakpointLayout {
  readonly breakpoint: PresentationWidgetBreakpointVariant;
  readonly columnCount: number;
  readonly diagnostics: readonly PresentationLayoutDiagnostic[];
  readonly placements: readonly PresentationWidgetPlacement[];
}

export interface ResolvedResponsivePresentationSurfaceLayout {
  readonly baseVersion: number;
  readonly layouts: readonly [
    ResolvedPresentationBreakpointLayout,
    ResolvedPresentationBreakpointLayout,
    ResolvedPresentationBreakpointLayout,
  ];
  readonly overlayVersion: number;
  readonly source: PresentationSurfaceLayoutSource;
  readonly surfaceId: ZenV1SurfaceId;
}

export interface ResponsivePresentationWidgetPlacement {
  readonly desktop: PresentationWidgetPlacement;
  readonly phone: PresentationWidgetPlacement;
  readonly tablet: PresentationWidgetPlacement;
}

export class PresentationLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresentationLayoutError";
  }
}

function safePositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isPositioned(item: PresentationLayoutItem): item is PresentationWidgetPlacement {
  const keys = ["column", "columnSpan", "row", "rowSpan"] as const;
  const present = keys.filter((key) => key in item);
  if (present.length === 0) return false;
  if (present.length !== keys.length) {
    throw new PresentationLayoutError("Incomplete presentation widget geometry");
  }
  return true;
}

function validateIdentity(item: PresentationLayoutItem): void {
  if (
    typeof item.instanceId !== "string" ||
    item.instanceId.length > 160 ||
    !identifierPattern.test(item.instanceId) ||
    typeof item.widgetDefinitionId !== "string" ||
    item.widgetDefinitionId.length > 160 ||
    !identifierPattern.test(item.widgetDefinitionId)
  ) {
    throw new PresentationLayoutError("Invalid presentation widget identity");
  }
}

function definitionFor(
  item: PresentationLayoutItem,
  definitions: readonly PresentationWidgetDefinition[],
): PresentationWidgetDefinition {
  const matches = definitions.filter(({ id }) => id === item.widgetDefinitionId);
  if (matches.length !== 1 || !matches[0]) {
    throw new PresentationLayoutError("Unknown or ambiguous presentation widget definition");
  }
  return matches[0];
}

function resolvePersistedPresentationBreakpointLayout(
  items: readonly PresentationWidgetPlacement[],
  breakpoint: PresentationWidgetBreakpointVariant,
  definitions: readonly PresentationWidgetDefinition[],
): ResolvedPresentationBreakpointLayout {
  if (items.length > 100) {
    throw new PresentationLayoutError("Presentation surface exceeds the widget limit");
  }
  const columnCount = breakpointColumns[breakpoint];
  const identities = new Set<string>();
  const placements: PresentationWidgetPlacement[] = [];
  for (const item of items) {
    validateIdentity(item);
    if (identities.has(item.instanceId)) {
      throw new PresentationLayoutError("Duplicate presentation widget instance");
    }
    identities.add(item.instanceId);
    const definition = definitionFor(item, definitions);
    const constraints = definition.layoutConstraints[breakpoint];
    if (
      !definition.supportedBreakpointVariants.includes(breakpoint) ||
      !safePositiveInteger(item.column, columnCount) ||
      !safePositiveInteger(item.columnSpan, columnCount) ||
      item.column + item.columnSpan - 1 > columnCount ||
      !safePositiveInteger(item.row, 1_000) ||
      !safePositiveInteger(item.rowSpan, 100) ||
      item.columnSpan < constraints.minimumColumnSpan ||
      item.columnSpan > constraints.maximumColumnSpan ||
      item.rowSpan < constraints.minimumRowSpan ||
      item.rowSpan > constraints.maximumRowSpan ||
      overlaps(item, placements)
    ) {
      throw new PresentationLayoutError("Invalid persisted presentation breakpoint base");
    }
    placements.push(Object.freeze({ ...item }));
  }
  return Object.freeze({
    breakpoint,
    columnCount,
    diagnostics: Object.freeze([]),
    placements: Object.freeze(placements),
  });
}

function overlaps(
  candidate: PresentationWidgetPlacement,
  occupied: readonly PresentationWidgetPlacement[],
): boolean {
  return occupied.some(
    (current) =>
      candidate.column < current.column + current.columnSpan &&
      current.column < candidate.column + candidate.columnSpan &&
      candidate.row < current.row + current.rowSpan &&
      current.row < candidate.row + candidate.rowSpan,
  );
}

function findFirstSlot(
  item: Omit<PresentationWidgetPlacement, "column" | "row">,
  columnCount: number,
  occupied: readonly PresentationWidgetPlacement[],
  startingRow: number,
): PresentationWidgetPlacement {
  for (let row = startingRow; row <= 1_000; row += 1) {
    for (let column = 1; column <= columnCount - item.columnSpan + 1; column += 1) {
      const candidate = { ...item, column, row };
      if (!overlaps(candidate, occupied)) return candidate;
    }
  }
  throw new PresentationLayoutError("Presentation surface has no bounded free placement");
}

function desiredGeometry(
  item: PresentationLayoutItem,
  definition: PresentationWidgetDefinition,
  breakpoint: PresentationWidgetBreakpointVariant,
  diagnostics: PresentationLayoutDiagnostic[],
): {
  readonly column: number | undefined;
  readonly columnSpan: number;
  readonly row: number | undefined;
  readonly rowSpan: number;
} {
  const constraints = definition.layoutConstraints[breakpoint];
  const columnCount = breakpointColumns[breakpoint];
  const positioned = isPositioned(item);
  if (
    positioned &&
    (!safePositiveInteger(item.column, 10_000) ||
      !safePositiveInteger(item.columnSpan, 10_000) ||
      !safePositiveInteger(item.row, 1_000) ||
      !safePositiveInteger(item.rowSpan, 100))
  ) {
    throw new PresentationLayoutError("Invalid presentation widget geometry");
  }

  if (breakpoint !== "desktop") {
    return {
      column: undefined,
      columnSpan:
        breakpoint === "phone" && definition.fullWidthEligible
          ? columnCount
          : constraints.preferredColumnSpan,
      row: undefined,
      rowSpan: constraints.preferredRowSpan,
    };
  }

  if (!positioned) {
    diagnostics.push({ code: "unpositioned_placed", instanceId: item.instanceId });
    return {
      column: undefined,
      columnSpan: constraints.preferredColumnSpan,
      row: undefined,
      rowSpan: constraints.preferredRowSpan,
    };
  }

  const columnSpan = clamp(
    item.columnSpan,
    constraints.minimumColumnSpan,
    Math.min(constraints.maximumColumnSpan, columnCount),
  );
  if (columnSpan !== item.columnSpan) {
    diagnostics.push({ code: "column_span_clamped", instanceId: item.instanceId });
  }
  const rowSpan = clamp(item.rowSpan, constraints.minimumRowSpan, constraints.maximumRowSpan);
  if (rowSpan !== item.rowSpan) {
    diagnostics.push({ code: "row_span_clamped", instanceId: item.instanceId });
  }
  const column = clamp(item.column, 1, columnCount - columnSpan + 1);
  if (column !== item.column) {
    diagnostics.push({ code: "column_position_clamped", instanceId: item.instanceId });
  }
  return { column, columnSpan, row: item.row, rowSpan };
}

export function resolvePresentationBreakpointLayout(
  items: readonly PresentationLayoutItem[],
  breakpoint: PresentationWidgetBreakpointVariant,
  definitions: readonly PresentationWidgetDefinition[] = PRESENTATION_WIDGET_DEFINITIONS,
): ResolvedPresentationBreakpointLayout {
  if (items.length > 100) {
    throw new PresentationLayoutError("Presentation surface exceeds the widget limit");
  }
  const identities = new Set<string>();
  for (const item of items) {
    validateIdentity(item);
    if (identities.has(item.instanceId)) {
      throw new PresentationLayoutError("Duplicate presentation widget instance");
    }
    identities.add(item.instanceId);
  }

  const columnCount = breakpointColumns[breakpoint];
  const diagnostics: PresentationLayoutDiagnostic[] = [];
  const placements: PresentationWidgetPlacement[] = [];
  for (const item of items) {
    const definition = definitionFor(item, definitions);
    if (!definition.supportedBreakpointVariants.includes(breakpoint)) {
      diagnostics.push({ code: "unsupported_breakpoint", instanceId: item.instanceId });
      continue;
    }
    const geometry = desiredGeometry(item, definition, breakpoint, diagnostics);
    const base = {
      columnSpan: geometry.columnSpan,
      instanceId: item.instanceId,
      rowSpan: geometry.rowSpan,
      widgetDefinitionId: item.widgetDefinitionId,
    };
    let placement: PresentationWidgetPlacement;
    if (geometry.column === undefined || geometry.row === undefined) {
      if (breakpoint === "desktop" && !isPositioned(item)) {
        // The diagnostic is recorded in desiredGeometry; placement remains stable by source order.
      } else if (!isPositioned(item)) {
        diagnostics.push({ code: "unpositioned_placed", instanceId: item.instanceId });
      }
      placement = findFirstSlot(base, columnCount, placements, 1);
    } else {
      const requested = {
        ...base,
        column: geometry.column,
        row: geometry.row,
      };
      if (overlaps(requested, placements)) {
        placement = findFirstSlot(base, columnCount, placements, geometry.row);
        diagnostics.push({ code: "collision_repositioned", instanceId: item.instanceId });
      } else {
        placement = requested;
      }
    }
    placements.push(Object.freeze(placement));
  }

  return Object.freeze({
    breakpoint,
    columnCount,
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
    placements: Object.freeze(placements),
  });
}

export function resolveResponsivePresentationSurfaceLayout(
  layout: PresentationSurfaceLayout,
  definitions: readonly PresentationWidgetDefinition[] = PRESENTATION_WIDGET_DEFINITIONS,
): ResolvedResponsivePresentationSurfaceLayout {
  const contract = getZenV1SurfaceContract(layout.surfaceId);
  if (contract.baseVersion !== layout.baseVersion && layout.source === "code_default") {
    throw new PresentationLayoutError("Presentation surface base version drift");
  }
  const effectiveInstanceIds = new Set(
    layout.effectivePlacements.map(({ instanceId }) => instanceId),
  );
  const persistedBase = (
    breakpoint: PresentationWidgetBreakpointVariant,
  ): readonly PresentationWidgetPlacement[] =>
    contract.basePlacementsByBreakpoint[breakpoint].filter(({ instanceId }) =>
      effectiveInstanceIds.has(instanceId),
    );
  const layouts = [
    resolvePresentationBreakpointLayout(layout.effectivePlacements, "desktop", definitions),
    resolvePersistedPresentationBreakpointLayout(persistedBase("tablet"), "tablet", definitions),
    resolvePersistedPresentationBreakpointLayout(persistedBase("phone"), "phone", definitions),
  ] as const;
  return Object.freeze({
    baseVersion: layout.baseVersion,
    layouts,
    overlayVersion: layout.overlayVersion,
    source: layout.source,
    surfaceId: layout.surfaceId,
  });
}

export function getResponsivePresentationWidgetPlacement(
  layout: ResolvedResponsivePresentationSurfaceLayout,
  instanceId: string,
): ResponsivePresentationWidgetPlacement | undefined {
  const [desktopLayout, tabletLayout, phoneLayout] = layout.layouts;
  const desktop = desktopLayout.placements.find((placement) => placement.instanceId === instanceId);
  if (!desktop) return undefined;
  const tablet = tabletLayout.placements.find(
    ({ instanceId }) => instanceId === desktop.instanceId,
  );
  const phone = phoneLayout.placements.find(({ instanceId }) => instanceId === desktop.instanceId);
  if (!tablet || !phone) return undefined;
  return Object.freeze({ desktop, phone, tablet });
}
