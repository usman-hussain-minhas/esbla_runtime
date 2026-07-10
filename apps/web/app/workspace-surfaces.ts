export type WorkspaceSurfaceKey = "HR" | "My Work" | "Tasks";
export type WorkspaceSurfaceIcon = "briefcase" | "inbox" | "tasks";

export interface WorkspaceSurfaceRegistration {
  readonly href: string;
  readonly icon: WorkspaceSurfaceIcon;
  readonly key: WorkspaceSurfaceKey;
  readonly label: WorkspaceSurfaceKey;
  readonly statusLabel: string;
}

export const WORKSPACE_SURFACES = [
  {
    href: "/workspace/my-work",
    icon: "inbox",
    key: "My Work",
    label: "My Work",
    statusLabel: "Work",
  },
  {
    href: "/workspace/tasks",
    icon: "tasks",
    key: "Tasks",
    label: "Tasks",
    statusLabel: "Tasks",
  },
  {
    href: "/workspace/hr/leave",
    icon: "briefcase",
    key: "HR",
    label: "HR",
    statusLabel: "HR",
  },
] as const satisfies readonly WorkspaceSurfaceRegistration[];

export function getWorkspaceSurface(key: WorkspaceSurfaceKey): WorkspaceSurfaceRegistration {
  return WORKSPACE_SURFACES.find((surface) => surface.key === key) ?? WORKSPACE_SURFACES[0];
}
