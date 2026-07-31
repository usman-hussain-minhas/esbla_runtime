import type {
  PresentationSurfaceBaseMutationResponse,
  PresentationSurfaceBaseWorkspace,
  UpsertPresentationSurfaceDraftResponse,
} from "@esbla/contracts";
import { describe, expect, it } from "vitest";
import {
  applyTenantSurfaceBaseMutation,
  applyTenantSurfaceDraftSave,
  createTenantSurfaceEditorModel,
  loseTenantSurfaceAction,
} from "./tenant-surface-editor-core";

const firstPlacement = {
  column: 1,
  columnSpan: 4,
  instanceId: "mission-control.my-work",
  row: 1,
  rowSpan: 3,
  widgetDefinitionId: "workspace.my-work",
  widgetDefinitionVersion: 1,
} as const;

const secondPlacement = { ...firstPlacement, row: 4 };

const currentBase = {
  basedOnVersion: null,
  baseVersion: 1,
  definitionHash: "a".repeat(64),
  placements: [firstPlacement],
  surfaceId: "surface.mission-control",
} as const;

const workspace: PresentationSurfaceBaseWorkspace = {
  actions: {
    canDraft: true,
    canPublish: true,
    canRollback: true,
    canValidate: true,
  },
  currentBase,
  draft: null,
  headRowVersion: 0,
  history: [currentBase],
};

describe("tenant surface editor lifecycle model", () => {
  it("keeps each current authority independent", () => {
    const model = createTenantSurfaceEditorModel(workspace);
    expect(loseTenantSurfaceAction(model, "publish").actions).toEqual({
      canDraft: true,
      canPublish: false,
      canRollback: true,
      canValidate: true,
    });
  });

  it("records a saved draft without advancing the published base", () => {
    const model = createTenantSurfaceEditorModel(workspace);
    const response: UpsertPresentationSurfaceDraftResponse = {
      billingState: "non_billable",
      draft: {
        basedOnVersion: 1,
        candidateBaseVersion: 2,
        definitionHash: "a".repeat(64),
        draftVersion: 1,
        placements: [secondPlacement],
        surfaceId: "surface.mission-control",
      },
      evidenceEventId: "00000000-0000-4000-8000-000000000001",
      headRowVersion: 1,
      replayed: false,
    };
    const saved = applyTenantSurfaceDraftSave(model, response);
    expect(saved.currentBase).toEqual(currentBase);
    expect(saved.history).toEqual([currentBase]);
    expect(saved.draft).toEqual(response.draft);
    expect(saved.headRowVersion).toBe(1);
    expect(saved.lastEvidenceEventId).toBe(response.evidenceEventId);
  });

  it("prepends a published or rollback version without deleting history", () => {
    const model = createTenantSurfaceEditorModel(workspace);
    const response: PresentationSurfaceBaseMutationResponse = {
      basedOnVersion: 1,
      baseVersion: 2,
      billingState: "non_billable",
      definitionHash: "a".repeat(64),
      evidenceEventId: "00000000-0000-4000-8000-000000000002",
      headRowVersion: 1,
      placements: [secondPlacement],
      replayed: false,
      surfaceId: "surface.mission-control",
    };
    const published = applyTenantSurfaceBaseMutation(model, response);
    expect(published.currentBase.baseVersion).toBe(2);
    expect(published.draft).toBeNull();
    expect(published.headRowVersion).toBe(1);
    expect(published.history.map(({ baseVersion }) => baseVersion)).toEqual([2, 1]);
    expect(published.lastEvidenceEventId).toBe(response.evidenceEventId);
  });
});
