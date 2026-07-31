import type {
  PresentationSurfaceBaseActions,
  PresentationSurfaceBaseMutationResponse,
  PresentationSurfaceBaseVersion,
  PresentationSurfaceBaseWorkspace,
  PresentationSurfaceDraft,
  UpsertPresentationSurfaceDraftResponse,
} from "@esbla/contracts";

export type TenantSurfaceAction = "draft" | "publish" | "rollback" | "validate";

export interface TenantSurfaceEditorModel {
  readonly actions: PresentationSurfaceBaseActions;
  readonly currentBase: PresentationSurfaceBaseVersion;
  readonly draft: PresentationSurfaceDraft | null;
  readonly headRowVersion: number;
  readonly history: readonly PresentationSurfaceBaseVersion[];
  readonly lastEvidenceEventId: string | null;
}

export function createTenantSurfaceEditorModel(
  workspace: PresentationSurfaceBaseWorkspace,
): TenantSurfaceEditorModel {
  return {
    ...workspace,
    lastEvidenceEventId: null,
  };
}

export function loseTenantSurfaceAction(
  model: TenantSurfaceEditorModel,
  action: TenantSurfaceAction,
): TenantSurfaceEditorModel {
  const actionKeys = {
    draft: "canDraft",
    publish: "canPublish",
    rollback: "canRollback",
    validate: "canValidate",
  } as const satisfies Readonly<Record<TenantSurfaceAction, keyof PresentationSurfaceBaseActions>>;
  const key = actionKeys[action];
  return {
    ...model,
    actions: { ...model.actions, [key]: false },
  };
}

export function applyTenantSurfaceDraftSave(
  model: TenantSurfaceEditorModel,
  response: UpsertPresentationSurfaceDraftResponse,
): TenantSurfaceEditorModel {
  return {
    ...model,
    draft: response.draft,
    headRowVersion: response.headRowVersion,
    lastEvidenceEventId: response.evidenceEventId,
  };
}

function baseVersion(
  response: PresentationSurfaceBaseMutationResponse,
): PresentationSurfaceBaseVersion {
  return {
    basedOnVersion: response.basedOnVersion,
    baseVersion: response.baseVersion,
    definitionHash: response.definitionHash,
    placements: response.placements,
    surfaceId: response.surfaceId,
  };
}

export function applyTenantSurfaceBaseMutation(
  model: TenantSurfaceEditorModel,
  response: PresentationSurfaceBaseMutationResponse,
): TenantSurfaceEditorModel {
  const currentBase = baseVersion(response);
  return {
    ...model,
    currentBase,
    draft: null,
    headRowVersion: response.headRowVersion,
    history: [
      currentBase,
      ...model.history.filter(({ baseVersion }) => baseVersion !== currentBase.baseVersion),
    ],
    lastEvidenceEventId: response.evidenceEventId,
  };
}
