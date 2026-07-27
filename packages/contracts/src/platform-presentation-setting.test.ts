import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizePresentationSettingDefinition,
  getPresentationSettingDefinition,
  PRESENTATION_SETTING_DEFINITIONS,
  presentationSettingKeys,
} from "./platform-presentation-setting.js";

describe("presentation setting definition registry", () => {
  it("contains the exact eleven V1 definitions with sealed canonical hashes", () => {
    expect(presentationSettingKeys).toEqual([
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
    ]);
    expect(PRESENTATION_SETTING_DEFINITIONS.map(({ key }) => key)).toEqual(presentationSettingKeys);
    expect(new Set(presentationSettingKeys).size).toBe(11);

    for (const definition of PRESENTATION_SETTING_DEFINITIONS) {
      const { canonicalHash, ...manifest } = definition;
      expect(canonicalHash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        createHash("sha256")
          .update(canonicalizePresentationSettingDefinition(manifest))
          .digest("hex"),
      ).toBe(canonicalHash);
      expect(definition.billingState).toBe("non_billable");
      expect(definition.evidence.required).toBe(true);
      expect(definition.declarativeMigrationId).toMatch(
        /^presentation-setting\.[a-z0-9.-]+\.initial$/,
      );
    }
  });

  it("binds each key to its exact candidate scopes and merge strategy", () => {
    expect(
      Object.fromEntries(
        PRESENTATION_SETTING_DEFINITIONS.map(({ key, mergeStrategy, permittedScopes }) => [
          key,
          { mergeStrategy, permittedScopes },
        ]),
      ),
    ).toEqual({
      "appearance.density.v1": {
        mergeStrategy: "replace",
        permittedScopes: ["tenant_global", "user_global"],
      },
      "appearance.high_contrast.v1": {
        mergeStrategy: "replace",
        permittedScopes: ["tenant_global", "user_global"],
      },
      "appearance.palette.v1": {
        mergeStrategy: "replace",
        permittedScopes: ["tenant_global", "user_global"],
      },
      "appearance.reduced_motion.v1": {
        mergeStrategy: "replace",
        permittedScopes: ["tenant_global", "user_global"],
      },
      "navigation.contextual_shortcuts.v1": {
        mergeStrategy: "ordered_set",
        permittedScopes: ["tenant_service", "tenant_surface", "user_service", "user_surface"],
      },
      "navigation.universal_shortcuts.v1": {
        mergeStrategy: "ordered_set",
        permittedScopes: ["tenant_global", "user_global"],
      },
      "surface.personalization_enabled.v1": {
        mergeStrategy: "replace",
        permittedScopes: ["tenant_surface"],
      },
      "team.rail_open.v1": {
        mergeStrategy: "replace",
        permittedScopes: ["tenant_global", "user_global"],
      },
      "widget.presentation.density.v1": {
        mergeStrategy: "replace",
        permittedScopes: [
          "tenant_widget_definition",
          "tenant_widget_instance",
          "user_widget_instance",
        ],
      },
      "widget.presentation.grouping.v1": {
        mergeStrategy: "replace",
        permittedScopes: [
          "tenant_widget_definition",
          "tenant_widget_instance",
          "user_widget_instance",
        ],
      },
      "widget.presentation.visible_fields.v1": {
        mergeStrategy: "ordered_set",
        permittedScopes: [
          "tenant_widget_definition",
          "tenant_widget_instance",
          "user_widget_instance",
        ],
      },
    });
  });

  it("matches the ratified domain, value-source, constraint and fallback profiles", () => {
    expect(
      Object.fromEntries(
        PRESENTATION_SETTING_DEFINITIONS.map(
          ({
            allowedValuesSource,
            constraintPolicyId,
            domain,
            key,
            validationErrorProfileId,
            valueContract,
          }) => [
            key,
            {
              allowedValuesSource,
              constraintPolicyId,
              domain,
              fallbackProfile: validationErrorProfileId,
              maximumItems:
                valueContract.kind === "ordered_id_set" ? valueContract.maximumItems : null,
            },
          ],
        ),
      ),
    ).toEqual({
      "appearance.density.v1": {
        allowedValuesSource: "literal",
        constraintPolicyId: "tenant_value_lock",
        domain: "appearance",
        fallbackProfile: "comfortable_with_diagnostic",
        maximumItems: null,
      },
      "appearance.high_contrast.v1": {
        allowedValuesSource: "none",
        constraintPolicyId: "force_true_accessibility_floor",
        domain: "accessibility",
        fallbackProfile: "false_unless_floor_true",
        maximumItems: null,
      },
      "appearance.palette.v1": {
        allowedValuesSource: "literal",
        constraintPolicyId: "tenant_default_user_override",
        domain: "appearance",
        fallbackProfile: "light_with_diagnostic",
        maximumItems: null,
      },
      "appearance.reduced_motion.v1": {
        allowedValuesSource: "literal",
        constraintPolicyId: "required_reduction_floor",
        domain: "accessibility",
        fallbackProfile: "auto_with_diagnostic",
        maximumItems: null,
      },
      "navigation.contextual_shortcuts.v1": {
        allowedValuesSource: "contextual_internal_target_catalog",
        constraintPolicyId: "exact_context_registered_internal",
        domain: "navigation",
        fallbackProfile: "reject_context_and_tombstone_stale",
        maximumItems: 20,
      },
      "navigation.universal_shortcuts.v1": {
        allowedValuesSource: "registered_internal_target_catalog",
        constraintPolicyId: "registered_internal_mandatory_forbidden",
        domain: "navigation",
        fallbackProfile: "omit_invalid_with_tombstone",
        maximumItems: 20,
      },
      "surface.personalization_enabled.v1": {
        allowedValuesSource: "none",
        constraintPolicyId: "tenant_surface_personalization_gate",
        domain: "layout",
        fallbackProfile: "disable_editing_with_diagnostic",
        maximumItems: null,
      },
      "team.rail_open.v1": {
        allowedValuesSource: "none",
        constraintPolicyId: "presence_required_tenant_force_false",
        domain: "team",
        fallbackProfile: "false_without_presence",
        maximumItems: null,
      },
      "widget.presentation.density.v1": {
        allowedValuesSource: "literal_plus_widget_definition_filter",
        constraintPolicyId: "definition_allowlist_tenant_lock",
        domain: "widget_presentation",
        fallbackProfile: "definition_default_with_diagnostic",
        maximumItems: null,
      },
      "widget.presentation.grouping.v1": {
        allowedValuesSource: "widget_definition_grouping_catalog",
        constraintPolicyId: "definition_allowlist_tenant_lock",
        domain: "widget_presentation",
        fallbackProfile: "definition_default_with_diagnostic",
        maximumItems: null,
      },
      "widget.presentation.visible_fields.v1": {
        allowedValuesSource: "widget_definition_field_catalog",
        constraintPolicyId: "privacy_floor_mandatory_forbidden_fields",
        domain: "widget_presentation",
        fallbackProfile: "reject_unknown_or_restricted",
        maximumItems: null,
      },
    });
  });

  it("returns only registered immutable definitions", () => {
    expect(getPresentationSettingDefinition("appearance.palette.v1")).toMatchObject({
      constraintPolicyId: "tenant_default_user_override",
      defaultValue: { kind: "literal", value: "light" },
      domain: "appearance",
      lockable: false,
      valueContract: { kind: "enum", values: ["light", "dark"] },
      version: 1,
    });
    expect(
      getPresentationSettingDefinition("navigation.universal_shortcuts.v1").valueContract,
    ).toEqual({
      kind: "ordered_id_set",
      maximumItems: 20,
      tenantCandidateEncoding: "ordered_ids",
      userCandidateEncoding: "ordered_patch",
    });
    expect(() => getPresentationSettingDefinition("appearance.unknown.v1")).toThrow(
      "Unknown presentation setting",
    );
  });
});
