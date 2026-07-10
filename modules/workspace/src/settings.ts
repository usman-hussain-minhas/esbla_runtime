import type { SettingDefinition } from "@esbla/platform-core";

export const workspaceTaskSettings = {
  completionNoteRequired: {
    allowTenantOverride: true,
    defaultValue: false,
    key: "workspace.task.completion_note_required",
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>,
} as const;
