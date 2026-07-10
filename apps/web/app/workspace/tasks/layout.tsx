import type { ReactNode } from "react";
import { WorkspaceShell } from "../../workspace-shell";

export default function WorkspaceTasksLayout({ children }: { readonly children: ReactNode }) {
  return <WorkspaceShell currentSurface="Tasks">{children}</WorkspaceShell>;
}
