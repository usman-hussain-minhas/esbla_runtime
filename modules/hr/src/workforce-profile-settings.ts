import type { SettingDefinition } from "@esbla/platform-core";

export const hrWorkforceProfileSettings = {
  employeeNumberRequired: {
    allowTenantOverride: true,
    defaultValue: false,
    key: "hr.workforce_profile.employee_number_required",
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>,
  managerVisibility: {
    allowTenantOverride: true,
    defaultValue: "minimized",
    key: "hr.workforce_profile.manager_visibility",
    validate: (value) => value === "minimized" || value === "none",
    valueType: "enum",
  } satisfies SettingDefinition<string>,
  unlinkedWorkerCreationAllowed: {
    allowTenantOverride: true,
    defaultValue: true,
    key: "hr.workforce_profile.unlinked_worker_creation_allowed",
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>,
} as const;
