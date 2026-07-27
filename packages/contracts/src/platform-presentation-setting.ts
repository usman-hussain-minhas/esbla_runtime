import { PRESENTATION_BILLING_STATE } from "./platform-presentation-api.js";

export const presentationSettingKeys = [
  "appearance.palette.v1",
  "appearance.high_contrast.v1",
  "appearance.reduced_motion.v1",
  "appearance.density.v1",
  "navigation.universal_shortcuts.v1",
  "navigation.contextual_shortcuts.v1",
  "team.rail_open.v1",
  "surface.personalization_enabled.v1",
  "widget.presentation.density.v1",
  "widget.presentation.visible_fields.v1",
  "widget.presentation.grouping.v1",
] as const;

export type PresentationSettingKey = (typeof presentationSettingKeys)[number];

export const presentationSettingPersistedScopes = [
  "tenant_global",
  "user_global",
  "tenant_service",
  "user_service",
  "tenant_surface",
  "user_surface",
  "tenant_widget_definition",
  "user_widget_definition",
  "tenant_widget_instance",
  "user_widget_instance",
] as const;

export type PresentationSettingPersistedScope = (typeof presentationSettingPersistedScopes)[number];

export const presentationSettingResolutionPriority = [
  "session_preview",
  "user_widget_instance",
  "user_widget_definition",
  "user_surface",
  "user_service",
  "user_global",
  "tenant_widget_instance",
  "tenant_widget_definition",
  "tenant_surface",
  "tenant_service",
  "tenant_global",
  "product_default",
] as const;

export type PresentationSettingResolutionScope =
  (typeof presentationSettingResolutionPriority)[number];

export type PresentationSettingDomain =
  | "accessibility"
  | "appearance"
  | "layout"
  | "navigation"
  | "team"
  | "widget_presentation";

export type PresentationSettingMergeStrategy = "ordered_set" | "replace";

export type PresentationSettingConstraintPolicyId =
  | "definition_allowlist_tenant_lock"
  | "exact_context_registered_internal"
  | "force_true_accessibility_floor"
  | "presence_required_tenant_force_false"
  | "privacy_floor_mandatory_forbidden_fields"
  | "registered_internal_mandatory_forbidden"
  | "required_reduction_floor"
  | "tenant_default_user_override"
  | "tenant_surface_personalization_gate"
  | "tenant_value_lock";

export type PresentationSettingValidationErrorProfileId =
  | "auto_with_diagnostic"
  | "comfortable_with_diagnostic"
  | "definition_default_with_diagnostic"
  | "disable_editing_with_diagnostic"
  | "false_unless_floor_true"
  | "false_without_presence"
  | "light_with_diagnostic"
  | "omit_invalid_with_tombstone"
  | "reject_context_and_tombstone_stale"
  | "reject_unknown_or_restricted";

export type PresentationSettingAllowedValuesSource =
  | "contextual_internal_target_catalog"
  | "literal"
  | "literal_plus_widget_definition_filter"
  | "none"
  | "registered_internal_target_catalog"
  | "widget_definition_field_catalog"
  | "widget_definition_grouping_catalog";

export interface PresentationBooleanValueContract {
  readonly kind: "boolean";
}

export interface PresentationEnumValueContract {
  readonly kind: "enum";
  readonly values: readonly string[];
}

export interface PresentationOrderedIdsValueContract {
  readonly kind: "ordered_id_set";
  readonly maximumItems: number | null;
  readonly tenantCandidateEncoding: "ordered_ids";
  readonly userCandidateEncoding: "ordered_patch";
}

export type PresentationSettingValueContract =
  | PresentationBooleanValueContract
  | PresentationEnumValueContract
  | PresentationOrderedIdsValueContract;

export type PresentationSettingLiteralValue = boolean | string | readonly string[];

export interface PresentationLiteralDefaultValue {
  readonly kind: "literal";
  readonly value: PresentationSettingLiteralValue;
}

export interface PresentationContextualDefaultValue {
  readonly contextKey: "widget_definition_fields";
  readonly kind: "contextual_ids";
}

export type PresentationSettingDefaultValue =
  | PresentationContextualDefaultValue
  | PresentationLiteralDefaultValue;

export interface PresentationSettingChangePermissions {
  readonly tenant: "platform.presentation.tenant_defaults.write" | null;
  readonly user:
    | "platform.presentation.preferences.write_own"
    | "platform.presentation.shortcuts.write_own"
    | null;
}

export interface PresentationSettingEvidenceRequirement {
  readonly required: true;
  readonly requirementId: "tenant_actor_cas_non_billable";
}

export interface PresentationSettingDefinitionManifest {
  readonly allowedValuesSource: PresentationSettingAllowedValuesSource;
  readonly allowsSessionPreview: true;
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly changePermissions: PresentationSettingChangePermissions;
  readonly constraintPolicyId: PresentationSettingConstraintPolicyId;
  readonly declarativeMigrationId: string;
  readonly defaultValue: PresentationSettingDefaultValue;
  readonly domain: PresentationSettingDomain;
  readonly evidence: PresentationSettingEvidenceRequirement;
  readonly key: PresentationSettingKey;
  readonly lockable: boolean;
  readonly mergeStrategy: PresentationSettingMergeStrategy;
  readonly permittedScopes: readonly PresentationSettingPersistedScope[];
  readonly privacyClass: "non_sensitive";
  readonly validationErrorProfileId: PresentationSettingValidationErrorProfileId;
  readonly valueContract: PresentationSettingValueContract;
  readonly version: 1;
}

export interface PresentationSettingDefinition extends PresentationSettingDefinitionManifest {
  readonly canonicalHash: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function canonicalizePresentationSettingDefinition(
  definition: PresentationSettingDefinitionManifest,
): string {
  return JSON.stringify(canonicalValue(definition));
}

function freezeDefinition(
  definition: PresentationSettingDefinition,
): PresentationSettingDefinition {
  Object.freeze(definition.permittedScopes);
  if (definition.valueContract.kind === "enum") Object.freeze(definition.valueContract.values);
  if (definition.defaultValue.kind === "literal" && Array.isArray(definition.defaultValue.value)) {
    Object.freeze(definition.defaultValue.value);
  }
  Object.freeze(definition.changePermissions);
  Object.freeze(definition.defaultValue);
  Object.freeze(definition.evidence);
  Object.freeze(definition.valueContract);
  return Object.freeze(definition);
}

const tenantAndUserPreferences = ["tenant_global", "user_global"] as const;
const tenantAndUserWidgetPresentation = [
  "tenant_widget_definition",
  "tenant_widget_instance",
  "user_widget_instance",
] as const;

export const PRESENTATION_SETTING_DEFINITIONS: readonly PresentationSettingDefinition[] =
  Object.freeze(
    [
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "8771cd0469615c3d0e610ca279f5958f37dd6c96addadd994e59fc571dab5a3b",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "literal",
        constraintPolicyId: "tenant_default_user_override",
        declarativeMigrationId: "presentation-setting.appearance.palette.v1.initial",
        defaultValue: { kind: "literal", value: "light" },
        domain: "appearance",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "appearance.palette.v1",
        lockable: false,
        mergeStrategy: "replace",
        permittedScopes: [...tenantAndUserPreferences],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "light_with_diagnostic",
        valueContract: { kind: "enum", values: ["light", "dark"] },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "67ce6618de3ed2e6f5f880dc9a014286219d5dad8f3b3b731a19b48d6e6a61bb",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "none",
        constraintPolicyId: "force_true_accessibility_floor",
        declarativeMigrationId: "presentation-setting.appearance.high-contrast.v1.initial",
        defaultValue: { kind: "literal", value: false },
        domain: "accessibility",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "appearance.high_contrast.v1",
        lockable: true,
        mergeStrategy: "replace",
        permittedScopes: [...tenantAndUserPreferences],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "false_unless_floor_true",
        valueContract: { kind: "boolean" },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "5b2867432916db51ee8c95da6df7ad4fbef95b813b055352695851a95bee915e",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "literal",
        constraintPolicyId: "required_reduction_floor",
        declarativeMigrationId: "presentation-setting.appearance.reduced-motion.v1.initial",
        defaultValue: { kind: "literal", value: "auto" },
        domain: "accessibility",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "appearance.reduced_motion.v1",
        lockable: true,
        mergeStrategy: "replace",
        permittedScopes: [...tenantAndUserPreferences],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "auto_with_diagnostic",
        valueContract: { kind: "enum", values: ["auto", "reduce"] },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "efb32a1cd9595a23003c681d313afebd9712cc0150e6894ff0c238a0b8cde1e7",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "literal",
        constraintPolicyId: "tenant_value_lock",
        declarativeMigrationId: "presentation-setting.appearance.density.v1.initial",
        defaultValue: { kind: "literal", value: "comfortable" },
        domain: "appearance",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "appearance.density.v1",
        lockable: true,
        mergeStrategy: "replace",
        permittedScopes: [...tenantAndUserPreferences],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "comfortable_with_diagnostic",
        valueContract: { kind: "enum", values: ["comfortable", "compact"] },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "cb90fc6ea1e69ebe997a62a43577123e231dc8d3ed15a31565743a514726aa53",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.shortcuts.write_own",
        },
        allowedValuesSource: "registered_internal_target_catalog",
        constraintPolicyId: "registered_internal_mandatory_forbidden",
        declarativeMigrationId: "presentation-setting.navigation.universal-shortcuts.v1.initial",
        defaultValue: { kind: "literal", value: [] },
        domain: "navigation",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "navigation.universal_shortcuts.v1",
        lockable: true,
        mergeStrategy: "ordered_set",
        permittedScopes: ["tenant_global", "user_global"],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "omit_invalid_with_tombstone",
        valueContract: {
          kind: "ordered_id_set",
          maximumItems: 20,
          tenantCandidateEncoding: "ordered_ids",
          userCandidateEncoding: "ordered_patch",
        },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "3f8ed16c3a85a726f6dfe7c103075f779c3033c14ef5a36c88c6098ccd598719",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.shortcuts.write_own",
        },
        allowedValuesSource: "contextual_internal_target_catalog",
        constraintPolicyId: "exact_context_registered_internal",
        declarativeMigrationId: "presentation-setting.navigation.contextual-shortcuts.v1.initial",
        defaultValue: { kind: "literal", value: [] },
        domain: "navigation",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "navigation.contextual_shortcuts.v1",
        lockable: true,
        mergeStrategy: "ordered_set",
        permittedScopes: ["tenant_service", "tenant_surface", "user_service", "user_surface"],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "reject_context_and_tombstone_stale",
        valueContract: {
          kind: "ordered_id_set",
          maximumItems: 20,
          tenantCandidateEncoding: "ordered_ids",
          userCandidateEncoding: "ordered_patch",
        },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "a9d20ce4afc22999f59e764c57f9d3bcf76dd1a9278bd91589bd5da7efeda99b",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "none",
        constraintPolicyId: "presence_required_tenant_force_false",
        declarativeMigrationId: "presentation-setting.team.rail-open.v1.initial",
        defaultValue: { kind: "literal", value: false },
        domain: "team",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "team.rail_open.v1",
        lockable: true,
        mergeStrategy: "replace",
        permittedScopes: [...tenantAndUserPreferences],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "false_without_presence",
        valueContract: { kind: "boolean" },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "7796d88b0fdbe6ce442542d7af88d7a36ac86c5e54d672dc3a7731db5919bb09",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: null,
        },
        allowedValuesSource: "none",
        constraintPolicyId: "tenant_surface_personalization_gate",
        declarativeMigrationId: "presentation-setting.surface.personalization-enabled.v1.initial",
        defaultValue: { kind: "literal", value: true },
        domain: "layout",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "surface.personalization_enabled.v1",
        lockable: true,
        mergeStrategy: "replace",
        permittedScopes: ["tenant_surface"],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "disable_editing_with_diagnostic",
        valueContract: { kind: "boolean" },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "a174f442475903917d228cf7d77c0ba12d277d51409ddf171474c98308c91ece",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "literal_plus_widget_definition_filter",
        constraintPolicyId: "definition_allowlist_tenant_lock",
        declarativeMigrationId: "presentation-setting.widget.presentation.density.v1.initial",
        defaultValue: { kind: "literal", value: "definition_default" },
        domain: "widget_presentation",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "widget.presentation.density.v1",
        lockable: true,
        mergeStrategy: "replace",
        permittedScopes: [...tenantAndUserWidgetPresentation],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "definition_default_with_diagnostic",
        valueContract: {
          kind: "enum",
          values: ["definition_default", "comfortable", "compact"],
        },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "d844c85b4e7ac510051e66491b8ec28b7874bee852df2195324572a8280fa602",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "widget_definition_field_catalog",
        constraintPolicyId: "privacy_floor_mandatory_forbidden_fields",
        declarativeMigrationId:
          "presentation-setting.widget.presentation.visible-fields.v1.initial",
        defaultValue: {
          contextKey: "widget_definition_fields",
          kind: "contextual_ids",
        },
        domain: "widget_presentation",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "widget.presentation.visible_fields.v1",
        lockable: true,
        mergeStrategy: "ordered_set",
        permittedScopes: [...tenantAndUserWidgetPresentation],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "reject_unknown_or_restricted",
        valueContract: {
          kind: "ordered_id_set",
          maximumItems: null,
          tenantCandidateEncoding: "ordered_ids",
          userCandidateEncoding: "ordered_patch",
        },
        version: 1,
      },
      {
        allowsSessionPreview: true,
        billingState: PRESENTATION_BILLING_STATE,
        canonicalHash: "67a553e74ef87222adcca5af55003a381f6a97e3139bc087737c358418bd322f",
        changePermissions: {
          tenant: "platform.presentation.tenant_defaults.write",
          user: "platform.presentation.preferences.write_own",
        },
        allowedValuesSource: "widget_definition_grouping_catalog",
        constraintPolicyId: "definition_allowlist_tenant_lock",
        declarativeMigrationId: "presentation-setting.widget.presentation.grouping.v1.initial",
        defaultValue: { kind: "literal", value: "definition_default" },
        domain: "widget_presentation",
        evidence: { required: true, requirementId: "tenant_actor_cas_non_billable" },
        key: "widget.presentation.grouping.v1",
        lockable: true,
        mergeStrategy: "replace",
        permittedScopes: [...tenantAndUserWidgetPresentation],
        privacyClass: "non_sensitive",
        validationErrorProfileId: "definition_default_with_diagnostic",
        valueContract: { kind: "enum", values: ["definition_default"] },
        version: 1,
      },
    ].map((definition) => freezeDefinition(definition as PresentationSettingDefinition)),
  );

export function getPresentationSettingDefinition(key: string): PresentationSettingDefinition {
  const definition = PRESENTATION_SETTING_DEFINITIONS.find((candidate) => candidate.key === key);
  if (!definition) throw new Error("Unknown presentation setting");
  return definition;
}
