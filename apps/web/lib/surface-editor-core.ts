import {
  getPresentationWidgetDefinition,
  getZenV1SurfaceContract,
  type PresentationWidgetPlacement,
  type ZenV1SurfaceId,
} from "@esbla/contracts";

export interface PersonalSurfaceEditorState {
  readonly announcement: string | null;
  readonly availablePlacements: readonly PresentationWidgetPlacement[];
  readonly dirty: boolean;
  readonly issue: string | null;
  readonly overlayVersion: number;
  readonly placements: readonly PresentationWidgetPlacement[];
  readonly savedPlacements: readonly PresentationWidgetPlacement[];
  readonly selectedInstanceId: string | null;
  readonly surfaceId: ZenV1SurfaceId;
}

export type PersonalSurfaceEditorAction =
  | Readonly<{ instanceId: string; type: "add" }>
  | Readonly<{
      columnDelta: number;
      instanceId: string;
      rowDelta: number;
      type: "move";
    }>
  | Readonly<{
      columnSpanDelta: number;
      instanceId: string;
      rowSpanDelta: number;
      type: "resize";
    }>
  | Readonly<{ instanceId: string; type: "select" }>
  | Readonly<{ type: "remove_selected" }>
  | Readonly<{
      availablePlacements: readonly PresentationWidgetPlacement[];
      overlayVersion: number;
      placements: readonly PresentationWidgetPlacement[];
      type: "replace_saved";
    }>;

interface CreatePersonalSurfaceEditorStateInput {
  readonly availablePlacements: readonly PresentationWidgetPlacement[];
  readonly effectivePlacements: readonly PresentationWidgetPlacement[];
  readonly overlayVersion: number;
  readonly surfaceId: ZenV1SurfaceId;
}

function overlaps(
  candidate: PresentationWidgetPlacement,
  placements: readonly PresentationWidgetPlacement[],
): boolean {
  return placements.some(
    (current) =>
      candidate.instanceId !== current.instanceId &&
      candidate.column < current.column + current.columnSpan &&
      current.column < candidate.column + candidate.columnSpan &&
      candidate.row < current.row + current.rowSpan &&
      current.row < candidate.row + candidate.rowSpan,
  );
}

function samePlacements(
  left: readonly PresentationWidgetPlacement[],
  right: readonly PresentationWidgetPlacement[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function firstFreePlacement(
  registered: PresentationWidgetPlacement,
  placements: readonly PresentationWidgetPlacement[],
): PresentationWidgetPlacement | undefined {
  for (let row = 1; row <= 1_000; row += 1) {
    for (let column = 1; column <= 12 - registered.columnSpan + 1; column += 1) {
      const candidate = { ...registered, column, row };
      if (!overlaps(candidate, placements)) return candidate;
    }
  }
  return undefined;
}

export function isPersonalSurfaceWidgetRemovable(
  surfaceId: ZenV1SurfaceId,
  instanceId: string,
): boolean {
  const contract = getZenV1SurfaceContract(surfaceId);
  return (
    contract.defaultInstances.some(
      (instance) =>
        instance.instanceId === instanceId && instance.placementPolicy === "default_optional",
    ) || contract.catalogueInstances.some((instance) => instance.instanceId === instanceId)
  );
}

function updatedState(
  state: PersonalSurfaceEditorState,
  placements: readonly PresentationWidgetPlacement[],
  selectedInstanceId: string | null,
  announcement: string,
): PersonalSurfaceEditorState {
  return {
    ...state,
    announcement,
    dirty: !samePlacements(placements, state.savedPlacements),
    issue: null,
    placements,
    selectedInstanceId,
  };
}

export function createPersonalSurfaceEditorState({
  availablePlacements,
  effectivePlacements,
  overlayVersion,
  surfaceId,
}: CreatePersonalSurfaceEditorStateInput): PersonalSurfaceEditorState {
  const available = availablePlacements.map((placement) => Object.freeze({ ...placement }));
  const placements = effectivePlacements.map((placement) => Object.freeze({ ...placement }));
  return {
    announcement: null,
    availablePlacements: Object.freeze(available),
    dirty: false,
    issue: null,
    overlayVersion,
    placements: Object.freeze(placements),
    savedPlacements: Object.freeze(placements),
    selectedInstanceId: placements[0]?.instanceId ?? null,
    surfaceId,
  };
}

function transformInstance(
  state: PersonalSurfaceEditorState,
  instanceId: string,
  transform: (placement: PresentationWidgetPlacement) => PresentationWidgetPlacement,
  announcement: (placement: PresentationWidgetPlacement, displayName: string) => string,
): PersonalSurfaceEditorState {
  const selected = state.placements.find((placement) => placement.instanceId === instanceId);
  if (!selected) return { ...state, issue: "That widget is not on this surface." };
  const candidate = transform(selected);
  const definition = getPresentationWidgetDefinition(
    candidate.widgetDefinitionId,
    candidate.widgetDefinitionVersion,
  );
  const bounds = definition.layoutConstraints.desktop;
  if (
    candidate.column < 1 ||
    candidate.columnSpan < bounds.minimumColumnSpan ||
    candidate.columnSpan > bounds.maximumColumnSpan ||
    candidate.column + candidate.columnSpan - 1 > 12 ||
    candidate.row < 1 ||
    candidate.row > 1_000 ||
    candidate.rowSpan < bounds.minimumRowSpan ||
    candidate.rowSpan > bounds.maximumRowSpan
  ) {
    return { ...state, issue: "That size or position is outside this widget’s limits." };
  }
  if (overlaps(candidate, state.placements)) {
    return { ...state, issue: "That position is occupied." };
  }
  return updatedState(
    state,
    state.placements.map((placement) =>
      placement.instanceId === candidate.instanceId ? Object.freeze(candidate) : placement,
    ),
    candidate.instanceId,
    announcement(candidate, definition.displayName),
  );
}

export function personalSurfaceEditorReducer(
  state: PersonalSurfaceEditorState,
  action: PersonalSurfaceEditorAction,
): PersonalSurfaceEditorState {
  if (action.type === "replace_saved") {
    const availablePlacements = action.availablePlacements.map((placement) =>
      Object.freeze({ ...placement }),
    );
    const placements = action.placements.map((placement) => Object.freeze({ ...placement }));
    return {
      ...state,
      announcement: null,
      availablePlacements: Object.freeze(availablePlacements),
      dirty: false,
      issue: null,
      overlayVersion: action.overlayVersion,
      placements: Object.freeze(placements),
      savedPlacements: Object.freeze(placements),
      selectedInstanceId: placements[0]?.instanceId ?? null,
    };
  }
  if (action.type === "select") {
    const selected = state.placements.find(({ instanceId }) => instanceId === action.instanceId);
    if (!selected) return { ...state, issue: "That widget is not on this surface." };
    const definition = getPresentationWidgetDefinition(
      selected.widgetDefinitionId,
      selected.widgetDefinitionVersion,
    );
    return {
      ...state,
      announcement: `Selected ${definition.displayName}. Column ${selected.column}, row ${selected.row}. ${selected.columnSpan} columns by ${selected.rowSpan} rows.`,
      issue: null,
      selectedInstanceId: action.instanceId,
    };
  }
  if (action.type === "remove_selected") {
    if (!state.selectedInstanceId) return { ...state, issue: "Select a widget first." };
    const registered = state.availablePlacements.find(
      ({ instanceId }) => instanceId === state.selectedInstanceId,
    );
    if (!registered) return { ...state, issue: "That widget is no longer registered." };
    if (!isPersonalSurfaceWidgetRemovable(state.surfaceId, registered.instanceId)) {
      return { ...state, issue: "This widget is required by the current surface." };
    }
    return updatedState(
      state,
      state.placements.filter(({ instanceId }) => instanceId !== state.selectedInstanceId),
      null,
      `Removed ${
        getPresentationWidgetDefinition(
          registered.widgetDefinitionId,
          registered.widgetDefinitionVersion,
        ).displayName
      } from this draft.`,
    );
  }
  if (action.type === "add") {
    if (state.placements.some(({ instanceId }) => instanceId === action.instanceId)) {
      return { ...state, issue: "That widget is already on this surface." };
    }
    const registered = state.availablePlacements.find(
      ({ instanceId }) => instanceId === action.instanceId,
    );
    if (!registered) return { ...state, issue: "That widget is not currently available." };
    const placement = firstFreePlacement(registered, state.placements);
    if (!placement) return { ...state, issue: "No bounded space is available for that widget." };
    return updatedState(
      state,
      [...state.placements, Object.freeze(placement)],
      placement.instanceId,
      `Added ${
        getPresentationWidgetDefinition(
          placement.widgetDefinitionId,
          placement.widgetDefinitionVersion,
        ).displayName
      }. Column ${placement.column}, row ${placement.row}.`,
    );
  }
  if (action.type === "move") {
    return transformInstance(
      state,
      action.instanceId,
      (placement) => ({
        ...placement,
        column: placement.column + action.columnDelta,
        row: placement.row + action.rowDelta,
      }),
      (placement, displayName) =>
        `${displayName} moved to column ${placement.column}, row ${placement.row}.`,
    );
  }
  return transformInstance(
    state,
    action.instanceId,
    (placement) => ({
      ...placement,
      columnSpan: placement.columnSpan + action.columnSpanDelta,
      rowSpan: placement.rowSpan + action.rowSpanDelta,
    }),
    (placement, displayName) =>
      `${displayName} resized to ${placement.columnSpan} columns by ${placement.rowSpan} rows.`,
  );
}

export function surfaceEditorKeyboardAction(
  state: PersonalSurfaceEditorState,
  input: Readonly<{ instanceId?: string; key: string; shiftKey: boolean }>,
): PersonalSurfaceEditorState {
  const instanceId = input.instanceId ?? state.selectedInstanceId;
  if (!instanceId) return state;
  const delta = {
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
  }[input.key];
  if (!delta) return state;
  const [horizontal, vertical] = delta;
  return personalSurfaceEditorReducer(
    state,
    input.shiftKey
      ? {
          columnSpanDelta: horizontal ?? 0,
          instanceId,
          rowSpanDelta: vertical ?? 0,
          type: "resize",
        }
      : {
          columnDelta: horizontal ?? 0,
          instanceId,
          rowDelta: vertical ?? 0,
          type: "move",
        },
  );
}
