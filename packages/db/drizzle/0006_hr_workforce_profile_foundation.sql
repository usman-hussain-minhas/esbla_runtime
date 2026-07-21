CREATE TYPE "public"."hr_workforce_status" AS ENUM('draft', 'active', 'suspended', 'terminated');--> statement-breakpoint
CREATE TABLE "hr_worker_profiles" (
	"worker_profile_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid,
	"employee_number" varchar(64),
	"workforce_status" "hr_workforce_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_reporting_relationship_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_worker_profiles_tenant_worker_profile_uq" UNIQUE("tenant_id","worker_profile_id"),
	CONSTRAINT "hr_worker_profiles_employee_number_valid" CHECK ("hr_worker_profiles"."employee_number" IS NULL OR char_length(trim("hr_worker_profiles"."employee_number")) BETWEEN 1 AND 64),
	CONSTRAINT "hr_worker_profiles_active_principal_link_required" CHECK ("hr_worker_profiles"."workforce_status" <> 'active' OR "hr_worker_profiles"."principal_id" IS NOT NULL),
	CONSTRAINT "hr_worker_profiles_relationship_head_reserved" CHECK ("hr_worker_profiles"."current_reporting_relationship_id" IS NULL),
	CONSTRAINT "hr_worker_profiles_row_version_positive" CHECK ("hr_worker_profiles"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_workforce_profile_service_control" (
	"service_control_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_key" text DEFAULT 'workforce_profile' NOT NULL,
	"activation_state" "service_activation_state" NOT NULL,
	"activation_version" integer DEFAULT 1 NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_workforce_profile_service_control_tenant_key" UNIQUE("tenant_id","service_key"),
	CONSTRAINT "hr_workforce_profile_service_control_key_exact" CHECK ("hr_workforce_profile_service_control"."service_key" = 'workforce_profile'),
	CONSTRAINT "hr_wfp_service_control_activation_version_positive" CHECK ("hr_workforce_profile_service_control"."activation_version" > 0),
	CONSTRAINT "hr_workforce_profile_service_control_settings_version_positive" CHECK ("hr_workforce_profile_service_control"."settings_version" > 0),
	CONSTRAINT "hr_workforce_profile_service_control_row_version_positive" CHECK ("hr_workforce_profile_service_control"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_workforce_profile_service_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_workforce_status_history" (
	"workforce_status_history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"previous_status" "hr_workforce_status",
	"new_status" "hr_workforce_status" NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	CONSTRAINT "hr_workforce_status_history_transition_changes_status" CHECK ("hr_workforce_status_history"."previous_status" IS NULL OR "hr_workforce_status_history"."previous_status" <> "hr_workforce_status_history"."new_status")
);
--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" ADD CONSTRAINT "hr_worker_profiles_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" ADD CONSTRAINT "hr_worker_profiles_principal_same_tenant_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_profile_service_control" ADD CONSTRAINT "hr_wfp_service_control_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_profile_service_control" ADD CONSTRAINT "hr_workforce_profile_service_control_activation_fk" FOREIGN KEY ("tenant_id","service_key") REFERENCES "public"."service_activations"("tenant_id","service_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ADD CONSTRAINT "hr_workforce_status_history_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ADD CONSTRAINT "hr_workforce_status_history_worker_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ADD CONSTRAINT "hr_workforce_status_history_actor_same_tenant_fk" FOREIGN KEY ("tenant_id","actor_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_worker_profiles_tenant_principal_current" ON "hr_worker_profiles" USING btree ("tenant_id","principal_id") WHERE "hr_worker_profiles"."principal_id" IS NOT NULL AND "hr_worker_profiles"."workforce_status" <> 'terminated';--> statement-breakpoint
CREATE INDEX "idx_hr_worker_profiles_tenant_status_cursor" ON "hr_worker_profiles" USING btree ("tenant_id","workforce_status","created_at" DESC NULLS LAST,"worker_profile_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hr_workforce_status_history_tenant_worker_effective" ON "hr_workforce_status_history" USING btree ("tenant_id","worker_profile_id","effective_at" DESC NULLS LAST,"workforce_status_history_id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_worker_profiles_tenant_isolation" ON "hr_worker_profiles"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_workforce_profile_service_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_workforce_profile_service_control_tenant_isolation" ON "hr_workforce_profile_service_control"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_workforce_status_history_tenant_isolation" ON "hr_workforce_status_history"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_worker_profile_state"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'hr_worker_profiles cannot be deleted in v1' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.workforce_status <> 'draft' OR NEW.row_version <> 1 OR
       NEW.current_reporting_relationship_id IS NOT NULL OR
       NEW.updated_at < NEW.created_at THEN
      RAISE EXCEPTION 'hr_worker_profiles must be created as an unassigned draft row version 1'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.workforce_status = 'terminated' THEN
    RAISE EXCEPTION 'terminated hr_worker_profiles are immutable' USING ERRCODE = '55000';
  END IF;
  IF (NEW.tenant_id, NEW.worker_profile_id, NEW.employee_number, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.worker_profile_id, OLD.employee_number, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable hr_worker_profiles fields changed' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'hr_worker_profiles update requires the next row version and monotonic timestamp'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id AND NOT (
    OLD.workforce_status = 'draft' AND
    OLD.principal_id IS NULL AND
    NEW.principal_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'hr_worker_profiles principal link transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.workforce_status <> OLD.workforce_status AND NOT (
    (OLD.workforce_status = 'draft' AND NEW.workforce_status = 'active') OR
    (OLD.workforce_status = 'active' AND NEW.workforce_status IN ('suspended', 'terminated')) OR
    (OLD.workforce_status = 'suspended' AND NEW.workforce_status IN ('active', 'terminated'))
  ) THEN
    RAISE EXCEPTION 'hr_worker_profiles workforce status transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.workforce_status = 'active' AND NEW.principal_id IS NULL THEN
    RAISE EXCEPTION 'active hr_worker_profiles require a principal link'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "hr_worker_profiles_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_worker_profiles"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_worker_profile_state"();--> statement-breakpoint
CREATE TRIGGER "hr_worker_profiles_reject_truncate"
  BEFORE TRUNCATE ON "hr_worker_profiles"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_worker_profile_state"();--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_workforce_status_history"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_status hr_workforce_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'hr_workforce_status_history is append-only' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (NEW.previous_status IS NULL AND NEW.new_status = 'draft') OR
    (NEW.previous_status = 'draft' AND NEW.new_status = 'active') OR
    (NEW.previous_status = 'active' AND NEW.new_status IN ('suspended', 'terminated')) OR
    (NEW.previous_status = 'suspended' AND NEW.new_status IN ('active', 'terminated'))
  ) THEN
    RAISE EXCEPTION 'hr_workforce_status_history transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  SELECT workforce_status INTO current_status
  FROM hr_worker_profiles
  WHERE tenant_id = NEW.tenant_id AND worker_profile_id = NEW.worker_profile_id;
  IF current_status IS DISTINCT FROM NEW.new_status THEN
    RAISE EXCEPTION 'hr_workforce_status_history does not match current profile status'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "hr_workforce_status_history_enforce_append_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_workforce_status_history"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_workforce_status_history"();--> statement-breakpoint
CREATE TRIGGER "hr_workforce_status_history_reject_truncate"
  BEFORE TRUNCATE ON "hr_workforce_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_workforce_status_history"();--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_workforce_profile_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority_state service_activation_state;
  authority_version integer;
  activation_changed boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'hr_workforce_profile_service_control cannot be deleted in v1'
      USING ERRCODE = '55000';
  END IF;
  SELECT state, version INTO authority_state, authority_version
  FROM service_activations
  WHERE tenant_id = NEW.tenant_id AND service_key = NEW.service_key;
  IF NOT FOUND OR NEW.service_key <> 'workforce_profile' OR
     NEW.activation_state IS DISTINCT FROM authority_state OR
     NEW.activation_version IS DISTINCT FROM authority_version THEN
    RAISE EXCEPTION 'workforce service control must match authoritative service activation'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.activation_version <> 1 OR NEW.settings_version <> 1 OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'workforce service control must start at version 1'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.service_control_id, NEW.tenant_id, NEW.service_key)
     IS DISTINCT FROM
     (OLD.service_control_id, OLD.tenant_id, OLD.service_key) THEN
    RAISE EXCEPTION 'immutable workforce service control fields changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workforce service control requires next row version and monotonic timestamp'
      USING ERRCODE = '55000';
  END IF;
  activation_changed := (NEW.activation_state, NEW.activation_version)
    IS DISTINCT FROM (OLD.activation_state, OLD.activation_version);
  IF activation_changed THEN
    IF NEW.settings_version <> OLD.settings_version THEN
      RAISE EXCEPTION 'activation and settings changes must not be mixed'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.settings_version <> OLD.settings_version + 1 THEN
    RAISE EXCEPTION 'settings update requires the next settings version'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "hr_workforce_profile_service_control_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_workforce_profile_service_control"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_workforce_profile_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_workforce_profile_service_control_reject_truncate"
  BEFORE TRUNCATE ON "hr_workforce_profile_service_control"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_workforce_profile_service_control"();--> statement-breakpoint
CREATE FUNCTION "esbla_sync_hr_workforce_profile_service_activation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.service_key <> 'workforce_profile' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_workforce_profile_service_control (
      tenant_id, service_key, activation_state, activation_version,
      settings_version, updated_at, row_version
    ) VALUES (
      NEW.tenant_id, NEW.service_key, NEW.state, NEW.version,
      1, statement_timestamp(), 1
    );
    RETURN NEW;
  END IF;
  UPDATE hr_workforce_profile_service_control
  SET activation_state = NEW.state,
      activation_version = NEW.version,
      updated_at = statement_timestamp(),
      row_version = row_version + 1
  WHERE tenant_id = NEW.tenant_id AND service_key = NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce service activation has no synchronized control row'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "service_activations_sync_hr_workforce_profile"
  AFTER INSERT OR UPDATE ON "service_activations"
  FOR EACH ROW EXECUTE FUNCTION "esbla_sync_hr_workforce_profile_service_activation"();
