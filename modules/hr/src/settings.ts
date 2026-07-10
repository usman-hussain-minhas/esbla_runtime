import type { SettingDefinition } from "@esbla/platform-core";

export const hrLeaveSettings = {
  allowSelfApproval: {
    allowTenantOverride: false,
    defaultValue: false,
    key: "hr.leave.allow_self_approval",
    policyFloor: { kind: "locked", value: false },
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>,
  rejectNoteRequired: {
    allowTenantOverride: true,
    defaultValue: true,
    key: "hr.leave.reject_note_required",
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>,
  requestUnit: {
    allowTenantOverride: false,
    defaultValue: "whole_day",
    key: "hr.leave.request_unit",
    policyFloor: { kind: "locked", value: "whole_day" },
    validate: (value) => value === "whole_day",
    valueType: "enum",
  } satisfies SettingDefinition<string>,
  requireReason: {
    allowTenantOverride: true,
    defaultValue: false,
    key: "hr.leave.require_reason",
    valueType: "boolean",
  } satisfies SettingDefinition<boolean>,
} as const;
