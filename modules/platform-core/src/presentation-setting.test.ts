import { describe, expect, it } from "vitest";
import {
  type PresentationSettingCandidate,
  PresentationSettingResolutionError,
  resolvePresentationSetting,
} from "./presentation-setting.js";

function candidate(
  scope: PresentationSettingCandidate["scope"],
  value: unknown,
  rowVersion = 1,
): PresentationSettingCandidate {
  return { definitionVersion: 1, rowVersion, scope, value };
}

describe("typed presentation setting resolver", () => {
  it("uses the exact total order and safely diagnoses an invalid persisted candidate", () => {
    expect(
      resolvePresentationSetting("appearance.palette.v1", [
        candidate("tenant_global", "dark"),
        candidate("user_global", "light"),
      ]),
    ).toMatchObject({
      diagnostics: [],
      locked: false,
      sourceScope: "user_global",
      value: "light",
    });

    expect(
      resolvePresentationSetting("appearance.palette.v1", [
        candidate("tenant_global", "dark"),
        candidate("user_global", "system"),
      ]),
    ).toMatchObject({
      diagnostics: [{ code: "invalid_candidate_fallback", scope: "user_global" }],
      sourceScope: "product_default",
      value: "light",
    });
  });

  it("applies accessibility, motion, presence and tenant-lock floors after candidates", () => {
    expect(
      resolvePresentationSetting("appearance.high_contrast.v1", [candidate("user_global", false)], {
        requireHighContrast: true,
      }),
    ).toMatchObject({
      lockReason: "accessibility_high_contrast_floor",
      locked: true,
      value: true,
    });
    expect(
      resolvePresentationSetting(
        "appearance.reduced_motion.v1",
        [candidate("user_global", "auto")],
        { requireReducedMotion: true },
      ),
    ).toMatchObject({
      lockReason: "motion_reduction_floor",
      locked: true,
      value: "reduce",
    });
    expect(
      resolvePresentationSetting("team.rail_open.v1", [candidate("user_global", true)], {
        presenceCapability: false,
      }),
    ).toMatchObject({
      lockReason: "presence_capability_absent",
      locked: true,
      value: false,
    });
    expect(
      resolvePresentationSetting("appearance.density.v1", [candidate("user_global", "compact")], {
        tenantLock: { reason: "tenant_density_lock", value: "comfortable" },
      }),
    ).toMatchObject({
      lockReason: "tenant_density_lock",
      locked: true,
      value: "comfortable",
    });
    expect(
      resolvePresentationSetting("surface.personalization_enabled.v1", [
        candidate("tenant_surface", false),
      ]),
    ).toMatchObject({
      lockReason: "tenant_personalization_disabled",
      locked: true,
      value: false,
    });
    expect(
      resolvePresentationSetting(
        "surface.personalization_enabled.v1",
        [candidate("tenant_surface", "invalid")],
        { tenantLock: { reason: "tenant_preview_lock", value: true } },
      ),
    ).toMatchObject({
      lockReason: "invalid_personalization_candidate",
      locked: true,
      value: false,
    });
    expect(
      resolvePresentationSetting("surface.personalization_enabled.v1", [
        candidate("tenant_surface", false),
        candidate("session_preview", true, 0),
      ]),
    ).toMatchObject({
      lockReason: "tenant_personalization_disabled",
      locked: true,
      sourceScope: "session_preview",
      value: false,
    });
  });

  it("applies an ordered user patch, mandatory positions and eligibility filtering", () => {
    expect(
      resolvePresentationSetting(
        "navigation.universal_shortcuts.v1",
        [
          candidate("tenant_global", ["leave", "tasks", "forbidden"]),
          candidate("user_global", {
            operations: [
              { anchorId: "leave", id: "tasks", operation: "move_before" },
              { anchorId: "leave", id: "profile", operation: "insert_after" },
            ],
          }),
        ],
        {
          authorizedIds: ["leave", "tasks", "profile", "mandatory"],
          mandatoryItems: [{ id: "mandatory", position: "start" }],
          registeredIds: ["leave", "tasks", "profile", "mandatory"],
        },
      ),
    ).toMatchObject({
      lockReason: "tenant_ordered_set_constraints",
      locked: true,
      sourceScope: "user_global",
      tombstones: ["forbidden"],
      value: ["mandatory", "tasks", "leave", "profile"],
    });
  });

  it("omits a malformed target without discarding valid tenant-base entries", () => {
    const result = resolvePresentationSetting(
      "navigation.universal_shortcuts.v1",
      [candidate("tenant_global", ["leave", "bad id", "tasks"])],
      {
        authorizedIds: ["leave", "tasks"],
        registeredIds: ["leave", "tasks"],
      },
    );
    expect(result).toMatchObject({
      diagnostics: [{ code: "restricted_id_omitted" }],
      sourceScope: "tenant_global",
      tombstones: [],
      value: ["leave", "tasks"],
    });
    expect(JSON.stringify(result)).not.toContain("bad id");
  });

  it("uses exact definition fields as the contextual default and never renders restricted fields", () => {
    const result = resolvePresentationSetting(
      "widget.presentation.visible_fields.v1",
      [
        candidate("tenant_widget_definition", ["name", "status", "private_note"]),
        candidate("user_widget_instance", {
          operations: [{ id: "status", operation: "remove" }],
        }),
      ],
      {
        authorizedIds: ["name", "status"],
        contextDefaultIds: ["name", "status"],
        mandatoryItems: [{ id: "private_note", position: "end" }],
        registeredIds: ["name", "status", "private_note"],
      },
    );
    expect(result).toMatchObject({
      diagnostics: expect.arrayContaining([{ code: "restricted_id_omitted" }]),
      sourceScope: "user_widget_instance",
      tombstones: [],
      value: ["name"],
    });
    expect(JSON.stringify(result)).not.toContain("private_note");
  });

  it("reports Product default as the base beneath an ordered user patch", () => {
    const result = resolvePresentationSetting(
      "navigation.universal_shortcuts.v1",
      [candidate("user_global", { operations: [] })],
      { authorizedIds: ["leave"], registeredIds: ["leave"] },
    );
    expect(result).toMatchObject({
      sourceChain: [
        { applied: true, rowVersion: 1, scope: "user_global" },
        { applied: true, rowVersion: 0, scope: "product_default" },
      ],
      sourceScope: "user_global",
      value: [],
    });
  });

  it("resolves widget-definition enum catalogs, safe fallbacks and tenant locks", () => {
    expect(
      resolvePresentationSetting(
        "widget.presentation.density.v1",
        [candidate("user_widget_instance", "compact")],
        { supportedEnumValues: ["compact"] },
      ),
    ).toMatchObject({
      diagnostics: [],
      sourceScope: "user_widget_instance",
      value: "compact",
    });
    expect(
      resolvePresentationSetting(
        "widget.presentation.density.v1",
        [candidate("user_widget_instance", "comfortable")],
        { supportedEnumValues: ["compact"] },
      ),
    ).toMatchObject({
      diagnostics: [{ code: "invalid_candidate_fallback", scope: "user_widget_instance" }],
      sourceScope: "product_default",
      value: "definition_default",
    });
    expect(
      resolvePresentationSetting(
        "widget.presentation.density.v1",
        [candidate("user_widget_instance", "comfortable")],
        {
          supportedEnumValues: ["comfortable", "compact"],
          tenantLock: { reason: "tenant_widget_density_lock", value: "compact" },
        },
      ),
    ).toMatchObject({
      lockReason: "tenant_widget_density_lock",
      locked: true,
      value: "compact",
    });
    expect(
      resolvePresentationSetting(
        "widget.presentation.grouping.v1",
        [candidate("user_widget_instance", "department")],
        { supportedEnumValues: ["department"] },
      ),
    ).toMatchObject({
      diagnostics: [],
      sourceScope: "user_widget_instance",
      value: "department",
    });
    expect(
      resolvePresentationSetting(
        "widget.presentation.grouping.v1",
        [candidate("user_widget_instance", "team")],
        { supportedEnumValues: ["department"] },
      ),
    ).toMatchObject({
      diagnostics: [{ code: "invalid_candidate_fallback", scope: "user_widget_instance" }],
      sourceScope: "product_default",
      value: "definition_default",
    });
    expect(
      resolvePresentationSetting("widget.presentation.grouping.v1", [], {
        supportedEnumValues: ["department"],
        tenantLock: { reason: "tenant_widget_grouping_lock", value: "department" },
      }),
    ).toMatchObject({
      lockReason: "tenant_widget_grouping_lock",
      locked: true,
      value: "department",
    });
  });

  it("isolates contextual shortcut selection to the most specific service and surface scopes", () => {
    expect(
      resolvePresentationSetting(
        "navigation.contextual_shortcuts.v1",
        [
          candidate("tenant_service", ["service", "common"]),
          candidate("tenant_surface", ["surface", "common"]),
          candidate("user_service", {
            operations: [{ id: "common", operation: "remove" }],
          }),
          candidate("user_surface", {
            operations: [{ anchorId: "surface", id: "common", operation: "move_before" }],
          }),
        ],
        {
          authorizedIds: ["service", "surface", "common"],
          registeredIds: ["service", "surface", "common"],
        },
      ),
    ).toMatchObject({
      sourceChain: [
        { applied: true, scope: "user_surface" },
        { applied: false, scope: "user_service" },
        { applied: true, scope: "tenant_surface" },
        { applied: false, scope: "tenant_service" },
        { applied: false, scope: "product_default" },
      ],
      sourceScope: "user_surface",
      value: ["common", "surface"],
    });
  });

  it("canonicalizes ordered-set diagnostics independently of candidate input order", () => {
    const user = {
      ...candidate("user_global", { operations: [] }),
      definitionVersion: 2,
    };
    const tenant = {
      ...candidate("tenant_global", ["leave"]),
      definitionVersion: 2,
    };
    const environment = {
      authorizedIds: ["leave"],
      registeredIds: ["leave"],
    };
    const canonical = resolvePresentationSetting(
      "navigation.universal_shortcuts.v1",
      [user, tenant],
      environment,
    );
    expect(
      resolvePresentationSetting("navigation.universal_shortcuts.v1", [tenant, user], environment),
    ).toEqual(canonical);
    expect(canonical.diagnostics).toEqual([
      { code: "unsupported_definition_version", scope: "user_global" },
      { code: "unsupported_definition_version", scope: "tenant_global" },
    ]);
  });

  it("rejects unsupported scopes before conflicts independently of candidate input order", () => {
    const duplicateDark = candidate("tenant_global", "dark");
    const duplicateLight = candidate("tenant_global", "light");
    const unsupported = candidate("tenant_surface", "dark");
    for (const candidates of [
      [duplicateDark, duplicateLight, unsupported],
      [unsupported, duplicateDark, duplicateLight],
    ]) {
      expect(() => resolvePresentationSetting("appearance.palette.v1", candidates)).toThrowError(
        expect.objectContaining<Partial<PresentationSettingResolutionError>>({
          code: "unsupported_scope",
        }),
      );
    }
  });

  it("fails closed on unsupported scopes, conflicting candidates and invalid patches", () => {
    for (const run of [
      () =>
        resolvePresentationSetting("appearance.palette.v1", [candidate("tenant_surface", "dark")]),
      () =>
        resolvePresentationSetting("appearance.palette.v1", [
          candidate("user_global", "dark", 1),
          candidate("user_global", "light", 2),
        ]),
      () =>
        resolvePresentationSetting("navigation.universal_shortcuts.v1", [
          candidate("user_global", {
            operations: [{ anchorId: "missing", id: "profile", operation: "insert_after" }],
          }),
        ]),
    ]) {
      expect(run).toThrow(PresentationSettingResolutionError);
    }
  });

  it("validates environmental floors and exact identifier sets before resolution", () => {
    for (const run of [
      () =>
        resolvePresentationSetting("appearance.palette.v1", [], {
          registeredIds: ["leave"],
        }),
      () =>
        resolvePresentationSetting("navigation.universal_shortcuts.v1", [], {
          registeredIds: ["leave", "leave"],
        }),
      () => resolvePresentationSetting("navigation.universal_shortcuts.v1", []),
      () =>
        resolvePresentationSetting("appearance.high_contrast.v1", [], {
          tenantLock: { reason: "invalid lock reason", value: true },
        }),
      () =>
        resolvePresentationSetting("appearance.high_contrast.v1", [], {
          tenantLock: { reason: "tenant_floor", value: false },
        }),
      () =>
        resolvePresentationSetting("appearance.reduced_motion.v1", [], {
          tenantLock: { reason: "tenant_floor", value: "auto" },
        }),
      () =>
        resolvePresentationSetting("team.rail_open.v1", [], {
          presenceCapability: true,
          tenantLock: { reason: "tenant_floor", value: true },
        }),
      () => resolvePresentationSetting("widget.presentation.density.v1", []),
    ]) {
      expect(run).toThrowError(
        expect.objectContaining<Partial<PresentationSettingResolutionError>>({
          code: "invalid_constraint",
        }),
      );
    }
  });

  it("keeps session preview subordinate to accessibility floors", () => {
    expect(
      resolvePresentationSetting(
        "appearance.high_contrast.v1",
        [candidate("tenant_global", false), candidate("session_preview", false, 0)],
        { requireHighContrast: true },
      ),
    ).toMatchObject({
      lockReason: "accessibility_high_contrast_floor",
      locked: true,
      sourceScope: "session_preview",
      value: true,
    });
  });

  it("caps ordered values without removing mandatory identifiers", () => {
    const registeredIds = Array.from({ length: 24 }, (_, index) => `target-${index + 1}`);
    expect(
      resolvePresentationSetting(
        "navigation.universal_shortcuts.v1",
        [candidate("tenant_global", registeredIds.slice(0, 20))],
        {
          authorizedIds: registeredIds,
          mandatoryItems: [
            { id: "target-21", position: "end" },
            { id: "target-22", position: "end" },
          ],
          registeredIds,
        },
      ),
    ).toMatchObject({
      diagnostics: expect.arrayContaining([{ code: "ordered_set_capped" }]),
      locked: true,
      value: expect.arrayContaining(["target-21", "target-22"]),
    });
    const result = resolvePresentationSetting(
      "navigation.universal_shortcuts.v1",
      [candidate("tenant_global", registeredIds.slice(0, 20))],
      {
        authorizedIds: registeredIds,
        mandatoryItems: [
          { id: "target-21", position: "end" },
          { id: "target-22", position: "end" },
        ],
        registeredIds,
      },
    );
    expect(result.value).toHaveLength(20);
  });

  it("uses exact ordered-set priority, supports reset, and does not invent a field cap", () => {
    const fields = Array.from({ length: 25 }, (_, index) => `field-${index + 1}`);
    const tenantDefinition = candidate("tenant_widget_definition", fields);
    const tenantInstance = candidate("tenant_widget_instance", [...fields].reverse());
    const environment = {
      authorizedIds: fields,
      contextDefaultIds: fields,
      registeredIds: fields,
    };

    expect(
      resolvePresentationSetting(
        "widget.presentation.visible_fields.v1",
        [tenantDefinition, tenantInstance],
        environment,
      ),
    ).toMatchObject({
      sourceScope: "tenant_widget_instance",
      value: [...fields].reverse(),
    });
    expect(
      resolvePresentationSetting(
        "widget.presentation.visible_fields.v1",
        [tenantDefinition, tenantInstance, candidate("user_widget_instance", { operations: [] })],
        environment,
      ),
    ).toMatchObject({
      sourceScope: "user_widget_instance",
      value: [...fields].reverse(),
    });
    expect(
      resolvePresentationSetting(
        "widget.presentation.visible_fields.v1",
        [tenantDefinition, tenantInstance],
        environment,
      ).value,
    ).toHaveLength(25);
  });

  it("does not invent an operation cap for uncapped definition fields", () => {
    const fields = Array.from({ length: 101 }, (_, index) => `field-${index + 1}`);
    expect(
      resolvePresentationSetting(
        "widget.presentation.visible_fields.v1",
        [
          candidate("user_widget_instance", {
            operations: fields.map((id) => ({ id, operation: "remove" })),
          }),
        ],
        {
          authorizedIds: fields,
          contextDefaultIds: fields,
          registeredIds: fields,
        },
      ),
    ).toMatchObject({
      sourceScope: "user_widget_instance",
      value: [],
    });
  });
});
