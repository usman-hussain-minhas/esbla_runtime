import type { ReactNode } from "react";
import { WorkspaceShell } from "../../workspace-shell";

export const dynamic = "force-dynamic";

export default function MyWorkLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <WorkspaceShell currentSurface="My Work" statusLabel="Work">
      {children}
    </WorkspaceShell>
  );
}
