import type { ReactNode } from "react";
import { WorkspaceShell } from "../../../workspace-shell";

export const dynamic = "force-dynamic";

export default function HrLeaveLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <WorkspaceShell currentSurface="HR">{children}</WorkspaceShell>;
}
