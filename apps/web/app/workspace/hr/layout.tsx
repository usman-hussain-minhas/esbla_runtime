import { PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS, type ZenV1SurfaceId } from "@esbla/contracts";
import type { ReactNode } from "react";
import { loadOwnPresentationPersonalSurfaceEditorWorkspace } from "../../../lib/presentation-surfaces";
import { getZenSurfaceEditDescriptor } from "../../../lib/zen-surface-edit-core";
import { WorkspaceShell } from "../../workspace-shell";

export const dynamic = "force-dynamic";

export default async function HrLayout({ children }: Readonly<{ children: ReactNode }>) {
  const surfaceIds = PRESENTATION_SEMANTIC_SURFACE_DEFINITIONS.filter(
    ({ serviceGroupId }) => serviceGroupId === "hr",
  ).map(({ surfaceId }) => surfaceId as ZenV1SurfaceId);
  const editorWorkspaces = await Promise.all(
    surfaceIds.map((surfaceId) =>
      loadOwnPresentationPersonalSurfaceEditorWorkspace(surfaceId).catch(() => undefined),
    ),
  );
  const editSurfaces = surfaceIds
    .filter((_, index) => editorWorkspaces[index]?.editable)
    .map(getZenSurfaceEditDescriptor);
  return (
    <WorkspaceShell
      currentSurface="surface.hr.mission-control"
      editSurfaces={editSurfaces}
      shortcutContext={{ contextServiceGroupId: "hr" }}
    >
      {children}
    </WorkspaceShell>
  );
}
