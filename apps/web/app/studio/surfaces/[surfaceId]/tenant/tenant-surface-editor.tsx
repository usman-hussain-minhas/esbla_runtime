"use client";

import {
  getPresentationWidgetDefinition,
  type PresentationSurfaceBaseWorkspace,
  parsePresentationSurfaceBaseMutationResponse,
  parseUpsertPresentationSurfaceDraftResponse,
  parseValidatePresentationSurfaceDraftResponse,
} from "@esbla/contracts";
import {
  ArrowLeft,
  CircleCheckBig,
  Clock3,
  Grip,
  History,
  LockKeyhole,
  Monitor,
  Move,
  RotateCcw,
  Save,
  Send,
  Smartphone,
  Tablet,
} from "lucide-react";
import Link from "next/link";
import {
  type CSSProperties,
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
  createPersonalSurfaceEditorState,
  personalSurfaceEditorReducer,
  surfaceEditorKeyboardAction,
} from "../../../../../lib/surface-editor-core";
import {
  applyTenantSurfaceBaseMutation,
  applyTenantSurfaceDraftSave,
  createTenantSurfaceEditorModel,
  loseTenantSurfaceAction,
  type TenantSurfaceAction,
} from "../../../../../lib/tenant-surface-editor-core";
import { prepareRouteHeadingFocus } from "../../../../../theme/zen-theme/v1/chrome/zen-navigation-chrome";

type PreviewMode = "desktop" | "phone" | "tablet";
type PendingAction = "draft" | "publish" | "rollback" | "validate";

const PREVIEW_OPTIONS = [
  { icon: Monitor, id: "desktop", label: "Desktop" },
  { icon: Tablet, id: "tablet", label: "Tablet" },
  { icon: Smartphone, id: "phone", label: "Phone" },
] as const;

function placementStyle(
  placement: ResolvedPresentationBreakpointLayout["placements"][number],
): CSSProperties {
  return {
    gridColumn: `${placement.column} / span ${placement.columnSpan}`,
    gridRow: `${placement.row} / span ${placement.rowSpan}`,
  };
}

function requestIssue(status: number): string {
  if (status === 403) {
    return "Your access or this service’s availability is no longer current. Nothing was changed.";
  }
  if (status === 409) {
    return "This tenant base changed elsewhere. Your local work is preserved; load the latest version before retrying.";
  }
  if (status === 400) {
    return "This draft no longer meets the registered surface contract. Nothing was published.";
  }
  return "The lifecycle result could not be verified. Reload before making another change.";
}

export function TenantSurfaceEditor({
  initialWorkspace,
  returnHref,
  surfaceName,
}: Readonly<{
  initialWorkspace: PresentationSurfaceBaseWorkspace;
  returnHref: "/" | "/workspace/hr";
  surfaceName: string;
}>) {
  const [model, setModel] = useState(() => createTenantSurfaceEditorModel(initialWorkspace));
  const [state, dispatch] = useReducer(
    personalSurfaceEditorReducer,
    {
      availablePlacements: initialWorkspace.availablePlacements,
      effectivePlacements:
        initialWorkspace.draft?.placements ?? initialWorkspace.currentBase.placements,
      overlayVersion: initialWorkspace.draft?.draftVersion ?? 0,
      surfaceId: initialWorkspace.currentBase.surfaceId,
    },
    createPersonalSurfaceEditorState,
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [remoteIssue, setRemoteIssue] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(
    initialWorkspace.draft ? "Draft has not been validated in this session." : null,
  );
  const [phoneViewport, setPhoneViewport] = useState(false);
  const drag = useRef<{
    columnStep: number;
    instanceId: string;
    mode: "move" | "resize";
    pointerId: number;
    rowStep: number;
    x: number;
    y: number;
  } | null>(null);
  const suppressClick = useRef(false);
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
  const busy = pendingAction !== null;
  const authoring = model.actions.canDraft && !phoneViewport && previewMode === "desktop";
  const cleanDraft = model.draft !== null && !state.dirty;

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
    if (state.dirty && !window.confirm("Discard your unsaved tenant-base changes?")) {
      event.preventDefault();
      return;
    }
    prepareRouteHeadingFocus(event);
  }

  function loseAction(action: TenantSurfaceAction) {
    setModel((current) => loseTenantSurfaceAction(current, action));
  }

  async function lifecycleRequest(
    action: PendingAction,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Response | undefined> {
    setPendingAction(action);
    setRemoteIssue(null);
    try {
      const response = await fetch(
        `/presentation/surfaces/${encodeURIComponent(state.surfaceId)}/tenant-base/${action}`,
        {
          body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (response.status !== 200) {
        if (response.status === 403) loseAction(action);
        setRemoteIssue(requestIssue(response.status));
        return undefined;
      }
      return response;
    } catch {
      setRemoteIssue(requestIssue(503));
      return undefined;
    } finally {
      setPendingAction(null);
    }
  }

  async function saveDraft() {
    if (!model.actions.canDraft || busy || !state.dirty) return;
    const response = await lifecycleRequest("draft", {
      expectedDraftVersion: model.draft?.draftVersion ?? 0,
      expectedHeadRowVersion: model.headRowVersion,
      placements: state.placements,
    });
    if (!response) return;
    try {
      const saved = parseUpsertPresentationSurfaceDraftResponse(await response.json());
      setModel((current) => applyTenantSurfaceDraftSave(current, saved));
      dispatch({
        availablePlacements: state.availablePlacements,
        overlayVersion: saved.draft.draftVersion,
        placements: saved.draft.placements,
        type: "replace_saved",
      });
      setValidation("Draft changed and must be validated before publishing.");
    } catch {
      setRemoteIssue(requestIssue(503));
    }
  }

  async function validateDraft() {
    if (!model.actions.canValidate || !cleanDraft || busy || !model.draft) return;
    const response = await lifecycleRequest("validate", {
      expectedDraftVersion: model.draft.draftVersion,
      expectedHeadRowVersion: model.headRowVersion,
    });
    if (!response) return;
    try {
      const result = parseValidatePresentationSurfaceDraftResponse(await response.json());
      setValidation(
        result.valid
          ? `Draft v${result.draftVersion} is valid. Validation did not publish it.`
          : `Draft v${result.draftVersion} is not valid and remains unpublished.`,
      );
    } catch {
      setRemoteIssue(requestIssue(503));
    }
  }

  async function publishDraft() {
    if (!model.actions.canPublish || !cleanDraft || busy || !model.draft) return;
    if (
      !window.confirm(
        `Publish candidate base v${model.draft.candidateBaseVersion} for every user of this tenant?`,
      )
    ) {
      return;
    }
    const response = await lifecycleRequest("publish", {
      expectedDraftVersion: model.draft.draftVersion,
      expectedHeadRowVersion: model.headRowVersion,
    });
    if (!response) return;
    try {
      const published = parsePresentationSurfaceBaseMutationResponse(await response.json());
      setModel((current) => applyTenantSurfaceBaseMutation(current, published));
      dispatch({
        availablePlacements: state.availablePlacements,
        overlayVersion: 0,
        placements: published.placements,
        type: "replace_saved",
      });
      setValidation(`Published tenant base v${published.baseVersion}.`);
    } catch {
      setRemoteIssue(requestIssue(503));
    }
  }

  async function rollback(sourceBaseVersion: number) {
    if (!model.actions.canRollback || model.draft || state.dirty || busy) return;
    if (
      !window.confirm(
        `Publish a new tenant-base version derived from historical v${sourceBaseVersion}? History will be preserved.`,
      )
    ) {
      return;
    }
    const response = await lifecycleRequest("rollback", {
      expectedHeadRowVersion: model.headRowVersion,
      sourceBaseVersion,
    });
    if (!response) return;
    try {
      const rolledBack = parsePresentationSurfaceBaseMutationResponse(await response.json());
      setModel((current) => applyTenantSurfaceBaseMutation(current, rolledBack));
      dispatch({
        availablePlacements: state.availablePlacements,
        overlayVersion: 0,
        placements: rolledBack.placements,
        type: "replace_saved",
      });
      setValidation(
        `Published tenant base v${rolledBack.baseVersion} from historical v${sourceBaseVersion}.`,
      );
    } catch {
      setRemoteIssue(requestIssue(503));
    }
  }

  function beginDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    instanceId: string,
    columnCount: number,
  ) {
    if (!authoring) return;
    dispatch({ instanceId, type: "select" });
    const grid = event.currentTarget.closest<HTMLElement>(".surface-editor-grid");
    if (!grid) return;
    const bounds = grid.getBoundingClientRect();
    const computed = getComputedStyle(grid);
    const columnGap = Number.parseFloat(computed.columnGap) || 0;
    const rowGap = Number.parseFloat(computed.rowGap) || 0;
    const rowHeight = Number.parseFloat(computed.gridAutoRows) || 48;
    const target = event.target instanceof Element ? event.target : undefined;
    suppressClick.current = false;
    drag.current = {
      columnStep: (bounds.width - columnGap * (columnCount - 1)) / columnCount + columnGap,
      instanceId,
      mode: target?.closest("[data-resize-handle]") ? "resize" : "move",
      pointerId: event.pointerId,
      rowStep: rowHeight + rowGap,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const started = drag.current;
    drag.current = null;
    if (!started || started.pointerId !== event.pointerId) return;
    const horizontal = Math.round((event.clientX - started.x) / started.columnStep);
    const vertical = Math.round((event.clientY - started.y) / started.rowStep);
    suppressClick.current = horizontal !== 0 || vertical !== 0;
    dispatch(
      started.mode === "resize"
        ? {
            columnSpanDelta: horizontal,
            instanceId: started.instanceId,
            rowSpanDelta: vertical,
            type: "resize",
          }
        : {
            columnDelta: horizontal,
            instanceId: started.instanceId,
            rowDelta: vertical,
            type: "move",
          },
    );
  }

  function cancelDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId === event.pointerId) {
      drag.current = null;
      suppressClick.current = false;
    }
  }

  return (
    <section aria-labelledby="surface-editor-heading" className="surface-editor-shell">
      <header className="surface-editor-header">
        <div>
          <p className="surface-label">Studio · Tenant base</p>
          <h1 id="surface-editor-heading">Publish the {surfaceName} base</h1>
          <p>
            Draft, validate and publish presentation only. HR records and workflow rules remain
            untouched.
          </p>
        </div>
        <div
          aria-label="Tenant Base editor actions"
          className="surface-editor-actions"
          role="toolbar"
        >
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
            aria-label="Save tenant-base draft"
            className="surface-editor-icon-button surface-editor-save"
            disabled={!model.actions.canDraft || busy || !state.dirty}
            onClick={saveDraft}
            title="Save tenant-base draft"
            type="button"
          >
            <Save aria-hidden="true" size={18} />
          </button>
        </div>
      </header>

      {!model.actions.canDraft ? (
        <div className="surface-editor-lock" role="status">
          <LockKeyhole aria-hidden="true" size={18} />
          <div>
            <strong>Tenant-base authoring is locked</strong>
            <p>Your current draft remains unchanged. Reload after current access is restored.</p>
          </div>
        </div>
      ) : null}
      {remoteIssue ? (
        <div className="surface-editor-issue" role="alert">
          <strong>Tenant Base update needs attention</strong>
          <span>{remoteIssue}</span>
          {remoteIssue.includes("load the latest") ||
          remoteIssue.includes("could not be verified") ? (
            <button onClick={() => window.location.reload()} type="button">
              Load latest
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="surface-editor-workbench tenant-surface-editor-workbench">
        <aside
          aria-label="Tenant Base lifecycle and selection"
          className="surface-editor-inspector"
        >
          <section>
            <div className="surface-editor-section-heading">
              <Clock3 aria-hidden="true" size={17} />
              <h2>Lifecycle</h2>
            </div>
            <dl className="tenant-surface-facts">
              <div>
                <dt>Published base</dt>
                <dd>v{model.currentBase.baseVersion}</dd>
              </div>
              <div>
                <dt>Draft</dt>
                <dd>
                  {model.draft
                    ? `v${model.draft.draftVersion} · candidate v${model.draft.candidateBaseVersion}`
                    : "None"}
                </dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>{model.lastEvidenceEventId ?? "No mutation in this session"}</dd>
              </div>
            </dl>
            <div className="tenant-surface-lifecycle-actions">
              <button
                disabled={!model.actions.canValidate || !cleanDraft || busy}
                onClick={validateDraft}
                type="button"
              >
                <CircleCheckBig aria-hidden="true" size={16} />
                Validate draft
              </button>
              <button
                className="command-button-primary"
                disabled={!model.actions.canPublish || !cleanDraft || busy}
                onClick={publishDraft}
                type="button"
              >
                <Send aria-hidden="true" size={16} />
                Publish draft
              </button>
            </div>
            {validation ? (
              <p aria-live="polite" className="tenant-surface-validation">
                {validation}
              </p>
            ) : null}
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
                  Arrow keys move. Shift + Arrow keys resize. The registered widget set remains
                  intact in Tenant Base V1.
                </p>
              </div>
            ) : (
              <p className="surface-editor-muted">Select a widget in the preview to edit it.</p>
            )}
          </section>

          <section>
            <div className="surface-editor-section-heading">
              <History aria-hidden="true" size={17} />
              <h2>Version history</h2>
            </div>
            <ol className="tenant-surface-history">
              {model.history.map((version) => (
                <li key={version.baseVersion}>
                  <div>
                    <strong>Base v{version.baseVersion}</strong>
                    <span>
                      {version.basedOnVersion === null
                        ? "Product origin"
                        : `Based on v${version.basedOnVersion}`}
                    </span>
                  </div>
                  {version.baseVersion < model.currentBase.baseVersion ? (
                    <button
                      aria-label={`Publish new version from base v${version.baseVersion}`}
                      disabled={
                        !model.actions.canRollback || model.draft !== null || state.dirty || busy
                      }
                      onClick={() => rollback(version.baseVersion)}
                      title={
                        model.draft
                          ? "Publish or discard the current draft before rollback"
                          : `Publish from v${version.baseVersion}`
                      }
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={15} />
                    </button>
                  ) : (
                    <span className="tenant-surface-current">Current</span>
                  )}
                </li>
              ))}
            </ol>
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
              {pendingAction
                ? `${pendingAction[0]?.toUpperCase()}${pendingAction.slice(1)}ing…`
                : state.dirty
                  ? "Unsaved draft changes"
                  : model.draft
                    ? `Draft v${model.draft.draftVersion} saved`
                    : `Base v${model.currentBase.baseVersion} published`}
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
                return (
                  <button
                    aria-label={`${definition.displayName}, ${placement.columnSpan} columns by ${placement.rowSpan} rows, column ${placement.column}, row ${placement.row}`}
                    aria-pressed={selectedNow}
                    className="surface-editor-widget"
                    data-selected={selectedNow ? "true" : "false"}
                    key={placement.instanceId}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      dispatch({ instanceId: placement.instanceId, type: "select" });
                    }}
                    onKeyDown={(event) => {
                      if (!authoring) return;
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
                                  event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0,
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
                                  event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0,
                                type: "move",
                              },
                        );
                      }
                    }}
                    onPointerCancel={cancelDrag}
                    onPointerDown={(event) =>
                      beginDrag(event, placement.instanceId, layout.columnCount)
                    }
                    onPointerUp={finishDrag}
                    style={placementStyle(placement)}
                    tabIndex={phoneViewport ? -1 : 0}
                    type="button"
                  >
                    <span className="surface-editor-widget-handle">
                      <Grip aria-hidden="true" size={15} />
                    </span>
                    <span
                      aria-hidden="true"
                      className="surface-editor-widget-resize-handle"
                      data-resize-handle="true"
                    />
                    <strong>{definition.displayName}</strong>
                    <small>{definition.widgetKind.replace("_", " ")}</small>
                  </button>
                );
              })}
            </div>
          </div>
          {state.issue || state.announcement ? (
            <p
              aria-live="polite"
              className="surface-editor-local-status"
              data-status={state.issue ? "error" : "update"}
            >
              {state.issue ?? state.announcement}
            </p>
          ) : null}
          <p className="surface-editor-phone-note">
            Tenant Base authoring is desktop-only in V1. Tablet and phone previews are read-only.
          </p>
        </div>
      </div>
    </section>
  );
}
