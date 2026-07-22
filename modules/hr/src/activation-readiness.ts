export const HR_LEAVE_REQUIRED_MIGRATIONS = [
  {
    createdAt: 1783638680530,
    hash: "6f86a6c35887bfc5977b3a6dd9637e8cd0b04f12d37bb8cab507a11976cbdf8e",
    id: "0000",
  },
  {
    createdAt: 1783638694169,
    hash: "1f2899c1bec70c438c6e009c1924d35a3cef7bdf5001899090de4d12ea6d424b",
    id: "0001",
  },
  {
    createdAt: 1783641088151,
    hash: "a45fc3118e84d06d64eebf1e52d688812bf83c8122d5f688df8e54c13320ea79",
    id: "0002",
  },
  {
    createdAt: 1783642209842,
    hash: "c5aa04bb6f8b75ac7dd878bd809042cf0bbc9465a9bf67a816637164fd140acf",
    id: "0003",
  },
  {
    createdAt: 1784276307910,
    hash: "9e360ba35e62b22ddb9b993a9af007ecec92777c4623e805c439fceeee17197f",
    id: "0005",
  },
  {
    createdAt: 1784736446030,
    hash: "14223482833b47ee8ad054e94694054990b1c6486b564cbbc66bca6d640164c1",
    id: "0013",
  },
] as const;
export const HR_LEAVE_CATALOG_REQUIREMENTS = {
  enums: [
    { labels: ["annual", "sick", "unpaid", "other"], name: "hr_leave_category" },
    { labels: ["submitted", "approved", "rejected"], name: "hr_leave_request_status" },
  ],
  tables: (
    "tenants,principals,memberships,service_activations,tenant_settings," +
    "work_items,evidence_events,outbox_events,hr_leave_requests"
  )
    .split(",")
    .map((name) => ({ name })),
  columns: [
    "memberships|status|text|1|'active'::text",
    "evidence_events|subject_type|text|1|",
    "evidence_events|correlation_id|uuid|1|",
    "outbox_events|aggregate_type|text|1|",
    "outbox_events|correlation_id|uuid|1|",
    "work_items|work_type|text|1|",
    "work_items|subject_type|text|1|",
    "hr_leave_requests|decision_note|text|0|",
    "hr_leave_requests|version|integer|1|1",
  ].map((row) => {
    const [parent, name, type, notNull, defaultExpression] = row.split("|");
    return { defaultExpression, name, notNull: notNull === "1", parent, type };
  }),
  indexes: [
    "memberships_tenant_principal_uq|memberships|tenant_id, principal_id||u",
    "service_activations_pk|service_activations|tenant_id, service_key||p",
    "work_items_tenant_work_subject_uq|work_items|tenant_id, work_type, subject_type, subject_id||u",
    "work_items_tenant_assignee_status_created_idx|work_items|tenant_id, assignee_principal_id, status, created_at||",
    "evidence_events_idempotency_uq|evidence_events|tenant_id, subject_type, subject_id, event_type, correlation_id||u",
    "evidence_events_tenant_subject_occurred_idx|evidence_events|tenant_id, subject_type, subject_id, occurred_at, evidence_event_id||",
    "outbox_events_idempotency_uq|outbox_events|tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version||u",
    "hr_leave_requests_tenant_employee_idempotency_uq|hr_leave_requests|tenant_id, employee_principal_id, idempotency_key||u",
    "hr_leave_requests_assigned_open_idx|hr_leave_requests|tenant_id, approver_principal_id, submitted_at, leave_request_id|(status = 'submitted'::public.hr_leave_request_status)|",
    "hr_leave_requests_employee_history_idx|hr_leave_requests|tenant_id, employee_principal_id, submitted_at DESC NULLS LAST, leave_request_id DESC NULLS LAST||",
  ].map((row) => {
    const [name, parent, columns, predicate, constraintType] = row.split("|");
    const unique = constraintType !== "";
    return {
      constraintType,
      definition: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON public.${parent} USING btree (${columns})${predicate ? ` WHERE ${predicate}` : ""}`,
      name,
      parent,
      predicate,
      primary: constraintType === "p",
      unique,
    };
  }),
  policies: [
    "memberships|memberships_tenant_isolation",
    "service_activations|service_activations_tenant_isolation",
    "tenant_settings|tenant_settings_tenant_isolation",
    "work_items|work_items_tenant_isolation",
    "evidence_events|evidence_events_tenant_isolation",
    "outbox_events|outbox_events_tenant_isolation",
    "hr_leave_requests|hr_leave_requests_tenant_isolation",
  ].map((row) => {
    const [parent, name] = row.split("|");
    return { name, parent };
  }),
  triggers: [
    "evidence_events|evidence_events_reject_update_delete|BEFORE DELETE OR UPDATE|ROW|esbla_reject_evidence_mutation",
    "evidence_events|evidence_events_reject_truncate|BEFORE TRUNCATE|STATEMENT|esbla_reject_evidence_mutation",
    "hr_leave_requests|hr_leave_requests_enforce_state|BEFORE INSERT OR DELETE OR UPDATE|ROW|esbla_enforce_hr_leave_state",
    "hr_leave_requests|hr_leave_requests_reject_truncate|BEFORE TRUNCATE|STATEMENT|esbla_enforce_hr_leave_state",
  ].map((row) => {
    const [parent, name, action, level, functionName] = row.split("|");
    return {
      definition: `CREATE TRIGGER ${name} ${action} ON public.${parent} FOR EACH ${level} EXECUTE FUNCTION public.${functionName}()`,
      functionName,
      name,
      parent,
    };
  }),
  constraints: [
    "memberships|memberships_status_valid|c|CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text]))",
    "work_items|work_items_tenant_work_subject_uq|u|UNIQUE (tenant_id, work_type, subject_type, subject_id)",
    "evidence_events|evidence_events_idempotency_uq|u|UNIQUE (tenant_id, subject_type, subject_id, event_type, correlation_id)",
    "outbox_events|outbox_events_idempotency_uq|u|UNIQUE (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version)",
    "hr_leave_requests|hr_leave_requests_tenant_employee_idempotency_uq|u|UNIQUE (tenant_id, employee_principal_id, idempotency_key)",
    "hr_leave_requests|hr_leave_requests_decision_consistent|c|CHECK (status = 'submitted'::public.hr_leave_request_status AND decided_at IS NULL AND decision_note IS NULL OR (status = ANY (ARRAY['approved'::public.hr_leave_request_status, 'rejected'::public.hr_leave_request_status])) AND decided_at IS NOT NULL)",
  ].map((row) => {
    const [parent, name, type, definition] = row.split("|");
    return { definition, name, parent, type };
  }),
  functions: [
    ...[
      "esbla_current_tenant_id|sql|uuid|s|search_path=pg_catalog|72cc22b496ef68e600155e2487691eaa80d6c1f94207242933f1b7cdcb4e4c89",
      "esbla_reject_evidence_mutation|plpgsql|trigger|v||30fa45fd4e7b290856e6776f2ca0e376335461622705a01f8b19b30683cdf53b",
      "esbla_enforce_hr_leave_state|plpgsql|trigger|v||a383d1d6ec766115a6a4742b2fd4ee92c07e42dc9fe5a95d2adabafa5a504e7f",
    ].map((row) => {
      const [name, language, returnType, volatility, config, sourceSha256] = row.split("|");
      return { config, language, name, returnType, sourceSha256, volatility };
    }),
    {
      applicationExecutable: true,
      config: "search_path=pg_catalog,row_security=on",
      identityArguments:
        "expected_tenant_id uuid, expected_actor_principal_id uuid, subject_principal_id uuid",
      language: "plpgsql",
      name: "esbla_lock_membership_authority",
      publicExecutable: false,
      returnType: "jsonb",
      securityDefiner: true,
      sourceSha256: "917b3c6562f9c66396fe497defff14140a7acaef70fbe861f498f8fc15a4849a",
      volatility: "v",
    },
  ],
};
export const HR_WORKFORCE_PROFILE_REQUIRED_MIGRATIONS = [
  ...HR_LEAVE_REQUIRED_MIGRATIONS.filter(({ id }) => id !== "0003"),
  {
    createdAt: 1784620421352,
    hash: "f6ecf5aeedb02686452a2855d96382383a1dc95e0514814c03773fb94fb92dde",
    id: "0006",
  },
  {
    createdAt: 1784622496162,
    hash: "ab19d8b130e9f7b0ced46181e07cacadbefe6fcaa9126212a432dd00c6e84b53",
    id: "0007",
  },
  {
    createdAt: 1784634660084,
    hash: "6e91e539b1ae824f386a468384904794bdb866630748bbd54e2ddc7dd85d9d6a",
    id: "0008",
  },
  {
    createdAt: 1784669535260,
    hash: "1624b2836986fdbf93b1b439a5ac100d70aca195918b31576945d2fd546ce40d",
    id: "0009",
  },
  {
    createdAt: 1784706016430,
    hash: "b2801c3ade245a891ba0b5be587b62693f6566f1e5e1e81250d6237e736d4b55",
    id: "0010",
  },
  {
    createdAt: 1784709676857,
    hash: "eea34bff2286a27ba496aca130be891c5088c3ee91506b244834ae5e9c547e95",
    id: "0011",
  },
] as const;
const runtimeTablePrivilege = (name: string, writable = false) => ({
  delete: false,
  insert: writable,
  name,
  references: false,
  select: true,
  trigger: false,
  truncate: false,
  update: writable,
});
export const HR_WORKFORCE_PROFILE_RUNTIME_TABLE_PRIVILEGES = [
  runtimeTablePrivilege("public.tenant_settings"),
  runtimeTablePrivilege("public.hr_workforce_profile_service_control"),
  runtimeTablePrivilege("public.membership_capabilities"),
  runtimeTablePrivilege("public.hr_worker_profiles", true),
  runtimeTablePrivilege("public.hr_workforce_status_history"),
  {
    delete: false,
    insert: true,
    name: "public.hr_reporting_relationships",
    references: false,
    select: true,
    trigger: false,
    truncate: false,
    update: false,
  },
] as const;
export const HR_WORKFORCE_PROFILE_CATALOG_REQUIREMENTS = {
  exactTriggerParents:
    "hr_workforce_profile_service_control,membership_capabilities,hr_reporting_relationships,hr_worker_profiles,hr_workforce_status_history".split(
      ",",
    ),
  enums: [
    { labels: ["assigned", "unassigned"], name: "hr_reporting_relationship_status" },
    { labels: ["draft", "active", "suspended", "terminated"], name: "hr_workforce_status" },
  ],
  tables: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.tables.filter(({ name }) => name !== "hr_leave_requests"),
    { name: "hr_workforce_profile_service_control" },
    { name: "hr_reporting_relationships" },
    { name: "hr_worker_profiles" },
    { name: "hr_workforce_status_history" },
    { name: "membership_capabilities" },
  ],
  columns: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.columns.filter(({ parent }) => parent !== "hr_leave_requests"),
    ...[
      "service_activations|service_key|text|1|",
      "service_activations|state|public.service_activation_state|1|'inactive'::public.service_activation_state",
      "service_activations|version|integer|1|1",
      "hr_workforce_profile_service_control|service_control_id|uuid|1|gen_random_uuid()",
      "hr_workforce_profile_service_control|tenant_id|uuid|1|",
      "hr_workforce_profile_service_control|service_key|text|1|'workforce_profile'::text",
      "hr_workforce_profile_service_control|settings_version|integer|1|1",
      "hr_workforce_profile_service_control|updated_at|timestamp with time zone|1|now()",
      "hr_workforce_profile_service_control|row_version|integer|1|1",
      "membership_capabilities|tenant_id|uuid|1|",
      "membership_capabilities|principal_id|uuid|1|",
      "membership_capabilities|capability_id|text|1|",
      "hr_worker_profiles|worker_profile_id|uuid|1|gen_random_uuid()",
      "hr_worker_profiles|tenant_id|uuid|1|",
      "hr_worker_profiles|principal_id|uuid|0|",
      "hr_worker_profiles|employee_number|text|0|",
      "hr_worker_profiles|workforce_status|public.hr_workforce_status|1|'draft'::public.hr_workforce_status",
      "hr_worker_profiles|created_at|timestamp with time zone|1|now()",
      "hr_worker_profiles|updated_at|timestamp with time zone|1|now()",
      "hr_worker_profiles|current_reporting_relationship_id|uuid|0|",
      "hr_worker_profiles|row_version|integer|1|1",
      "hr_reporting_relationships|reporting_relationship_id|uuid|1|gen_random_uuid()",
      "hr_reporting_relationships|tenant_id|uuid|1|",
      "hr_reporting_relationships|worker_profile_id|uuid|1|",
      "hr_reporting_relationships|manager_worker_profile_id|uuid|0|",
      "hr_reporting_relationships|relationship_status|public.hr_reporting_relationship_status|1|",
      "hr_reporting_relationships|effective_at|timestamp with time zone|1|now()",
      "hr_reporting_relationships|supersedes_reporting_relationship_id|uuid|0|",
      "hr_reporting_relationships|relationship_version|integer|1|",
      "hr_reporting_relationships|created_at|timestamp with time zone|1|now()",
      "hr_reporting_relationships|row_version|integer|1|1",
      "hr_workforce_status_history|workforce_status_history_id|uuid|1|gen_random_uuid()",
      "hr_workforce_status_history|tenant_id|uuid|1|",
      "hr_workforce_status_history|worker_profile_id|uuid|1|",
      "hr_workforce_status_history|previous_status|public.hr_workforce_status|0|",
      "hr_workforce_status_history|new_status|public.hr_workforce_status|1|",
      "hr_workforce_status_history|effective_at|timestamp with time zone|1|",
      "hr_workforce_status_history|actor_principal_id|uuid|1|",
      "hr_workforce_status_history|correlation_id|uuid|1|",
    ].map((entry) => {
      const [parent, name, type, notNull, defaultExpression] = entry.split("|");
      return { defaultExpression, name, notNull: notNull === "1", parent, type };
    }),
  ],
  indexes: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.indexes.filter(({ parent }) => parent !== "hr_leave_requests"),
    {
      constraintType: "p",
      definition:
        "CREATE UNIQUE INDEX hr_workforce_profile_service_control_pkey ON public.hr_workforce_profile_service_control USING btree (service_control_id)",
      name: "hr_workforce_profile_service_control_pkey",
      parent: "hr_workforce_profile_service_control",
      predicate: "",
      primary: true,
      unique: true,
    },
    {
      constraintType: "p",
      definition:
        "CREATE UNIQUE INDEX membership_capabilities_pk ON public.membership_capabilities USING btree (tenant_id, principal_id, capability_id)",
      name: "membership_capabilities_pk",
      parent: "membership_capabilities",
      predicate: "",
      primary: true,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE UNIQUE INDEX uq_hr_workforce_profile_service_control_tenant_key ON public.hr_workforce_profile_service_control USING btree (tenant_id, service_key)",
      name: "uq_hr_workforce_profile_service_control_tenant_key",
      parent: "hr_workforce_profile_service_control",
      predicate: "",
      primary: false,
      unique: true,
    },
    {
      constraintType: "p",
      definition:
        "CREATE UNIQUE INDEX hr_worker_profiles_pkey ON public.hr_worker_profiles USING btree (worker_profile_id)",
      name: "hr_worker_profiles_pkey",
      parent: "hr_worker_profiles",
      predicate: "",
      primary: true,
      unique: true,
    },
    {
      constraintType: "u",
      definition:
        "CREATE UNIQUE INDEX hr_worker_profiles_tenant_profile_uq ON public.hr_worker_profiles USING btree (tenant_id, worker_profile_id)",
      name: "hr_worker_profiles_tenant_profile_uq",
      parent: "hr_worker_profiles",
      predicate: "",
      primary: false,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE UNIQUE INDEX uq_hr_worker_profiles_tenant_principal_current ON public.hr_worker_profiles USING btree (tenant_id, principal_id) WHERE ((principal_id IS NOT NULL) AND (workforce_status <> 'terminated'::public.hr_workforce_status))",
      name: "uq_hr_worker_profiles_tenant_principal_current",
      parent: "hr_worker_profiles",
      predicate:
        "((principal_id IS NOT NULL) AND (workforce_status <> 'terminated'::public.hr_workforce_status))",
      primary: false,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE INDEX idx_hr_worker_profiles_tenant_principal_fk ON public.hr_worker_profiles USING btree (tenant_id, principal_id)",
      name: "idx_hr_worker_profiles_tenant_principal_fk",
      parent: "hr_worker_profiles",
      predicate: "",
      primary: false,
      unique: false,
    },
    {
      constraintType: "",
      definition:
        "CREATE INDEX idx_hr_worker_profiles_tenant_status_cursor ON public.hr_worker_profiles USING btree (tenant_id, workforce_status, created_at DESC NULLS LAST, worker_profile_id DESC NULLS LAST)",
      name: "idx_hr_worker_profiles_tenant_status_cursor",
      parent: "hr_worker_profiles",
      predicate: "",
      primary: false,
      unique: false,
    },
    {
      constraintType: "p",
      definition:
        "CREATE UNIQUE INDEX hr_reporting_relationships_pkey ON public.hr_reporting_relationships USING btree (reporting_relationship_id)",
      name: "hr_reporting_relationships_pkey",
      parent: "hr_reporting_relationships",
      predicate: "",
      primary: true,
      unique: true,
    },
    {
      constraintType: "u",
      definition:
        "CREATE UNIQUE INDEX uq_hr_reporting_relationships_composite_identity ON public.hr_reporting_relationships USING btree (tenant_id, worker_profile_id, reporting_relationship_id)",
      name: "uq_hr_reporting_relationships_composite_identity",
      parent: "hr_reporting_relationships",
      predicate: "",
      primary: false,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE UNIQUE INDEX uq_hr_reporting_relationships_tenant_worker_version ON public.hr_reporting_relationships USING btree (tenant_id, worker_profile_id, relationship_version)",
      name: "uq_hr_reporting_relationships_tenant_worker_version",
      parent: "hr_reporting_relationships",
      predicate: "",
      primary: false,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE UNIQUE INDEX uq_hr_reporting_relationships_tenant_successor ON public.hr_reporting_relationships USING btree (tenant_id, supersedes_reporting_relationship_id) WHERE (supersedes_reporting_relationship_id IS NOT NULL)",
      name: "uq_hr_reporting_relationships_tenant_successor",
      parent: "hr_reporting_relationships",
      predicate: "(supersedes_reporting_relationship_id IS NOT NULL)",
      primary: false,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE INDEX idx_hr_reporting_relationships_tenant_manager_current_cursor ON public.hr_reporting_relationships USING btree (tenant_id, manager_worker_profile_id, relationship_status, effective_at DESC, reporting_relationship_id DESC)",
      name: "idx_hr_reporting_relationships_tenant_manager_current_cursor",
      parent: "hr_reporting_relationships",
      predicate: "",
      primary: false,
      unique: false,
    },
    {
      constraintType: "",
      definition:
        "CREATE INDEX idx_hr_reporting_relationships_tenant_worker_history ON public.hr_reporting_relationships USING btree (tenant_id, worker_profile_id, relationship_version DESC, reporting_relationship_id DESC)",
      name: "idx_hr_reporting_relationships_tenant_worker_history",
      parent: "hr_reporting_relationships",
      predicate: "",
      primary: false,
      unique: false,
    },
    {
      constraintType: "",
      definition:
        "CREATE UNIQUE INDEX uq_hr_worker_profiles_tenant_relationship_head ON public.hr_worker_profiles USING btree (tenant_id, current_reporting_relationship_id) WHERE (current_reporting_relationship_id IS NOT NULL)",
      name: "uq_hr_worker_profiles_tenant_relationship_head",
      parent: "hr_worker_profiles",
      predicate: "(current_reporting_relationship_id IS NOT NULL)",
      primary: false,
      unique: true,
    },
    {
      constraintType: "p",
      definition:
        "CREATE UNIQUE INDEX hr_workforce_status_history_pkey ON public.hr_workforce_status_history USING btree (workforce_status_history_id)",
      name: "hr_workforce_status_history_pkey",
      parent: "hr_workforce_status_history",
      predicate: "",
      primary: true,
      unique: true,
    },
    {
      constraintType: "",
      definition:
        "CREATE INDEX idx_hr_workforce_status_history_tenant_worker_effective ON public.hr_workforce_status_history USING btree (tenant_id, worker_profile_id, effective_at DESC NULLS LAST, workforce_status_history_id DESC NULLS LAST)",
      name: "idx_hr_workforce_status_history_tenant_worker_effective",
      parent: "hr_workforce_status_history",
      predicate: "",
      primary: false,
      unique: false,
    },
    {
      constraintType: "",
      definition:
        "CREATE INDEX idx_hr_workforce_status_history_tenant_actor_fk ON public.hr_workforce_status_history USING btree (tenant_id, actor_principal_id)",
      name: "idx_hr_workforce_status_history_tenant_actor_fk",
      parent: "hr_workforce_status_history",
      predicate: "",
      primary: false,
      unique: false,
    },
  ],
  policies: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.policies.filter(
      ({ parent }) => parent !== "hr_leave_requests",
    ),
    ...[
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_tenant_isolation",
      "membership_capabilities|membership_capabilities_tenant_isolation",
      "hr_reporting_relationships|hr_reporting_relationships_tenant_isolation",
      "hr_worker_profiles|hr_worker_profiles_tenant_isolation",
      "hr_workforce_status_history|hr_workforce_status_history_tenant_isolation",
    ].map((row) => {
      const [parent, name] = row.split("|");
      return { name, parent };
    }),
  ],
  triggers: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.triggers.filter(
      ({ parent }) => parent !== "hr_leave_requests",
    ),
    {
      definition:
        "CREATE TRIGGER hr_workforce_profile_service_control_enforce_state BEFORE INSERT OR DELETE OR UPDATE ON public.hr_workforce_profile_service_control FOR EACH ROW EXECUTE FUNCTION public.esbla_enforce_hr_workforce_profile_service_control()",
      functionName: "esbla_enforce_hr_workforce_profile_service_control",
      name: "hr_workforce_profile_service_control_enforce_state",
      parent: "hr_workforce_profile_service_control",
    },
    {
      definition:
        "CREATE TRIGGER hr_workforce_profile_service_control_reject_truncate BEFORE TRUNCATE ON public.hr_workforce_profile_service_control FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_enforce_hr_workforce_profile_service_control()",
      functionName: "esbla_enforce_hr_workforce_profile_service_control",
      name: "hr_workforce_profile_service_control_reject_truncate",
      parent: "hr_workforce_profile_service_control",
    },
    {
      definition:
        "CREATE TRIGGER service_activations_sync_hr_workforce_profile AFTER INSERT OR UPDATE ON public.service_activations FOR EACH ROW EXECUTE FUNCTION public.esbla_sync_hr_workforce_profile_service_activation()",
      functionName: "esbla_sync_hr_workforce_profile_service_activation",
      name: "service_activations_sync_hr_workforce_profile",
      parent: "service_activations",
    },
    {
      definition:
        "CREATE TRIGGER membership_capabilities_guard_authority BEFORE INSERT OR DELETE OR UPDATE ON public.membership_capabilities FOR EACH ROW EXECUTE FUNCTION public.esbla_guard_membership_capability_authority()",
      functionName: "esbla_guard_membership_capability_authority",
      name: "membership_capabilities_guard_authority",
      parent: "membership_capabilities",
    },
    {
      definition:
        "CREATE TRIGGER membership_capabilities_reject_truncate BEFORE TRUNCATE ON public.membership_capabilities FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_guard_membership_capability_authority()",
      functionName: "esbla_guard_membership_capability_authority",
      name: "membership_capabilities_reject_truncate",
      parent: "membership_capabilities",
    },
    {
      definition:
        "CREATE TRIGGER hr_reporting_relationships_enforce_state BEFORE INSERT OR DELETE OR UPDATE ON public.hr_reporting_relationships FOR EACH ROW EXECUTE FUNCTION public.esbla_enforce_hr_reporting_relationship_state()",
      functionName: "esbla_enforce_hr_reporting_relationship_state",
      name: "hr_reporting_relationships_enforce_state",
      parent: "hr_reporting_relationships",
    },
    {
      definition:
        "CREATE TRIGGER hr_reporting_relationships_reject_truncate BEFORE TRUNCATE ON public.hr_reporting_relationships FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_enforce_hr_reporting_relationship_state()",
      functionName: "esbla_enforce_hr_reporting_relationship_state",
      name: "hr_reporting_relationships_reject_truncate",
      parent: "hr_reporting_relationships",
    },
    {
      definition:
        "CREATE TRIGGER hr_worker_profiles_append_status_history AFTER INSERT OR UPDATE OF workforce_status ON public.hr_worker_profiles FOR EACH ROW EXECUTE FUNCTION public.esbla_append_hr_workforce_status_history()",
      functionName: "esbla_append_hr_workforce_status_history",
      name: "hr_worker_profiles_append_status_history",
      parent: "hr_worker_profiles",
    },
    {
      definition:
        "CREATE TRIGGER hr_worker_profiles_enforce_state BEFORE INSERT OR DELETE OR UPDATE ON public.hr_worker_profiles FOR EACH ROW EXECUTE FUNCTION public.esbla_enforce_hr_workforce_profile_state()",
      functionName: "esbla_enforce_hr_workforce_profile_state",
      name: "hr_worker_profiles_enforce_state",
      parent: "hr_worker_profiles",
    },
    {
      definition:
        "CREATE TRIGGER hr_worker_profiles_reject_truncate BEFORE TRUNCATE ON public.hr_worker_profiles FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_enforce_hr_workforce_profile_state()",
      functionName: "esbla_enforce_hr_workforce_profile_state",
      name: "hr_worker_profiles_reject_truncate",
      parent: "hr_worker_profiles",
    },
    {
      definition:
        "CREATE TRIGGER hr_workforce_status_history_reject_truncate BEFORE TRUNCATE ON public.hr_workforce_status_history FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_reject_hr_workforce_status_history_mutation()",
      functionName: "esbla_reject_hr_workforce_status_history_mutation",
      name: "hr_workforce_status_history_reject_truncate",
      parent: "hr_workforce_status_history",
    },
    {
      definition:
        "CREATE TRIGGER hr_workforce_status_history_reject_update_delete BEFORE DELETE OR UPDATE ON public.hr_workforce_status_history FOR EACH ROW EXECUTE FUNCTION public.esbla_reject_hr_workforce_status_history_mutation()",
      functionName: "esbla_reject_hr_workforce_status_history_mutation",
      name: "hr_workforce_status_history_reject_update_delete",
      parent: "hr_workforce_status_history",
    },
  ],
  constraints: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.constraints.filter(
      ({ parent }) => parent !== "hr_leave_requests",
    ),
    ...[
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_pkey|p|PRIMARY KEY (service_control_id)",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_activation_fk|f|FOREIGN KEY (tenant_id, service_key) REFERENCES public.service_activations(tenant_id, service_key) ON DELETE RESTRICT",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_key_exact|c|CHECK (service_key = 'workforce_profile'::text)",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_settings_version_positive|c|CHECK (settings_version > 0)",
      "hr_workforce_profile_service_control|hr_workforce_profile_service_control_row_version_positive|c|CHECK (row_version > 0)",
      "membership_capabilities|membership_capabilities_pk|p|PRIMARY KEY (tenant_id, principal_id, capability_id)",
      "membership_capabilities|membership_capabilities_membership_fk|f|FOREIGN KEY (tenant_id, principal_id) REFERENCES public.memberships(tenant_id, principal_id) ON DELETE RESTRICT",
      "membership_capabilities|membership_capabilities_id_not_blank|c|CHECK (char_length(TRIM(BOTH FROM capability_id)) > 0)",
      "hr_worker_profiles|hr_worker_profiles_pkey|p|PRIMARY KEY (worker_profile_id)",
      "hr_worker_profiles|hr_worker_profiles_tenant_id_tenants_tenant_id_fk|f|FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE RESTRICT",
      "hr_worker_profiles|hr_worker_profiles_principal_same_tenant_fk|f|FOREIGN KEY (tenant_id, principal_id) REFERENCES public.memberships(tenant_id, principal_id) ON DELETE RESTRICT",
      "hr_worker_profiles|hr_worker_profiles_tenant_profile_uq|u|UNIQUE (tenant_id, worker_profile_id)",
      "hr_worker_profiles|hr_worker_profiles_employee_number_not_blank|c|CHECK (employee_number IS NULL OR char_length(TRIM(BOTH FROM employee_number)) > 0)",
      "hr_worker_profiles|hr_worker_profiles_current_relationship_same_root_fk|f|FOREIGN KEY (tenant_id, worker_profile_id, current_reporting_relationship_id) REFERENCES public.hr_reporting_relationships(tenant_id, worker_profile_id, reporting_relationship_id) ON DELETE RESTRICT",
      "hr_worker_profiles|hr_worker_profiles_row_version_positive|c|CHECK (row_version > 0)",
      "hr_reporting_relationships|hr_reporting_relationships_pkey|p|PRIMARY KEY (reporting_relationship_id)",
      "hr_reporting_relationships|uq_hr_reporting_relationships_composite_identity|u|UNIQUE (tenant_id, worker_profile_id, reporting_relationship_id)",
      "hr_reporting_relationships|hr_reporting_relationships_status_manager_consistent|c|CHECK (relationship_status = 'assigned'::public.hr_reporting_relationship_status AND manager_worker_profile_id IS NOT NULL OR relationship_status = 'unassigned'::public.hr_reporting_relationship_status AND manager_worker_profile_id IS NULL)",
      "hr_reporting_relationships|hr_reporting_relationships_relationship_version_positive|c|CHECK (relationship_version > 0)",
      "hr_reporting_relationships|hr_reporting_relationships_row_version_fixed|c|CHECK (row_version = 1)",
      "hr_reporting_relationships|hr_reporting_relationships_tenant_fk|f|FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE RESTRICT",
      "hr_reporting_relationships|hr_reporting_relationships_report_same_tenant_fk|f|FOREIGN KEY (tenant_id, worker_profile_id) REFERENCES public.hr_worker_profiles(tenant_id, worker_profile_id) ON DELETE RESTRICT",
      "hr_reporting_relationships|hr_reporting_relationships_manager_same_tenant_fk|f|FOREIGN KEY (tenant_id, manager_worker_profile_id) REFERENCES public.hr_worker_profiles(tenant_id, worker_profile_id) ON DELETE RESTRICT",
      "hr_reporting_relationships|hr_reporting_relationships_predecessor_same_worker_fk|f|FOREIGN KEY (tenant_id, worker_profile_id, supersedes_reporting_relationship_id) REFERENCES public.hr_reporting_relationships(tenant_id, worker_profile_id, reporting_relationship_id) ON DELETE RESTRICT",
      "hr_workforce_status_history|hr_workforce_status_history_pkey|p|PRIMARY KEY (workforce_status_history_id)",
      "hr_workforce_status_history|hr_workforce_status_history_tenant_fk|f|FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE RESTRICT",
      "hr_workforce_status_history|hr_workforce_status_history_profile_same_tenant_fk|f|FOREIGN KEY (tenant_id, worker_profile_id) REFERENCES public.hr_worker_profiles(tenant_id, worker_profile_id) ON DELETE RESTRICT",
      "hr_workforce_status_history|hr_workforce_status_history_actor_same_tenant_fk|f|FOREIGN KEY (tenant_id, actor_principal_id) REFERENCES public.memberships(tenant_id, principal_id) ON DELETE RESTRICT",
      "hr_workforce_status_history|hr_workforce_status_history_transition_valid|c|CHECK ((previous_status IS NULL AND new_status = 'draft'::public.hr_workforce_status OR previous_status = 'draft'::public.hr_workforce_status AND new_status = 'active'::public.hr_workforce_status OR previous_status = 'active'::public.hr_workforce_status AND (new_status = ANY (ARRAY['suspended'::public.hr_workforce_status, 'terminated'::public.hr_workforce_status])) OR previous_status = 'suspended'::public.hr_workforce_status AND (new_status = ANY (ARRAY['active'::public.hr_workforce_status, 'terminated'::public.hr_workforce_status]))) IS TRUE)",
    ].map((entry) => {
      const [parent, name, type, definition] = entry.split("|");
      return { definition, name, parent, type };
    }),
  ],
  functions: [
    ...HR_LEAVE_CATALOG_REQUIREMENTS.functions.filter(
      ({ name }) => name !== "esbla_enforce_hr_leave_state",
    ),
    ...[
      "esbla_enforce_hr_workforce_profile_service_control|0|46946221929617cdfdc79444e75953c12455444a2001e9c027b9408364497659",
      "esbla_sync_hr_workforce_profile_service_activation|1|275ac8efc9ea68d97a5eb51fbabb38723c205bd3da1737bd98a1f52f9596c24b",
      "esbla_guard_membership_capability_authority|1|ffc08b59c0bedd3ee08cba3106cd2f46bcec595866500b97cbc428740c2e450f",
      "esbla_enforce_hr_workforce_profile_state|1|1bb62849aab79018daac18ff26fdf17bf000cc1fe8f226b01d7f96151ee64b64|search_path=pg_catalog,row_security=on",
      "esbla_enforce_hr_reporting_relationship_state|1|d2a1053d4cf8be46686b1c361fba71ab53c2a3107d565bae325918abc42a51d5|search_path=pg_catalog,row_security=on",
      "esbla_append_hr_workforce_status_history|1|a456011a8b02c413d4d0b9f8c02d4e3b3b0a29d65fc0eae53a9be95ca29ab936",
      "esbla_reject_hr_workforce_status_history_mutation|0|03f1a1287d355179ec62f8d74f744c998f2fe42057378c729e1cc91761eff793",
    ].map((row) => {
      const [name, securityDefiner, sourceSha256, config] = row.split("|");
      return {
        config: config ?? "search_path=pg_catalog, public",
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
      config: "search_path=pg_catalog, public",
      identityArguments: "integer, boolean, text, boolean",
      applicationExecutable: true,
      language: "plpgsql",
      name: "esbla_configure_hr_workforce_profile_settings",
      publicExecutable: false,
      returnType: "void",
      securityDefiner: true,
      sourceSha256: "0189ff52261e59c6135407dc6185c19cce339984926df358795bd1f839a58d7e",
      volatility: "v",
    },
  ],
};
