"use client";

import {
  getPresentationWidgetDefinition,
  type PresentationPersonalSurfaceEditorWorkspace,
  parseResetPresentationSurfaceOverlayResponse,
  parseUpdatePresentationSurfaceOverlayResponse,
} from "@esbla/contracts";
import {
  ArrowLeft,
  Columns3,
  Grip,
  LockKeyhole,
  Monitor,
  Move,
  Plus,
  RotateCcw,
  Save,
  Smartphone,
  Tablet,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type ResolvedPresentationBreakpointLayout,
  resolvePresentationBreakpointLayout,
} from "../../../../../lib/presentation-layout-core";
import {
  beginSurfaceEditorInteraction,
  createPersonalSurfaceEditorState,
  isPersonalSurfaceWidgetRemovable,
  personalSurfaceEditorReducer,
  type SurfaceEditorInteractionMode,
  type SurfaceEditorInteractionSession,
  stepSurfaceEditorInteraction,
  surfaceEditorKeyboardAction,
  updateSurfaceEditorInteraction,
} from "../../../../../lib/surface-editor-core";
import { prepareRouteHeadingFocus } from "../../../../../theme/zen-theme/v1/chrome/zen-navigation-chrome";
import { SurfaceGeometryControls } from "../surface-geometry-controls";

type PreviewMode = "desktop" | "phone" | "tablet";

const KEYBOARD_INTERACTION_POINTER_ID = -1;

const PREVIEW_OPTIONS = [
  { columns: 12, icon: Monitor, id: "desktop", label: "Desktop" },
  { columns: 8, icon: Tablet, id: "tablet", label: "Tablet" },
  { columns: 4, icon: Smartphone, id: "phone", label: "Phone" },
] as const;

function statusMessage(status: number): string {
  if (status === 403) return "Your access or this service’s availability is no longer current.";
  if (status === 409) return "This layout changed in another tab. Reload before editing again.";
  if (status === 400) return "The layout is no longer valid. Review its size and position.";
  return "The layout result could not be verified. Reload before making another change.";
}

function placementStyle(
  placement: ResolvedPresentationBreakpointLayout["placements"][number],
): CSSProperties {
  return {
    gridColumn: `${placement.column} / span ${placement.columnSpan}`,
    gridRow: `${placement.row} / span ${placement.rowSpan}`,
  };
}

export function PersonalSurfaceEditor({
  initialWorkspace,
  returnHref,
  surfaceName,
}: Readonly<{
  initialWorkspace: PresentationPersonalSurfaceEditorWorkspace;
  returnHref: "/" | "/workspace/hr";
  surfaceName: string;
}>) {
  const router = useRouter();
  const [state, dispatch] = useReducer(
    personalSurfaceEditorReducer,
    {
      availablePlacements: initialWorkspace.availablePlacements,
      effectivePlacements: initialWorkspace.layout.effectivePlacements,
      overlayVersion: initialWorkspace.layout.overlayVersion,
      surfaceId: initialWorkspace.layout.surfaceId,
    },
    createPersonalSurfaceEditorState,
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [pendingAction, setPendingAction] = useState<"reset" | "save" | null>(null);
  const [remoteIssue, setRemoteIssue] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [phoneViewport, setPhoneViewport] = useState(false);
  const [interaction, setInteraction] = useState<SurfaceEditorInteractionSession | null>(null);
  const interactionRef = useRef<SurfaceEditorInteractionSession | null>(null);
  const editable = initialWorkspace.editable && !accessLost;
  const layout = useMemo(
    () => resolvePresentationBreakpointLayout(state.placements, previewMode),
    [previewMode, state.placements],
  );
  const selected = state.placements.find(
    ({ instanceId }) => instanceId === state.selectedInstanceId,
  );
  const selectedDefinition = selected
    ? getPresentationWidgetDefinition(selected.widgetDefinitionId, selected.widgetDefinitionVersion)
    : undefined;
  const selectedRemovable = selected
    ? isPersonalSurfaceWidgetRemovable(state.surfaceId, selected.instanceId)
    : false;
  const absent = state.availablePlacements.filter(
    ({ instanceId }) => !state.placements.some((placement) => placement.instanceId === instanceId),
  );
  const busy = pendingAction !== null;

  useEffect(() => {
    if (!state.dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.dirty]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 599px)");
    const apply = () => {
      setPhoneViewport(query.matches);
      if (query.matches) setPreviewMode("phone");
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  function confirmReturn(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (state.dirty && !window.confirm("Discard your unsaved layout changes?")) {
      event.preventDefault();
      return;
    }
    prepareRouteHeadingFocus(event);
  }

  async function save() {
    if (!editable || busy || !state.dirty) return;
    setPendingAction("save");
    setRemoteIssue(null);
    try {
      const response = await fetch(
        `/presentation/surfaces/${encodeURIComponent(state.surfaceId)}`,
        {
          body: JSON.stringify({
            expectedVersion: state.overlayVersion,
            idempotencyKey: crypto.randomUUID(),
            placements: state.placements,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (response.status !== 200) {
        if (response.status === 403) setAccessLost(true);
        setRemoteIssue(statusMessage(response.status));
        return;
      }
      const saved = parseUpdatePresentationSurfaceOverlayResponse(await response.json());
      dispatch({
        availablePlacements: state.availablePlacements,
        overlayVersion: saved.overlayVersion,
        placements: saved.effectivePlacements,
        type: "replace_saved",
      });
      router.refresh();
    } catch {
      setRemoteIssue(
        "The layout result could not be verified. Reload before making another change.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function reset() {
    if (!editable || !initialWorkspace.resettable || busy || state.overlayVersion < 1) return;
    if (!window.confirm("Restore the current tenant layout and remove your personal changes?")) {
      return;
    }
    setPendingAction("reset");
    setRemoteIssue(null);
    try {
      const response = await fetch(
        `/presentation/surfaces/${encodeURIComponent(state.surfaceId)}/reset`,
        {
          body: JSON.stringify({
            expectedVersion: state.overlayVersion,
            idempotencyKey: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (response.status !== 200) {
        if (response.status === 403) setAccessLost(true);
        setRemoteIssue(statusMessage(response.status));
        return;
      }
      const restored = parseResetPresentationSurfaceOverlayResponse(await response.json());
      dispatch({
        availablePlacements: state.availablePlacements,
        overlayVersion: restored.overlayVersion,
        placements: restored.effectivePlacements,
        type: "replace_saved",
      });
      router.refresh();
    } catch {
      setRemoteIssue(
        "The reset result could not be verified. Reload before making another change.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  function setActiveInteraction(next: SurfaceEditorInteractionSession | null) {
    interactionRef.current = next;
    setInteraction(next);
  }

  function beginInteraction(
    event: ReactPointerEvent<HTMLButtonElement>,
    instanceId: string,
    mode: SurfaceEditorInteractionMode,
    columnCount: number,
  ) {
    if (!editable || phoneViewport || previewMode !== "desktop") return;
    dispatch({ instanceId, type: "select" });
    const grid = event.currentTarget.closest<HTMLElement>(".surface-editor-grid");
    if (!grid) return;
    const bounds = grid.getBoundingClientRect();
    const computed = getComputedStyle(grid);
    const columnGap = Number.parseFloat(computed.columnGap) || 0;
    const rowGap = Number.parseFloat(computed.rowGap) || 0;
    const rowHeight = Number.parseFloat(computed.gridAutoRows) || 48;
    const started = beginSurfaceEditorInteraction(state, {
      columnStep: (bounds.width - columnGap * (columnCount - 1)) / columnCount + columnGap,
      instanceId,
      mode,
      pointerId: event.pointerId,
      rowStep: rowHeight + rowGap,
      startClientX: event.clientX,
      startClientY: event.clientY,
    });
    if (!started) return;
    setActiveInteraction(started);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function previewInteraction(event: ReactPointerEvent<HTMLButtonElement>) {
    const started = interactionRef.current;
    if (!started || started.pointerId !== event.pointerId) return;
    setActiveInteraction(
      updateSurfaceEditorInteraction(state, started, {
        clientX: event.clientX,
        clientY: event.clientY,
      }),
    );
  }

  function finishInteraction(event: ReactPointerEvent<HTMLButtonElement>) {
    const started = interactionRef.current;
    if (!started || started.pointerId !== event.pointerId) return;
    const completed = updateSurfaceEditorInteraction(state, started, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
    setActiveInteraction(null);
    dispatch({ interaction: completed, type: "commit_interaction" });
  }

  function cancelInteraction(pointerId?: number) {
    const started = interactionRef.current;
    if (!started || (pointerId !== undefined && started.pointerId !== pointerId)) return;
    setActiveInteraction(null);
    dispatch({ interaction: started, type: "cancel_interaction" });
  }

  function toggleKeyboardInteraction(instanceId: string, mode: SurfaceEditorInteractionMode) {
    if (!editable || phoneViewport || previewMode !== "desktop") return;
    const active = interactionRef.current;
    if (active) {
      if (
        active.pointerId === KEYBOARD_INTERACTION_POINTER_ID &&
        active.instanceId === instanceId &&
        active.mode === mode
      ) {
        setActiveInteraction(null);
        dispatch({ interaction: active, type: "commit_interaction" });
      }
      return;
    }
    dispatch({ instanceId, type: "select" });
    const started = beginSurfaceEditorInteraction(state, {
      columnStep: 1,
      instanceId,
      mode,
      pointerId: KEYBOARD_INTERACTION_POINTER_ID,
      rowStep: 1,
      startClientX: 0,
      startClientY: 0,
    });
    if (started) setActiveInteraction(started);
  }

  function stepKeyboardInteraction(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    instanceId: string,
    mode: SurfaceEditorInteractionMode,
  ) {
    const active = interactionRef.current;
    if (
      !active ||
      active.pointerId !== KEYBOARD_INTERACTION_POINTER_ID ||
      active.instanceId !== instanceId ||
      active.mode !== mode
    ) {
      return;
    }
    const delta = {
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    setActiveInteraction(
      stepSurfaceEditorInteraction(state, active, {
        horizontalDelta: delta[0] ?? 0,
        verticalDelta: delta[1] ?? 0,
      }),
    );
  }

  useEffect(() => {
    if (!interaction) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const started = interactionRef.current;
      if (!started) return;
      interactionRef.current = null;
      setInteraction(null);
      dispatch({ interaction: started, type: "cancel_interaction" });
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [interaction]);

  return (
    <section aria-labelledby="surface-editor-heading" className="surface-editor-shell">
      <header className="surface-editor-header">
        <div>
          <p className="surface-label">Studio · Personal layout</p>
          <h1 id="surface-editor-heading">Shape your {surfaceName}</h1>
          <p>Arrange your own surface. HR records and workflow rules remain untouched.</p>
        </div>
        <div aria-label="Editor actions" className="surface-editor-actions" role="toolbar">
          <Link
            aria-label={`Return to ${surfaceName}`}
            className="surface-editor-icon-button"
            href={returnHref}
            onClick={confirmReturn}
            title={`Return to ${surfaceName}`}
          >
            <ArrowLeft aria-hidden="true" size={18} />
          </Link>
          <button
            aria-label="Restore tenant layout"
            className="surface-editor-icon-button"
            disabled={!editable || !initialWorkspace.resettable || busy || state.overlayVersion < 1}
            onClick={reset}
            title="Restore tenant layout"
            type="button"
          >
            <RotateCcw aria-hidden="true" size={18} />
          </button>
          <button
            aria-label="Save personal layout"
            className="surface-editor-icon-button surface-editor-save"
            disabled={!editable || busy || !state.dirty}
            onClick={save}
            title="Save personal layout"
            type="button"
          >
            <Save aria-hidden="true" size={18} />
          </button>
        </div>
      </header>

      {!editable ? (
        <div className="surface-editor-lock" role="status">
          <LockKeyhole aria-hidden="true" size={18} />
          <div>
            <strong>Personal editing is locked</strong>
            <p>
              {accessLost
                ? "Your access or service availability changed. Reload after an administrator restores it."
                : "Your current account can view this surface but cannot change its personal layout."}
            </p>
          </div>
        </div>
      ) : null}
      {remoteIssue ? (
        <div className="surface-editor-issue" role="alert">
          <strong>Layout update needs attention</strong>
          <span>{remoteIssue}</span>
          {remoteIssue.includes("another tab") || remoteIssue.includes("could not be verified") ? (
            <button onClick={() => window.location.reload()} type="button">
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="surface-editor-workbench">
        <aside aria-label="Surface widgets and controls" className="surface-editor-inspector">
          <section>
            <div className="surface-editor-section-heading">
              <Columns3 aria-hidden="true" size={17} />
              <h2>Widgets</h2>
              <span>{state.placements.length}</span>
            </div>
            {absent.length > 0 ? (
              <ul className="surface-editor-catalogue">
                {absent.map((placement) => {
                  const definition = getPresentationWidgetDefinition(
                    placement.widgetDefinitionId,
                    placement.widgetDefinitionVersion,
                  );
                  return (
                    <li key={placement.instanceId}>
                      <span>{definition.displayName}</span>
                      <button
                        aria-label={`Add ${definition.displayName}`}
                        disabled={!editable || busy}
                        onClick={() => dispatch({ instanceId: placement.instanceId, type: "add" })}
                        title={`Add ${definition.displayName}`}
                        type="button"
                      >
                        <Plus aria-hidden="true" size={16} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="surface-editor-muted">Every available widget is on this surface.</p>
            )}
          </section>

          <section>
            <div className="surface-editor-section-heading">
              <Move aria-hidden="true" size={17} />
              <h2>Selection</h2>
            </div>
            {selected && selectedDefinition ? (
              <div className="surface-editor-selection">
                <strong>{selectedDefinition.displayName}</strong>
                <span>
                  Column {selected.column}, row {selected.row} · {selected.columnSpan} columns ×{" "}
                  {selected.rowSpan} rows
                </span>
                <p>
                  Arrow keys move. Shift + Arrow keys resize. Pointer dragging uses the same
                  collision rules.
                </p>
                <SurfaceGeometryControls
                  disabled={!editable || busy}
                  onMove={(columnDelta, rowDelta) =>
                    dispatch({
                      columnDelta,
                      instanceId: selected.instanceId,
                      rowDelta,
                      type: "move",
                    })
                  }
                  onResize={(columnSpanDelta, rowSpanDelta) =>
                    dispatch({
                      columnSpanDelta,
                      instanceId: selected.instanceId,
                      rowSpanDelta,
                      type: "resize",
                    })
                  }
                  placement={selected}
                />
                <p className="surface-editor-muted">
                  This widget has no configurable presentation options in V1.
                </p>
                <div className="surface-editor-selection-actions">
                  <button
                    aria-label="Remove from surface"
                    className="surface-editor-remove"
                    disabled={!editable || busy || !selectedRemovable}
                    onClick={() => dispatch({ type: "remove_selected" })}
                    title="Remove from surface"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={15} />
                    <span>Remove</span>
                  </button>
                </div>
                {!selectedRemovable ? (
                  <p className="surface-editor-muted">
                    This widget is required by the current surface.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="surface-editor-muted">Select a widget in the preview to edit it.</p>
            )}
            {state.lastRemoved ? (
              <button
                aria-label="Undo removed widget"
                className="surface-editor-undo"
                disabled={!editable || busy}
                onClick={() => dispatch({ type: "undo_remove" })}
                title="Undo removed widget"
                type="button"
              >
                <RotateCcw aria-hidden="true" size={15} />
                <span>Undo removed widget</span>
              </button>
            ) : null}
          </section>
        </aside>

        <div className="surface-editor-stage">
          <div className="surface-editor-preview-toolbar">
            <div
              aria-label="Responsive preview"
              className="surface-editor-preview-options"
              role="toolbar"
            >
              {PREVIEW_OPTIONS.map(({ icon: Icon, id, label }) => (
                <button
                  aria-label={`${label} preview`}
                  aria-pressed={previewMode === id}
                  key={id}
                  onClick={() => setPreviewMode(id)}
                  title={`${label} preview`}
                  type="button"
                >
                  <Icon aria-hidden="true" size={17} />
                </button>
              ))}
            </div>
            <span aria-live="polite">
              {pendingAction === "save"
                ? "Saving…"
                : pendingAction === "reset"
                  ? "Resetting…"
                  : state.dirty
                    ? "Unsaved changes"
                    : "Saved"}
            </span>
          </div>

          <div
            className={`surface-editor-viewport surface-editor-viewport-${previewMode}`}
            data-preview-mode={previewMode}
          >
            <div
              className="surface-editor-grid"
              style={{ gridTemplateColumns: `repeat(${layout.columnCount}, minmax(0, 1fr))` }}
            >
              {layout.placements.map((placement) => {
                const definition = getPresentationWidgetDefinition(
                  placement.widgetDefinitionId,
                  placement.widgetDefinitionVersion,
                );
                const selectedNow = placement.instanceId === state.selectedInstanceId;
                const activeInteraction =
                  interaction?.instanceId === placement.instanceId ? interaction : null;
                const displayedPlacement = activeInteraction?.proposal ?? placement;
                return (
                  <Fragment key={placement.instanceId}>
                    {activeInteraction ? (
                      <div
                        aria-hidden="true"
                        className="surface-editor-widget-placeholder"
                        style={placementStyle(placement)}
                      />
                    ) : null}
                    <div
                      className="surface-editor-widget"
                      data-interaction-active={activeInteraction ? "true" : "false"}
                      data-interaction-valid={activeInteraction?.valid ?? undefined}
                      data-selected={selectedNow ? "true" : "false"}
                      style={placementStyle(displayedPlacement)}
                    >
                      <button
                        aria-label={`${definition.displayName}, ${displayedPlacement.columnSpan} columns by ${displayedPlacement.rowSpan} rows, column ${displayedPlacement.column}, row ${displayedPlacement.row}`}
                        aria-pressed={selectedNow}
                        className="surface-editor-widget-select"
                        onClick={() =>
                          dispatch({ instanceId: placement.instanceId, type: "select" })
                        }
                        onKeyDown={(event) => {
                          if (!editable || phoneViewport || previewMode !== "desktop") return;
                          const next = surfaceEditorKeyboardAction(state, {
                            instanceId: placement.instanceId,
                            key: event.key,
                            shiftKey: event.shiftKey,
                          });
                          if (next !== state) {
                            event.preventDefault();
                            dispatch(
                              event.shiftKey
                                ? {
                                    columnSpanDelta:
                                      event.key === "ArrowRight"
                                        ? 1
                                        : event.key === "ArrowLeft"
                                          ? -1
                                          : 0,
                                    instanceId: placement.instanceId,
                                    rowSpanDelta:
                                      event.key === "ArrowDown"
                                        ? 1
                                        : event.key === "ArrowUp"
                                          ? -1
                                          : 0,
                                    type: "resize",
                                  }
                                : {
                                    columnDelta:
                                      event.key === "ArrowRight"
                                        ? 1
                                        : event.key === "ArrowLeft"
                                          ? -1
                                          : 0,
                                    instanceId: placement.instanceId,
                                    rowDelta:
                                      event.key === "ArrowDown"
                                        ? 1
                                        : event.key === "ArrowUp"
                                          ? -1
                                          : 0,
                                    type: "move",
                                  },
                            );
                          }
                        }}
                        tabIndex={phoneViewport ? -1 : 0}
                        type="button"
                      >
                        <strong>{definition.displayName}</strong>
                        <small>{definition.widgetKind.replace("_", " ")}</small>
                      </button>
                      <button
                        aria-label={`Move ${definition.displayName}`}
                        aria-pressed={
                          activeInteraction?.pointerId === KEYBOARD_INTERACTION_POINTER_ID &&
                          activeInteraction.mode === "move"
                        }
                        className="surface-editor-widget-handle"
                        disabled={!editable || phoneViewport || previewMode !== "desktop"}
                        onClick={(event) => {
                          if (event.detail === 0) {
                            toggleKeyboardInteraction(placement.instanceId, "move");
                          }
                        }}
                        onKeyDown={(event) =>
                          stepKeyboardInteraction(event, placement.instanceId, "move")
                        }
                        onPointerCancel={(event) => cancelInteraction(event.pointerId)}
                        onPointerDown={(event) =>
                          beginInteraction(event, placement.instanceId, "move", layout.columnCount)
                        }
                        onPointerMove={previewInteraction}
                        onPointerUp={finishInteraction}
                        title={`Move ${definition.displayName}`}
                        type="button"
                      >
                        <Grip aria-hidden="true" size={15} />
                      </button>
                      <button
                        aria-label={`Resize ${definition.displayName}`}
                        aria-pressed={
                          activeInteraction?.pointerId === KEYBOARD_INTERACTION_POINTER_ID &&
                          activeInteraction.mode === "resize"
                        }
                        className="surface-editor-widget-resize-handle"
                        disabled={!editable || phoneViewport || previewMode !== "desktop"}
                        onClick={(event) => {
                          if (event.detail === 0) {
                            toggleKeyboardInteraction(placement.instanceId, "resize");
                          }
                        }}
                        onKeyDown={(event) =>
                          stepKeyboardInteraction(event, placement.instanceId, "resize")
                        }
                        onPointerCancel={(event) => cancelInteraction(event.pointerId)}
                        onPointerDown={(event) =>
                          beginInteraction(
                            event,
                            placement.instanceId,
                            "resize",
                            layout.columnCount,
                          )
                        }
                        onPointerMove={previewInteraction}
                        onPointerUp={finishInteraction}
                        title={`Resize ${definition.displayName}`}
                        type="button"
                      />
                    </div>
                  </Fragment>
                );
              })}
              {layout.placements.length === 0 ? (
                <div className="surface-editor-empty">
                  <strong>This surface is empty</strong>
                  <p>Add an available widget from the inspector.</p>
                </div>
              ) : null}
            </div>
          </div>
          {interaction || state.issue || state.announcement ? (
            <p
              aria-live="polite"
              className="surface-editor-local-status"
              data-status={interaction?.issue || state.issue ? "error" : "update"}
            >
              {interaction?.announcement ?? state.issue ?? state.announcement}
            </p>
          ) : null}
          <p className="surface-editor-phone-note">
            Editing controls are available on tablet and desktop. Phone preview remains read-only.
          </p>
        </div>
      </div>
    </section>
  );
}
