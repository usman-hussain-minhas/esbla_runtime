import type { ReactNode } from "react";
import { loadOwnPresentationPersonalSurfaceEditorWorkspace } from "../../../lib/presentation-surfaces";
import { WorkspaceShell } from "../../workspace-shell";

export const dynamic = "force-dynamic";

export default async function HrLayout({ children }: Readonly<{ children: ReactNode }>) {
  const editorWorkspace = await loadOwnPresentationPersonalSurfaceEditorWorkspace(
    "surface.hr.mission-control",
  ).catch(() => undefined);
  return (
    <WorkspaceShell
      currentSurface="HR"
      editSurface={
        editorWorkspace?.editable
          ? {
              ariaLabel: "Edit HR Mission Control personal layout",
              href: "/studio/surfaces/surface.hr.mission-control/personal",
              route: "/workspace/hr",
            }
          : undefined
      }
    >
      {children}
    </WorkspaceShell>
  );
}
