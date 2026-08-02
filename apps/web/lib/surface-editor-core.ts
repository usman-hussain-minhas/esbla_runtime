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
  readonly lastRemoved: Readonly<{
    index: number;
    placement: PresentationWidgetPlacement;
  }> | null;
  readonly overlayVersion: number;
  readonly placements: readonly PresentationWidgetPlacement[];
  readonly savedPlacements: readonly PresentationWidgetPlacement[];
  readonly selectedInstanceId: string | null;
  readonly surfaceId: ZenV1SurfaceId;
}

export type PersonalSurfaceEditorAction =
  | Readonly<{ instanceId: string; type: "add" }>
  | Readonly<{ interaction: SurfaceEditorInteractionSession; type: "cancel_interaction" }>
  | Readonly<{ interaction: SurfaceEditorInteractionSession; type: "commit_interaction" }>
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
  | Readonly<{ type: "undo_remove" }>
  | Readonly<{
      availablePlacements: readonly PresentationWidgetPlacement[];
      overlayVersion: number;
      placements: readonly PresentationWidgetPlacement[];
      type: "replace_saved";
    }>;

export type SurfaceEditorInteractionMode = "move" | "resize";

export interface SurfaceEditorInteractionSession {
  readonly announcement: string;
  readonly changed: boolean;
  readonly columnStep: number;
  readonly instanceId: string;
  readonly issue: string | null;
  readonly mode: SurfaceEditorInteractionMode;
  readonly origin: PresentationWidgetPlacement;
  readonly pointerId: number;
  readonly proposal: PresentationWidgetPlacement;
  readonly rowStep: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly valid: boolean;
}

interface BeginSurfaceEditorInteractionInput {
  readonly columnStep: number;
  readonly instanceId: string;
  readonly mode: SurfaceEditorInteractionMode;
  readonly pointerId: number;
  readonly rowStep: number;
  readonly startClientX: number;
  readonly startClientY: number;
}

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

function placementIssue(
  state: PersonalSurfaceEditorState,
  candidate: PresentationWidgetPlacement,
): string | null {
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
    return "That size or position is outside this widget’s limits.";
  }
  if (overlaps(candidate, state.placements)) return "That position is occupied.";
  return null;
}

function samePlacement(
  left: PresentationWidgetPlacement,
  right: PresentationWidgetPlacement,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.widgetDefinitionId === right.widgetDefinitionId &&
    left.widgetDefinitionVersion === right.widgetDefinitionVersion &&
    left.column === right.column &&
    left.row === right.row &&
    left.columnSpan === right.columnSpan &&
    left.rowSpan === right.rowSpan
  );
}

function interactionAnnouncement(
  mode: SurfaceEditorInteractionMode,
  proposal: PresentationWidgetPlacement,
  displayName: string,
  issue: string | null,
): string {
  const geometry =
    mode === "move"
      ? `column ${proposal.column}, row ${proposal.row}`
      : `${proposal.columnSpan} columns by ${proposal.rowSpan} rows`;
  return issue
    ? `${displayName} ${mode} target ${geometry} is unavailable. ${issue}`
    : `${displayName} ${mode} target ${geometry} is available.`;
}

export function beginSurfaceEditorInteraction(
  state: PersonalSurfaceEditorState,
  input: BeginSurfaceEditorInteractionInput,
): SurfaceEditorInteractionSession | undefined {
  const origin = state.placements.find(({ instanceId }) => instanceId === input.instanceId);
  if (!origin || input.columnStep <= 0 || input.rowStep <= 0) return undefined;
  const definition = getPresentationWidgetDefinition(
    origin.widgetDefinitionId,
    origin.widgetDefinitionVersion,
  );
  return Object.freeze({
    announcement: `Picked up ${definition.displayName} to ${input.mode}.`,
    changed: false,
    columnStep: input.columnStep,
    instanceId: input.instanceId,
    issue: null,
    mode: input.mode,
    origin: Object.freeze({ ...origin }),
    pointerId: input.pointerId,
    proposal: Object.freeze({ ...origin }),
    rowStep: input.rowStep,
    startClientX: input.startClientX,
    startClientY: input.startClientY,
    valid: true,
  });
}

export function updateSurfaceEditorInteraction(
  state: PersonalSurfaceEditorState,
  session: SurfaceEditorInteractionSession,
  pointer: Readonly<{ clientX: number; clientY: number }>,
): SurfaceEditorInteractionSession {
  const horizontal = Math.round((pointer.clientX - session.startClientX) / session.columnStep);
  const vertical = Math.round((pointer.clientY - session.startClientY) / session.rowStep);
  const proposal = Object.freeze(
    session.mode === "resize"
      ? {
          ...session.origin,
          columnSpan: session.origin.columnSpan + horizontal,
          rowSpan: session.origin.rowSpan + vertical,
        }
      : {
          ...session.origin,
          column: session.origin.column + horizontal,
          row: session.origin.row + vertical,
        },
  );
  const issue = placementIssue(state, proposal);
  const definition = getPresentationWidgetDefinition(
    proposal.widgetDefinitionId,
    proposal.widgetDefinitionVersion,
  );
  return Object.freeze({
    ...session,
    announcement: interactionAnnouncement(session.mode, proposal, definition.displayName, issue),
    changed: !samePlacement(proposal, session.origin),
    issue,
    proposal,
    valid: issue === null,
  });
}

export function stepSurfaceEditorInteraction(
  state: PersonalSurfaceEditorState,
  session: SurfaceEditorInteractionSession,
  step: Readonly<{ horizontalDelta: number; verticalDelta: number }>,
): SurfaceEditorInteractionSession {
  const currentHorizontal =
    session.mode === "move"
      ? session.proposal.column - session.origin.column
      : session.proposal.columnSpan - session.origin.columnSpan;
  const currentVertical =
    session.mode === "move"
      ? session.proposal.row - session.origin.row
      : session.proposal.rowSpan - session.origin.rowSpan;
  return updateSurfaceEditorInteraction(state, session, {
    clientX: session.startClientX + (currentHorizontal + step.horizontalDelta) * session.columnStep,
    clientY: session.startClientY + (currentVertical + step.verticalDelta) * session.rowStep,
  });
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

export function commitSurfaceEditorInteraction(
  state: PersonalSurfaceEditorState,
  session: SurfaceEditorInteractionSession,
): PersonalSurfaceEditorState {
  const current = state.placements.find(({ instanceId }) => instanceId === session.instanceId);
  if (!current || !samePlacement(current, session.origin)) {
    return { ...state, issue: "That widget changed before the interaction completed." };
  }
  if (!session.changed) {
    return {
      ...state,
      announcement: `Selected ${
        getPresentationWidgetDefinition(current.widgetDefinitionId, current.widgetDefinitionVersion)
          .displayName
      }.`,
      issue: null,
      selectedInstanceId: current.instanceId,
    };
  }
  const issue = placementIssue(state, session.proposal);
  if (issue) {
    return { ...state, announcement: null, issue, selectedInstanceId: current.instanceId };
  }
  const definition = getPresentationWidgetDefinition(
    session.proposal.widgetDefinitionId,
    session.proposal.widgetDefinitionVersion,
  );
  return updatedState(
    state,
    state.placements.map((placement) =>
      placement.instanceId === session.instanceId
        ? Object.freeze({ ...session.proposal })
        : placement,
    ),
    session.instanceId,
    session.mode === "move"
      ? `Dropped ${definition.displayName} at column ${session.proposal.column}, row ${session.proposal.row}.`
      : `Dropped ${definition.displayName} at ${session.proposal.columnSpan} columns by ${session.proposal.rowSpan} rows.`,
  );
}

export function cancelSurfaceEditorInteraction(
  state: PersonalSurfaceEditorState,
  session: SurfaceEditorInteractionSession,
): PersonalSurfaceEditorState {
  const definition = getPresentationWidgetDefinition(
    session.origin.widgetDefinitionId,
    session.origin.widgetDefinitionVersion,
  );
  return {
    ...state,
    announcement: `Cancelled ${session.mode === "move" ? "moving" : "resizing"} ${
      definition.displayName
    }. It remains at column ${session.origin.column}, row ${session.origin.row}.`,
    issue: null,
    selectedInstanceId: session.instanceId,
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
    lastRemoved: null,
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
  const issue = placementIssue(state, candidate);
  if (issue) return { ...state, issue };
  const definition = getPresentationWidgetDefinition(
    candidate.widgetDefinitionId,
    candidate.widgetDefinitionVersion,
  );
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
      lastRemoved: null,
      overlayVersion: action.overlayVersion,
      placements: Object.freeze(placements),
      savedPlacements: Object.freeze(placements),
      selectedInstanceId: placements[0]?.instanceId ?? null,
    };
  }
  if (action.type === "commit_interaction") {
    return commitSurfaceEditorInteraction(state, action.interaction);
  }
  if (action.type === "cancel_interaction") {
    return cancelSurfaceEditorInteraction(state, action.interaction);
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
    const index = state.placements.findIndex(
      ({ instanceId }) => instanceId === state.selectedInstanceId,
    );
    const removedPlacement = state.placements[index];
    if (!removedPlacement) return { ...state, issue: "That widget is not on this surface." };
    return {
      ...updatedState(
        state,
        state.placements.filter(({ instanceId }) => instanceId !== state.selectedInstanceId),
        null,
        `Removed ${
          getPresentationWidgetDefinition(
            registered.widgetDefinitionId,
            registered.widgetDefinitionVersion,
          ).displayName
        } from this draft.`,
      ),
      lastRemoved: Object.freeze({ index, placement: Object.freeze({ ...removedPlacement }) }),
    };
  }
  if (action.type === "undo_remove") {
    const removed = state.lastRemoved;
    if (!removed) return { ...state, issue: "There is no removed widget to restore." };
    if (state.placements.some(({ instanceId }) => instanceId === removed.placement.instanceId)) {
      return { ...state, issue: "That widget is already on this surface." };
    }
    const issue = placementIssue(state, removed.placement);
    if (issue) return { ...state, issue: `The removed widget cannot be restored. ${issue}` };
    const placements = [...state.placements];
    placements.splice(Math.min(removed.index, placements.length), 0, removed.placement);
    const definition = getPresentationWidgetDefinition(
      removed.placement.widgetDefinitionId,
      removed.placement.widgetDefinitionVersion,
    );
    return {
      ...updatedState(
        state,
        placements,
        removed.placement.instanceId,
        `Restored ${definition.displayName} to this draft.`,
      ),
      lastRemoved: null,
    };
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
    return {
      ...updatedState(
        state,
        [...state.placements, Object.freeze(placement)],
        placement.instanceId,
        `Added ${
          getPresentationWidgetDefinition(
            placement.widgetDefinitionId,
            placement.widgetDefinitionVersion,
          ).displayName
        }. Column ${placement.column}, row ${placement.row}.`,
      ),
      lastRemoved:
        state.lastRemoved?.placement.instanceId === placement.instanceId ? null : state.lastRemoved,
    };
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
