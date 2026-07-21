import type { SettingDefinition } from "@esbla/platform-core";

export const workforceProfileSettings = Object.freeze({
  employeeNumberRequired: Object.freeze({
    allowTenantOverride: true,
    defaultValue: false,
    key: "hr.workforce_profile.employee_number_required",
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>),
  unlinkedWorkerCreationAllowed: Object.freeze({
    allowTenantOverride: true,
    defaultValue: true,
    key: "hr.workforce_profile.unlinked_worker_creation_allowed",
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>),
});
