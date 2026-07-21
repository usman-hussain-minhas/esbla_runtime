CREATE TYPE "public"."hr_workforce_status" AS ENUM('draft', 'active', 'suspended', 'terminated');--> statement-breakpoint
CREATE TABLE "hr_worker_profiles" (
	"worker_profile_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid,
	"employee_number" text,
	"workforce_status" "hr_workforce_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_reporting_relationship_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_worker_profiles_tenant_profile_uq" UNIQUE("tenant_id","worker_profile_id"),
	CONSTRAINT "hr_worker_profiles_employee_number_not_blank" CHECK ("hr_worker_profiles"."employee_number" IS NULL OR char_length(trim("hr_worker_profiles"."employee_number")) > 0),
	CONSTRAINT "hr_worker_profiles_relationship_head_blocked" CHECK ("hr_worker_profiles"."current_reporting_relationship_id" IS NULL),
	CONSTRAINT "hr_worker_profiles_row_version_positive" CHECK ("hr_worker_profiles"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_workforce_status_history" (
	"workforce_status_history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"previous_status" "hr_workforce_status",
	"new_status" "hr_workforce_status" NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	CONSTRAINT "hr_workforce_status_history_transition_valid" CHECK ((("hr_workforce_status_history"."previous_status" IS NULL AND "hr_workforce_status_history"."new_status" = 'draft') OR
          ("hr_workforce_status_history"."previous_status" = 'draft' AND "hr_workforce_status_history"."new_status" = 'active') OR
          ("hr_workforce_status_history"."previous_status" = 'active' AND "hr_workforce_status_history"."new_status" IN ('suspended', 'terminated')) OR
          ("hr_workforce_status_history"."previous_status" = 'suspended' AND "hr_workforce_status_history"."new_status" IN ('active', 'terminated'))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" ADD CONSTRAINT "hr_worker_profiles_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" ADD CONSTRAINT "hr_worker_profiles_principal_same_tenant_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ADD CONSTRAINT "hr_workforce_status_history_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ADD CONSTRAINT "hr_workforce_status_history_profile_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" ADD CONSTRAINT "hr_workforce_status_history_actor_same_tenant_fk" FOREIGN KEY ("tenant_id","actor_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_worker_profiles_tenant_principal_current" ON "hr_worker_profiles" USING btree ("tenant_id","principal_id") WHERE "hr_worker_profiles"."principal_id" IS NOT NULL AND "hr_worker_profiles"."workforce_status" <> 'terminated';--> statement-breakpoint
CREATE INDEX "idx_hr_worker_profiles_tenant_principal_fk" ON "hr_worker_profiles" USING btree ("tenant_id","principal_id");--> statement-breakpoint
CREATE INDEX "idx_hr_worker_profiles_tenant_status_cursor" ON "hr_worker_profiles" USING btree ("tenant_id","workforce_status","created_at" DESC NULLS LAST,"worker_profile_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hr_workforce_status_history_tenant_worker_effective" ON "hr_workforce_status_history" USING btree ("tenant_id","worker_profile_id","effective_at" DESC NULLS LAST,"workforce_status_history_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hr_workforce_status_history_tenant_actor_fk" ON "hr_workforce_status_history" USING btree ("tenant_id","actor_principal_id");
--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_worker_profiles_tenant_isolation"
  ON "hr_worker_profiles"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_workforce_status_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_workforce_status_history_tenant_isolation"
  ON "hr_workforce_status_history"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_workforce_profile_state"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  linked_membership_status text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'workforce profiles cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workforce profiles cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'workforce_profile'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile service is inactive'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.worker_profile_id := pg_catalog.gen_random_uuid();
    NEW.created_at := pg_catalog.statement_timestamp();
    NEW.updated_at := NEW.created_at;
    IF NEW.principal_id IS NOT NULL
       OR NEW.workforce_status <> 'draft'
       OR NEW.current_reporting_relationship_id IS NOT NULL
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'workforce profiles must begin as unlinked draft version 1'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.worker_profile_id IS DISTINCT FROM OLD.worker_profile_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.employee_number IS DISTINCT FROM OLD.employee_number
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.current_reporting_relationship_id IS DISTINCT FROM OLD.current_reporting_relationship_id THEN
    RAISE EXCEPTION 'workforce profile immutable fields changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'workforce profile version must advance exactly'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.workforce_status = 'terminated' THEN
    RAISE EXCEPTION 'terminated workforce profiles are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
     AND NEW.workforce_status IS DISTINCT FROM OLD.workforce_status THEN
    RAISE EXCEPTION 'workforce profile link and status cannot change together'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
    IF OLD.principal_id IS NOT NULL
       OR NEW.principal_id IS NULL
       OR OLD.workforce_status <> 'draft'
       OR NEW.workforce_status <> 'draft' THEN
      RAISE EXCEPTION 'workforce profile link transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT membership.status
      INTO linked_membership_status
      FROM public.memberships AS membership
      WHERE membership.tenant_id = NEW.tenant_id
        AND membership.principal_id = NEW.principal_id
      FOR SHARE NOWAIT;
    IF linked_membership_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'workforce profile link requires an active membership'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.workforce_status IS DISTINCT FROM OLD.workforce_status THEN
    IF NOT (
      (OLD.workforce_status = 'draft' AND NEW.workforce_status = 'active')
      OR (OLD.workforce_status = 'active' AND NEW.workforce_status IN ('suspended', 'terminated'))
      OR (OLD.workforce_status = 'suspended' AND NEW.workforce_status IN ('active', 'terminated'))
    ) THEN
      RAISE EXCEPTION 'workforce profile status transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.workforce_status = 'active' THEN
      IF NEW.principal_id IS NULL THEN
        RAISE EXCEPTION 'active workforce profile requires a linked principal'
          USING ERRCODE = '55000';
      END IF;
      SELECT membership.status
        INTO linked_membership_status
      FROM public.memberships AS membership
      WHERE membership.tenant_id = NEW.tenant_id
        AND membership.principal_id = NEW.principal_id
      FOR SHARE NOWAIT;
      IF linked_membership_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'active workforce profile requires an active membership'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'workforce profile update has no supported state change'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := GREATEST(
    pg_catalog.statement_timestamp(),
    OLD.updated_at + interval '1 microsecond'
  );
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_workforce_profile_state"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "esbla_append_hr_workforce_status_history"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_text text;
  correlation_text text;
  actor_id uuid;
  correlation_value uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.workforce_status IS NOT DISTINCT FROM OLD.workforce_status THEN
    RETURN NEW;
  END IF;

  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  correlation_text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
  IF actor_text IS NULL OR correlation_text IS NULL THEN
    RAISE EXCEPTION 'workforce status history context is missing'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    actor_id := actor_text::pg_catalog.uuid;
    correlation_value := correlation_text::pg_catalog.uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workforce status history context is invalid'
      USING ERRCODE = '22023';
  END;

  INSERT INTO public.hr_workforce_status_history (
    tenant_id,
    worker_profile_id,
    previous_status,
    new_status,
    effective_at,
    actor_principal_id,
    correlation_id
  ) VALUES (
    NEW.tenant_id,
    NEW.worker_profile_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.workforce_status END,
    NEW.workforce_status,
    NEW.updated_at,
    actor_id,
    correlation_value
  );
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_append_hr_workforce_status_history"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "esbla_reject_hr_workforce_status_history_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'workforce status history is append-only'
    USING ERRCODE = '55000';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_reject_hr_workforce_status_history_mutation"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_worker_profiles_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_worker_profiles"
  FOR EACH ROW
  EXECUTE FUNCTION "esbla_enforce_hr_workforce_profile_state"();--> statement-breakpoint
CREATE TRIGGER "hr_worker_profiles_reject_truncate"
  BEFORE TRUNCATE ON "hr_worker_profiles"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "esbla_enforce_hr_workforce_profile_state"();--> statement-breakpoint
CREATE TRIGGER "hr_worker_profiles_append_status_history"
  AFTER INSERT OR UPDATE OF "workforce_status" ON "hr_worker_profiles"
  FOR EACH ROW
  EXECUTE FUNCTION "esbla_append_hr_workforce_status_history"();--> statement-breakpoint
CREATE TRIGGER "hr_workforce_status_history_reject_update_delete"
  BEFORE UPDATE OR DELETE ON "hr_workforce_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION "esbla_reject_hr_workforce_status_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "hr_workforce_status_history_reject_truncate"
  BEFORE TRUNCATE ON "hr_workforce_status_history"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "esbla_reject_hr_workforce_status_history_mutation"();
