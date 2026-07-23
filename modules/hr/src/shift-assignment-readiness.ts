import { type ActivationPreflight, platformCoreManifest } from "@esbla/platform-core";
import type { PoolClient } from "pg";
import {
  HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS,
  HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS,
  HR_WORKFORCE_PROFILE_RUNTIME_TABLE_PRIVILEGES,
} from "./activation-readiness.js";
import { hrManifest } from "./manifest.js";

export type HrShiftAssignmentActivationMode = "non_production" | "production";

export const HR_SHIFT_ASSIGNMENT_REQUIRED_MIGRATIONS = [
  ...HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS,
  {
    createdAt: 1784783257523,
    hash: "ffd2e673f8bcab33194d23480660c94928781fd6b3d33f03bb33109c011c9a7c",
    id: "0015",
  },
  {
    createdAt: 1784818108090,
    hash: "dad6f17ed1f127315b711af9bdf74b01c13a99975fc6b8ada666724f6f09f9df",
    id: "0016",
  },
] as const;

const runtimeTablePrivilege = (name: string, update = false, insert = update) => ({
  delete: false,
  insert,
  name,
  references: false,
  select: true,
  trigger: false,
  truncate: false,
  update,
});

export const HR_SHIFT_ASSIGNMENT_RUNTIME_TABLE_PRIVILEGES = [
  ...HR_WORKFORCE_PROFILE_RUNTIME_TABLE_PRIVILEGES,
  runtimeTablePrivilege("public.memberships"),
  runtimeTablePrivilege("public.service_activations", true),
  runtimeTablePrivilege("public.evidence_events", false, true),
  runtimeTablePrivilege("public.outbox_events", false, true),
  runtimeTablePrivilege("public.hr_shift_assignment_service_control"),
  runtimeTablePrivilege("public.hr_shift_assignments", true),
  runtimeTablePrivilege("public.hr_shift_roster_versions", true),
] as const;

const shiftCatalogParents = [
  "hr_shift_assignment_service_control",
  "hr_shift_assignments",
  "hr_shift_roster_versions",
] as const;

export const HR_SHIFT_ASSIGNMENT_CATALOG_REQUIREMENTS = {
  exactColumnParents: shiftCatalogParents,
  exactConstraintParents: shiftCatalogParents,
  exactIndexParents: shiftCatalogParents,
  exactTriggerParents: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.exactTriggerParents,
    ...shiftCatalogParents,
  ],
  enums: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.enums,
    { labels: ["active", "cancelled"], name: "hr_shift_assignment_status" },
    { labels: ["draft", "published", "superseded"], name: "hr_shift_roster_status" },
  ],
  tables: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.tables,
    ...shiftCatalogParents.map((name) => ({ name })),
  ],
  columns: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.columns,
    ...[
      "hr_shift_assignment_service_control|service_control_id|uuid|1|gen_random_uuid()",
      "hr_shift_assignment_service_control|tenant_id|uuid|1|",
      "hr_shift_assignment_service_control|service_key|text|1|'shift_assignment'::text",
      "hr_shift_assignment_service_control|settings_version|integer|1|1",
      "hr_shift_assignment_service_control|updated_at|timestamp with time zone|1|now()",
      "hr_shift_assignment_service_control|row_version|integer|1|1",
      "hr_shift_assignments|shift_assignment_id|uuid|1|gen_random_uuid()",
      "hr_shift_assignments|tenant_id|uuid|1|",
      "hr_shift_assignments|roster_version_id|uuid|1|",
      "hr_shift_assignments|worker_profile_id|uuid|1|",
      "hr_shift_assignments|starts_at|timestamp with time zone|1|",
      "hr_shift_assignments|ends_at|timestamp with time zone|1|",
      "hr_shift_assignments|iana_timezone|text|1|",
      "hr_shift_assignments|status|public.hr_shift_assignment_status|1|'active'::public.hr_shift_assignment_status",
      "hr_shift_assignments|row_version|integer|1|1",
      "hr_shift_roster_versions|roster_version_id|uuid|1|gen_random_uuid()",
      "hr_shift_roster_versions|tenant_id|uuid|1|",
      "hr_shift_roster_versions|period_start|date|1|",
      "hr_shift_roster_versions|period_end|date|1|",
      "hr_shift_roster_versions|status|public.hr_shift_roster_status|1|'draft'::public.hr_shift_roster_status",
      "hr_shift_roster_versions|version|integer|1|",
      "hr_shift_roster_versions|supersedes_roster_version_id|uuid|0|",
      "hr_shift_roster_versions|published_at|timestamp with time zone|0|",
      "hr_shift_roster_versions|row_version|integer|1|1",
    ].map((entry) => {
      const [parent, name, type, notNull, defaultExpression] = entry.split("|");
      return { defaultExpression, name, notNull: notNull === "1", parent, type };
    }),
  ],
  indexes: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.indexes,
    ...[
      "hr_shift_assignment_service_control_pkey|hr_shift_assignment_service_control|CREATE UNIQUE INDEX hr_shift_assignment_service_control_pkey ON public.hr_shift_assignment_service_control USING btree (service_control_id)||p|1|1",
      "uq_hr_shift_assignment_service_control_tenant_key|hr_shift_assignment_service_control|CREATE UNIQUE INDEX uq_hr_shift_assignment_service_control_tenant_key ON public.hr_shift_assignment_service_control USING btree (tenant_id, service_key)|||0|1",
      "hr_shift_assignments_pkey|hr_shift_assignments|CREATE UNIQUE INDEX hr_shift_assignments_pkey ON public.hr_shift_assignments USING btree (shift_assignment_id)||p|1|1",
      "idx_hr_shift_assignments_tenant_roster_status_start|hr_shift_assignments|CREATE INDEX idx_hr_shift_assignments_tenant_roster_status_start ON public.hr_shift_assignments USING btree (tenant_id, roster_version_id, status, starts_at, shift_assignment_id)|||0|0",
      "idx_hr_shift_assignments_tenant_worker_overlap|hr_shift_assignments|CREATE INDEX idx_hr_shift_assignments_tenant_worker_overlap ON public.hr_shift_assignments USING btree (tenant_id, worker_profile_id, status, starts_at, shift_assignment_id)|||0|0",
      "idx_hr_shift_assignments_tenant_worker_start|hr_shift_assignments|CREATE INDEX idx_hr_shift_assignments_tenant_worker_start ON public.hr_shift_assignments USING btree (tenant_id, worker_profile_id, starts_at, shift_assignment_id)|||0|0",
      "uq_hr_shift_assignments_composite_identity|hr_shift_assignments|CREATE UNIQUE INDEX uq_hr_shift_assignments_composite_identity ON public.hr_shift_assignments USING btree (tenant_id, shift_assignment_id)||u|0|1",
      "hr_shift_roster_versions_pkey|hr_shift_roster_versions|CREATE UNIQUE INDEX hr_shift_roster_versions_pkey ON public.hr_shift_roster_versions USING btree (roster_version_id)||p|1|1",
      "uq_hr_shift_roster_versions_composite_identity|hr_shift_roster_versions|CREATE UNIQUE INDEX uq_hr_shift_roster_versions_composite_identity ON public.hr_shift_roster_versions USING btree (tenant_id, roster_version_id)||u|0|1",
      "uq_hr_shift_roster_versions_tenant_period_version|hr_shift_roster_versions|CREATE UNIQUE INDEX uq_hr_shift_roster_versions_tenant_period_version ON public.hr_shift_roster_versions USING btree (tenant_id, period_start, period_end, version)|||0|1",
      "uq_hr_shift_rosters_tenant_period_draft|hr_shift_roster_versions|CREATE UNIQUE INDEX uq_hr_shift_rosters_tenant_period_draft ON public.hr_shift_roster_versions USING btree (tenant_id, period_start, period_end, status) WHERE (status = 'draft'::public.hr_shift_roster_status)|(status = 'draft'::public.hr_shift_roster_status)||0|1",
      "uq_hr_shift_rosters_tenant_period_published|hr_shift_roster_versions|CREATE UNIQUE INDEX uq_hr_shift_rosters_tenant_period_published ON public.hr_shift_roster_versions USING btree (tenant_id, period_start, period_end, status) WHERE (status = 'published'::public.hr_shift_roster_status)|(status = 'published'::public.hr_shift_roster_status)||0|1",
      "uq_hr_shift_rosters_tenant_period_successor|hr_shift_roster_versions|CREATE UNIQUE INDEX uq_hr_shift_rosters_tenant_period_successor ON public.hr_shift_roster_versions USING btree (tenant_id, period_start, period_end, supersedes_roster_version_id) WHERE (supersedes_roster_version_id IS NOT NULL)|(supersedes_roster_version_id IS NOT NULL)||0|1",
    ].map((entry) => {
      const [name, parent, definition, predicate, constraintType, primary, unique] =
        entry.split("|");
      return {
        constraintType,
        definition: definition ?? "",
        name,
        parent,
        predicate,
        primary: primary === "1",
        unique: unique === "1",
      };
    }),
  ],
  policies: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.policies,
    ...[
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_tenant_isolation",
      "hr_shift_assignments|hr_shift_assignments_tenant_isolation",
      "hr_shift_roster_versions|hr_shift_roster_versions_tenant_isolation",
    ].map((entry) => {
      const [parent, name] = entry.split("|");
      return { name, parent };
    }),
  ],
  triggers: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.triggers,
    ...[
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_enforce_state|CREATE TRIGGER hr_shift_assignment_service_control_enforce_state BEFORE INSERT OR DELETE OR UPDATE ON public.hr_shift_assignment_service_control FOR EACH ROW EXECUTE FUNCTION public.esbla_enforce_hr_shift_assignment_service_control()|esbla_enforce_hr_shift_assignment_service_control",
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_reject_truncate|CREATE TRIGGER hr_shift_assignment_service_control_reject_truncate BEFORE TRUNCATE ON public.hr_shift_assignment_service_control FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_enforce_hr_shift_assignment_service_control()|esbla_enforce_hr_shift_assignment_service_control",
      "service_activations|service_activations_sync_hr_shift_assignment|CREATE TRIGGER service_activations_sync_hr_shift_assignment AFTER INSERT OR UPDATE ON public.service_activations FOR EACH ROW EXECUTE FUNCTION public.esbla_sync_hr_shift_assignment_service_activation()|esbla_sync_hr_shift_assignment_service_activation",
      "hr_shift_assignments|hr_shift_assignments_enforce_state|CREATE TRIGGER hr_shift_assignments_enforce_state BEFORE INSERT OR DELETE OR UPDATE ON public.hr_shift_assignments FOR EACH ROW EXECUTE FUNCTION public.esbla_enforce_hr_shift_assignment()|esbla_enforce_hr_shift_assignment",
      "hr_shift_assignments|hr_shift_assignments_reject_truncate|CREATE TRIGGER hr_shift_assignments_reject_truncate BEFORE TRUNCATE ON public.hr_shift_assignments FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_enforce_hr_shift_assignment()|esbla_enforce_hr_shift_assignment",
      "hr_shift_roster_versions|hr_shift_roster_versions_enforce_state|CREATE TRIGGER hr_shift_roster_versions_enforce_state BEFORE INSERT OR DELETE OR UPDATE ON public.hr_shift_roster_versions FOR EACH ROW EXECUTE FUNCTION public.esbla_enforce_hr_shift_roster_version()|esbla_enforce_hr_shift_roster_version",
      "hr_shift_roster_versions|hr_shift_roster_versions_reject_truncate|CREATE TRIGGER hr_shift_roster_versions_reject_truncate BEFORE TRUNCATE ON public.hr_shift_roster_versions FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_enforce_hr_shift_roster_version()|esbla_enforce_hr_shift_roster_version",
      "hr_shift_roster_versions|hr_shift_roster_versions_require_successor|CREATE CONSTRAINT TRIGGER hr_shift_roster_versions_require_successor AFTER UPDATE OF status ON public.hr_shift_roster_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.esbla_require_hr_shift_roster_successor()|esbla_require_hr_shift_roster_successor",
    ].map((entry) => {
      const [parent, name, definition, functionName] = entry.split("|");
      return { definition: definition ?? "", functionName, name, parent };
    }),
  ],
  constraints: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.constraints,
    ...[
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_activation_fk|f|FOREIGN KEY (tenant_id, service_key) REFERENCES public.service_activations(tenant_id, service_key) ON DELETE RESTRICT",
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_key_exact|c|CHECK (service_key = 'shift_assignment'::text)",
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_pkey|p|PRIMARY KEY (service_control_id)",
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_row_version_positive|c|CHECK (row_version > 0)",
      "hr_shift_assignment_service_control|hr_shift_assignment_service_control_settings_version_positive|c|CHECK (settings_version > 0)",
      "hr_shift_assignments|hr_shift_assignments_iana_timezone_not_blank|c|CHECK (char_length(TRIM(BOTH FROM iana_timezone)) > 0)",
      "hr_shift_assignments|hr_shift_assignments_pkey|p|PRIMARY KEY (shift_assignment_id)",
      "hr_shift_assignments|hr_shift_assignments_roster_same_tenant_fk|f|FOREIGN KEY (tenant_id, roster_version_id) REFERENCES public.hr_shift_roster_versions(tenant_id, roster_version_id) ON DELETE RESTRICT",
      "hr_shift_assignments|hr_shift_assignments_row_version_positive|c|CHECK (row_version > 0)",
      "hr_shift_assignments|hr_shift_assignments_tenant_id_tenants_tenant_id_fk|f|FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE RESTRICT",
      "hr_shift_assignments|hr_shift_assignments_time_range_valid|c|CHECK (ends_at > starts_at)",
      "hr_shift_assignments|hr_shift_assignments_worker_same_tenant_fk|f|FOREIGN KEY (tenant_id, worker_profile_id) REFERENCES public.hr_worker_profiles(tenant_id, worker_profile_id) ON DELETE RESTRICT",
      "hr_shift_assignments|uq_hr_shift_assignments_composite_identity|u|UNIQUE (tenant_id, shift_assignment_id)",
      "hr_shift_roster_versions|hr_shift_roster_versions_period_valid|c|CHECK (period_end >= period_start)",
      "hr_shift_roster_versions|hr_shift_roster_versions_pkey|p|PRIMARY KEY (roster_version_id)",
      "hr_shift_roster_versions|hr_shift_roster_versions_predecessor_same_tenant_fk|f|FOREIGN KEY (tenant_id, supersedes_roster_version_id) REFERENCES public.hr_shift_roster_versions(tenant_id, roster_version_id) ON DELETE RESTRICT",
      "hr_shift_roster_versions|hr_shift_roster_versions_publication_consistent|c|CHECK (status = 'draft'::public.hr_shift_roster_status AND published_at IS NULL AND supersedes_roster_version_id IS NULL OR (status = ANY (ARRAY['published'::public.hr_shift_roster_status, 'superseded'::public.hr_shift_roster_status])) AND published_at IS NOT NULL)",
      "hr_shift_roster_versions|hr_shift_roster_versions_row_version_positive|c|CHECK (row_version > 0)",
      "hr_shift_roster_versions|hr_shift_roster_versions_tenant_id_tenants_tenant_id_fk|f|FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE RESTRICT",
      "hr_shift_roster_versions|hr_shift_roster_versions_version_positive|c|CHECK (version > 0)",
      "hr_shift_roster_versions|uq_hr_shift_roster_versions_composite_identity|u|UNIQUE (tenant_id, roster_version_id)",
    ].map((entry) => {
      const [parent, name, type, definition] = entry.split("|");
      return { definition, name, parent, type };
    }),
  ],
  functions: [
    ...HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS.functions,
    ...[
      "esbla_enforce_hr_shift_assignment|0|39087adbae976b6c35505c0e682ecc78311304fcaf42b1e79f38bbb478ac86d5|search_path=pg_catalog",
      "esbla_enforce_hr_shift_assignment_service_control|0|c169bd930d0c0c1cf062a4394b853fdeac0cd9bf0a3ccb64ac3ce76bb612bfb7|search_path=pg_catalog",
      "esbla_enforce_hr_shift_roster_version|0|5cc8de66bd49226c537783e52188a2603586a708af903b6d1ed7b8481f25ab42|search_path=pg_catalog",
      "esbla_require_hr_shift_roster_successor|0|94496dc4299aa0a4da4f67b5ab74b9f65c9852107c69e4160a799a6ce2a5607e|search_path=pg_catalog",
      "esbla_sync_hr_shift_assignment_service_activation|1|cdc50ac9e9e5699070b27f43a1a12350caf6cb73fd1d9f915925c2bf0b53eb27|search_path=pg_catalog,row_security=on",
    ].map((entry) => {
      const [name, securityDefiner, sourceSha256, config] = entry.split("|");
      return {
        config,
        language: "plpgsql",
        name,
        ownerOnlyExecutable: true,
        publicExecutable: false,
        returnType: "trigger",
        securityDefiner: securityDefiner === "1",
        sourceSha256,
        volatility: "v",
      };
    }),
    {
      applicationExecutable: true,
      config: "search_path=pg_catalog,row_security=on",
      identityArguments: "integer, integer, boolean",
      language: "plpgsql",
      name: "esbla_configure_hr_shift_assignment_settings",
      publicExecutable: false,
      returnType: "void",
      securityDefiner: true,
      sourceSha256: "ccacbbb5e43d426338a8f6cd996f10544ebf823d136ab8354b3e19b610f4b8c5",
      volatility: "v",
    },
  ],
};

const representativeTimeZones = ["Asia/Karachi", "America/New_York"] as const;
const requiredShiftCapabilities = [
  { exposure: "admin", id: "hr.shift.activate_service" },
  { exposure: "tenant", id: "hr.shift.assign" },
  { exposure: "tenant", id: "hr.shift.cancel" },
  { exposure: "admin", id: "hr.shift.configure_service" },
  { exposure: "tenant", id: "hr.shift.create_roster" },
  { exposure: "admin", id: "hr.shift.deactivate_service" },
  { exposure: "tenant", id: "hr.shift.list_roster" },
  { exposure: "tenant", id: "hr.shift.publish" },
  { exposure: "tenant", id: "hr.shift.view_detail" },
  { exposure: "admin", id: "hr.shift.view_service_control" },
] as const;
const requiredCoreCapabilities = [
  "platform.evidence.append",
  "platform.policy.evaluate",
  "platform.tenant_transaction.run",
] as const;

function runtimeRecognizesRepresentativeTimeZones(): boolean {
  if (!process.versions.icu) return false;
  try {
    return representativeTimeZones.every(
      (timeZone) =>
        new Intl.DateTimeFormat("en", {
          dateStyle: "full",
          timeZone,
        }).resolvedOptions().timeZone === timeZone,
    );
  } catch {
    return false;
  }
}

export async function inspectShiftAssignmentEnvironment(
  client: Pick<PoolClient, "query">,
  activationMode: HrShiftAssignmentActivationMode,
): Promise<ActivationPreflight> {
  if (activationMode === "production") {
    return { current: false, reasons: ["qualified_retention_evidence_unavailable"] };
  }
  if (!runtimeRecognizesRepresentativeTimeZones()) {
    return { current: false, reasons: ["time_zone_policy_unavailable"] };
  }
  try {
    const result = await client.query<{ current: boolean }>(
      `SELECT count(*)::integer = $2::integer AS current
       FROM pg_catalog.pg_timezone_names
       WHERE name = ANY($1::text[])`,
      [representativeTimeZones, representativeTimeZones.length],
    );
    return result.rows[0]?.current === true
      ? { current: true, reasons: [] }
      : { current: false, reasons: ["time_zone_policy_unavailable"] };
  } catch {
    return { current: false, reasons: ["time_zone_policy_unavailable"] };
  }
}

export async function inspectShiftAssignmentSemanticReadiness(
  client: Pick<PoolClient, "query">,
  activationMode: HrShiftAssignmentActivationMode,
): Promise<ActivationPreflight> {
  const manifestCapabilities: readonly { readonly exposure: string; readonly id: string }[] =
    hrManifest.capabilities;
  const registeredShiftCapabilities = manifestCapabilities
    .filter(({ id }) => id.startsWith("hr.shift."))
    .map(({ exposure, id }) => ({ exposure, id }));
  if (
    registeredShiftCapabilities.length !== requiredShiftCapabilities.length ||
    requiredShiftCapabilities.some(
      (required) =>
        !registeredShiftCapabilities.some(
          (registered) =>
            registered.id === required.id && registered.exposure === required.exposure,
        ),
    )
  ) {
    return { current: false, reasons: ["service_not_eligible"] };
  }
  const coreCapabilities = new Set(platformCoreManifest.capabilities.map(({ id }) => id));
  if (
    platformCoreManifest.activation !== "required" ||
    !hrManifest.dependencies.includes(platformCoreManifest.id) ||
    !requiredCoreCapabilities.every((id) => coreCapabilities.has(id))
  ) {
    return { current: false, reasons: ["non_soft_dependency_not_eligible"] };
  }
  return await inspectShiftAssignmentEnvironment(client, activationMode);
}
