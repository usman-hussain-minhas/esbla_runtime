CREATE TYPE "public"."hr_shift_assignment_status" AS ENUM('active', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."hr_shift_roster_status" AS ENUM('draft', 'published', 'superseded');--> statement-breakpoint
CREATE TABLE "hr_shift_assignment_service_control" (
	"service_control_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_key" text DEFAULT 'shift_assignment' NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_shift_assignment_service_control_key_exact" CHECK ("hr_shift_assignment_service_control"."service_key" = 'shift_assignment'),
	CONSTRAINT "hr_shift_assignment_service_control_settings_version_positive" CHECK ("hr_shift_assignment_service_control"."settings_version" > 0),
	CONSTRAINT "hr_shift_assignment_service_control_row_version_positive" CHECK ("hr_shift_assignment_service_control"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_shift_assignment_service_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_shift_assignments" (
	"shift_assignment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"roster_version_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"iana_timezone" text NOT NULL,
	"status" "hr_shift_assignment_status" DEFAULT 'active' NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_shift_assignments_composite_identity" UNIQUE("tenant_id","shift_assignment_id"),
	CONSTRAINT "hr_shift_assignments_time_range_valid" CHECK ("hr_shift_assignments"."ends_at" > "hr_shift_assignments"."starts_at"),
	CONSTRAINT "hr_shift_assignments_iana_timezone_not_blank" CHECK (char_length(trim("hr_shift_assignments"."iana_timezone")) > 0),
	CONSTRAINT "hr_shift_assignments_row_version_positive" CHECK ("hr_shift_assignments"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_shift_roster_versions" (
	"roster_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "hr_shift_roster_status" DEFAULT 'draft' NOT NULL,
	"version" integer NOT NULL,
	"supersedes_roster_version_id" uuid,
	"published_at" timestamp with time zone,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_shift_roster_versions_composite_identity" UNIQUE("tenant_id","roster_version_id"),
	CONSTRAINT "hr_shift_roster_versions_period_valid" CHECK ("hr_shift_roster_versions"."period_end" >= "hr_shift_roster_versions"."period_start"),
	CONSTRAINT "hr_shift_roster_versions_publication_consistent" CHECK (("hr_shift_roster_versions"."status" = 'draft' AND "hr_shift_roster_versions"."published_at" IS NULL
             AND "hr_shift_roster_versions"."supersedes_roster_version_id" IS NULL)
          OR ("hr_shift_roster_versions"."status" IN ('published', 'superseded') AND "hr_shift_roster_versions"."published_at" IS NOT NULL)),
	CONSTRAINT "hr_shift_roster_versions_version_positive" CHECK ("hr_shift_roster_versions"."version" > 0),
	CONSTRAINT "hr_shift_roster_versions_row_version_positive" CHECK ("hr_shift_roster_versions"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_shift_roster_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_shift_assignment_service_control" ADD CONSTRAINT "hr_shift_assignment_service_control_activation_fk" FOREIGN KEY ("tenant_id","service_key") REFERENCES "public"."service_activations"("tenant_id","service_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ADD CONSTRAINT "hr_shift_assignments_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ADD CONSTRAINT "hr_shift_assignments_roster_same_tenant_fk" FOREIGN KEY ("tenant_id","roster_version_id") REFERENCES "public"."hr_shift_roster_versions"("tenant_id","roster_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ADD CONSTRAINT "hr_shift_assignments_worker_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_roster_versions" ADD CONSTRAINT "hr_shift_roster_versions_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_roster_versions" ADD CONSTRAINT "hr_shift_roster_versions_predecessor_same_tenant_fk" FOREIGN KEY ("tenant_id","supersedes_roster_version_id") REFERENCES "public"."hr_shift_roster_versions"("tenant_id","roster_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_shift_assignment_service_control_tenant_key" ON "hr_shift_assignment_service_control" USING btree ("tenant_id","service_key");--> statement-breakpoint
CREATE INDEX "idx_hr_shift_assignments_tenant_worker_start" ON "hr_shift_assignments" USING btree ("tenant_id","worker_profile_id","starts_at","shift_assignment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_shift_assignments_tenant_roster_status_start" ON "hr_shift_assignments" USING btree ("tenant_id","roster_version_id","status","starts_at","shift_assignment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_shift_assignments_tenant_worker_overlap" ON "hr_shift_assignments" USING btree ("tenant_id","worker_profile_id","status","starts_at","shift_assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_shift_roster_versions_tenant_period_version" ON "hr_shift_roster_versions" USING btree ("tenant_id","period_start","period_end","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_shift_rosters_tenant_period_published" ON "hr_shift_roster_versions" USING btree ("tenant_id","period_start","period_end","status") WHERE "hr_shift_roster_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_shift_rosters_tenant_period_successor" ON "hr_shift_roster_versions" USING btree ("tenant_id","period_start","period_end","supersedes_roster_version_id") WHERE "hr_shift_roster_versions"."supersedes_roster_version_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_shift_assignment_service_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_shift_assignment_service_control_tenant_isolation"
  ON "hr_shift_assignment_service_control"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_shift_assignments_tenant_isolation"
  ON "hr_shift_assignments"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_shift_roster_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_shift_roster_versions_tenant_isolation"
  ON "hr_shift_roster_versions"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_shift_assignment_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'shift assignment service control cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.pg_trigger_depth() <> 2
       OR NEW.service_key <> 'shift_assignment'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid shift assignment service control creation'
        USING ERRCODE = '55000';
    END IF;
    SELECT activation.state, activation.version
      INTO authority_state, authority_version
      FROM public.service_activations AS activation
      WHERE activation.tenant_id = NEW.tenant_id
        AND activation.service_key = NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'shift assignment activation authority is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.service_control_id, NEW.tenant_id, NEW.service_key)
     IS DISTINCT FROM
     (OLD.service_control_id, OLD.tenant_id, OLD.service_key) THEN
    RAISE EXCEPTION 'immutable shift assignment service control fields changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'invalid shift assignment service control revision'
      USING ERRCODE = '55000';
  END IF;

  SELECT activation.state, activation.version
    INTO authority_state, authority_version
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift assignment activation authority is missing'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.settings_version = OLD.settings_version THEN
    IF pg_catalog.pg_trigger_depth() <> 2 THEN
      RAISE EXCEPTION 'shift assignment activation revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.settings_version = OLD.settings_version + 1 THEN
    IF pg_catalog.pg_trigger_depth() <> 1 OR authority_state <> 'active' THEN
      RAISE EXCEPTION 'shift assignment settings revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'shift assignment settings version is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_shift_assignment_service_control"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_shift_assignment_service_control_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_shift_assignment_service_control"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_shift_assignment_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_shift_assignment_service_control_reject_truncate"
  BEFORE TRUNCATE ON "hr_shift_assignment_service_control"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_shift_assignment_service_control"();--> statement-breakpoint
CREATE FUNCTION "esbla_sync_hr_shift_assignment_service_activation"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  synchronized_rows integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'shift_assignment' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'invalid initial shift assignment activation authority'
        USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.hr_shift_assignment_service_control
      (tenant_id, service_key, settings_version, updated_at, row_version)
    VALUES
      (NEW.tenant_id, NEW.service_key, 1, pg_catalog.statement_timestamp(), 1);
    RETURN NEW;
  END IF;

  IF OLD.service_key <> 'shift_assignment' AND NEW.service_key <> 'shift_assignment' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.service_key <> 'shift_assignment'
     OR NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid shift assignment activation authority transition'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.hr_shift_assignment_service_control AS control
    SET updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          control.updated_at + interval '1 microsecond'
        ),
        row_version = control.row_version + 1
    WHERE control.tenant_id = NEW.tenant_id
      AND control.service_key = NEW.service_key;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'shift assignment service control projection is missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_sync_hr_shift_assignment_service_activation"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "service_activations_sync_hr_shift_assignment"
  AFTER INSERT OR UPDATE ON "service_activations"
  FOR EACH ROW EXECUTE FUNCTION "esbla_sync_hr_shift_assignment_service_activation"();--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_shift_roster_version"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  predecessor_period_end date;
  predecessor_period_start date;
  predecessor_status public.hr_shift_roster_status;
  predecessor_version integer;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shift roster versions cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shift roster versions cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'shift_assignment'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift assignment service is inactive'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft'
       OR NEW.supersedes_roster_version_id IS NOT NULL
       OR NEW.published_at IS NOT NULL
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'shift roster must begin as draft version 1'
        USING ERRCODE = '55000';
    END IF;
    NEW.roster_version_id := pg_catalog.gen_random_uuid();
    RETURN NEW;
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'superseded shift rosters are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.roster_version_id, NEW.tenant_id, NEW.period_start, NEW.period_end, NEW.version)
     IS DISTINCT FROM
     (OLD.roster_version_id, OLD.tenant_id, OLD.period_start, OLD.period_end, OLD.version)
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'shift roster immutable fields changed'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'published' THEN
      RAISE EXCEPTION 'shift roster transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.supersedes_roster_version_id IS NULL THEN
      IF NEW.version <> 1 OR EXISTS (
        SELECT 1
          FROM public.hr_shift_roster_versions AS roster
          WHERE roster.tenant_id = NEW.tenant_id
            AND roster.period_start = NEW.period_start
            AND roster.period_end = NEW.period_end
            AND roster.roster_version_id <> NEW.roster_version_id
      ) THEN
        RAISE EXCEPTION 'initial shift roster publication is invalid'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      SELECT predecessor.period_start, predecessor.period_end,
             predecessor.status, predecessor.version
        INTO predecessor_period_start, predecessor_period_end,
             predecessor_status, predecessor_version
        FROM public.hr_shift_roster_versions AS predecessor
        WHERE predecessor.tenant_id = NEW.tenant_id
          AND predecessor.roster_version_id = NEW.supersedes_roster_version_id
        FOR SHARE;
      IF NOT FOUND
         OR predecessor_period_start IS DISTINCT FROM NEW.period_start
         OR predecessor_period_end IS DISTINCT FROM NEW.period_end
         OR predecessor_status <> 'superseded'
         OR NEW.version <> predecessor_version + 1 THEN
        RAISE EXCEPTION 'shift roster predecessor is invalid'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    NEW.published_at := pg_catalog.statement_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status <> 'superseded'
       OR NEW.supersedes_roster_version_id IS DISTINCT FROM OLD.supersedes_roster_version_id
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'published shift roster transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'shift roster transition is invalid'
    USING ERRCODE = '55000';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_shift_roster_version"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "esbla_require_hr_shift_roster_successor"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'superseded' AND NOT EXISTS (
    SELECT 1
      FROM public.hr_shift_roster_versions AS successor
      WHERE successor.tenant_id = NEW.tenant_id
        AND successor.period_start = NEW.period_start
        AND successor.period_end = NEW.period_end
        AND successor.supersedes_roster_version_id = NEW.roster_version_id
        AND successor.status = 'published'
  ) THEN
    RAISE EXCEPTION 'superseded shift roster requires its unique published successor'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_require_hr_shift_roster_successor"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_shift_roster_versions_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_shift_roster_versions"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_shift_roster_version"();--> statement-breakpoint
CREATE TRIGGER "hr_shift_roster_versions_reject_truncate"
  BEFORE TRUNCATE ON "hr_shift_roster_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_shift_roster_version"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "hr_shift_roster_versions_require_successor"
  AFTER UPDATE OF status ON "hr_shift_roster_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "esbla_require_hr_shift_roster_successor"();--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_shift_assignment"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'shift assignments cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shift assignments cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'shift_assignment'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift assignment service is inactive'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.hr_shift_roster_versions AS roster
      WHERE roster.tenant_id = NEW.tenant_id
        AND roster.roster_version_id = NEW.roster_version_id
        AND roster.status = 'draft'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'shift assignment requires a draft roster'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
      FROM public.hr_worker_profiles AS worker
      WHERE worker.tenant_id = NEW.tenant_id
        AND worker.worker_profile_id = NEW.worker_profile_id
        AND worker.workforce_status = 'active'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'shift assignment worker is unavailable'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
      FROM pg_catalog.pg_timezone_names AS zone
      WHERE zone.name = NEW.iana_timezone;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'shift assignment timezone is invalid'
        USING ERRCODE = '22023';
    END IF;
    IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'shift assignment initial state is invalid'
        USING ERRCODE = '55000';
    END IF;
    NEW.shift_assignment_id := pg_catalog.gen_random_uuid();
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled shift assignments are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.shift_assignment_id, NEW.tenant_id, NEW.roster_version_id,
      NEW.worker_profile_id, NEW.starts_at, NEW.ends_at, NEW.iana_timezone)
     IS DISTINCT FROM
     (OLD.shift_assignment_id, OLD.tenant_id, OLD.roster_version_id,
      OLD.worker_profile_id, OLD.starts_at, OLD.ends_at, OLD.iana_timezone)
     OR NEW.status <> 'cancelled'
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'shift assignment transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_shift_assignment"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_shift_assignments_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_shift_assignments"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_shift_assignment"();--> statement-breakpoint
CREATE TRIGGER "hr_shift_assignments_reject_truncate"
  BEFORE TRUNCATE ON "hr_shift_assignments"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_shift_assignment"();--> statement-breakpoint
CREATE FUNCTION "esbla_configure_hr_shift_assignment_settings"(
  integer,
  integer,
  boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  expected_settings_version ALIAS FOR $1;
  roster_horizon_days ALIAS FOR $2;
  overlap_allowed ALIAS FOR $3;
  tenant_text text;
  actor_text text;
  governed_tenant_id uuid;
  governed_actor_id uuid;
  current_settings_version integer;
  prior_settings jsonb;
  setting_count integer;
  changed_rows integer;
BEGIN
  IF expected_settings_version IS NULL OR expected_settings_version <= 0
     OR roster_horizon_days IS NULL OR roster_horizon_days < 1 OR roster_horizon_days > 31
     OR overlap_allowed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'shift assignment settings input is invalid'
      USING ERRCODE = '22023';
  END IF;

  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  IF tenant_text IS NULL OR actor_text IS NULL
     OR tenant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'shift assignment settings authority is denied'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'shift assignment settings authority is denied'
      USING ERRCODE = '42501';
  END;

  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'shift_assignment'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift assignment service is inactive'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.memberships AS membership
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = governed_actor_id
      AND membership.status = 'active'
      AND membership.role_key = 'tenant_admin'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift assignment settings authority is denied'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.membership_capabilities AS capability
    WHERE capability.tenant_id = governed_tenant_id
      AND capability.principal_id = governed_actor_id
      AND capability.capability_id = 'hr.shift.configure_service'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift assignment settings authority is denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT control.settings_version
    INTO current_settings_version
    FROM public.hr_shift_assignment_service_control AS control
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'shift_assignment'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift assignment service control is missing'
      USING ERRCODE = '55000';
  END IF;
  IF current_settings_version <> expected_settings_version THEN
    RAISE EXCEPTION 'shift assignment settings version conflict'
      USING ERRCODE = '40001';
  END IF;

  SELECT pg_catalog.count(*)::integer,
         COALESCE(pg_catalog.jsonb_object_agg(
           setting.setting_key,
           pg_catalog.jsonb_build_object(
             'type', setting.value_type::text,
             'value', setting.value,
             'version', setting.version
           )
         ), '{}'::jsonb)
    INTO setting_count, prior_settings
    FROM public.tenant_settings AS setting
    WHERE setting.tenant_id = governed_tenant_id
      AND setting.setting_key = ANY(ARRAY[
        'hr.shift_assignment.overlap_allowed',
        'hr.shift_assignment.roster_horizon_days'
      ]);
  IF expected_settings_version = 1 THEN
    IF setting_count <> 0 THEN
      RAISE EXCEPTION 'shift assignment settings state is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF setting_count <> 2
       OR prior_settings #>> '{hr.shift_assignment.overlap_allowed,type}' <> 'boolean'
       OR prior_settings #>> '{hr.shift_assignment.roster_horizon_days,type}' <> 'integer'
       OR (prior_settings #>> '{hr.shift_assignment.overlap_allowed,version}')::integer
            <> expected_settings_version - 1
       OR (prior_settings #>> '{hr.shift_assignment.roster_horizon_days,version}')::integer
            <> expected_settings_version - 1
       OR pg_catalog.jsonb_typeof(
            prior_settings #> '{hr.shift_assignment.overlap_allowed,value}'
          ) <> 'boolean'
       OR pg_catalog.jsonb_typeof(
            prior_settings #> '{hr.shift_assignment.roster_horizon_days,value}'
          ) <> 'number'
       OR (prior_settings #>> '{hr.shift_assignment.overlap_allowed,value}')::boolean
            IS DISTINCT FROM false
       OR (prior_settings #>> '{hr.shift_assignment.roster_horizon_days,value}')::integer
            NOT BETWEEN 1 AND 31 THEN
      RAISE EXCEPTION 'shift assignment settings state is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.shift_assignment.overlap_allowed',
      'boolean',
      pg_catalog.to_jsonb(overlap_allowed),
      1,
      pg_catalog.statement_timestamp()
    ),
    (
      governed_tenant_id,
      'hr.shift_assignment.roster_horizon_days',
      'integer',
      pg_catalog.to_jsonb(roster_horizon_days),
      1,
      pg_catalog.statement_timestamp()
    )
  ON CONFLICT (tenant_id, setting_key) DO UPDATE
    SET value_type = EXCLUDED.value_type,
        value = EXCLUDED.value,
        version = setting.version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(), setting.updated_at + interval '1 microsecond'
        )
    WHERE setting.version = expected_settings_version - 1;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 2 THEN
    RAISE EXCEPTION 'shift assignment settings version conflict'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.hr_shift_assignment_service_control AS control
    SET settings_version = control.settings_version + 1,
        row_version = control.row_version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(), control.updated_at + interval '1 microsecond'
        )
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'shift_assignment'
      AND control.settings_version = expected_settings_version;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'shift assignment settings version conflict'
      USING ERRCODE = '40001';
  END IF;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_configure_hr_shift_assignment_settings"(
  integer, integer, boolean
) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "esbla_configure_hr_shift_assignment_settings"(
  integer, integer, boolean
) TO "esbla_app";--> statement-breakpoint
GRANT USAGE ON TYPE "hr_shift_assignment_status", "hr_shift_roster_status"
  TO "esbla_app";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "hr_shift_assignment_service_control"
  FROM PUBLIC, "esbla_app";--> statement-breakpoint
REVOKE SELECT (
    service_control_id, tenant_id, service_key, settings_version, updated_at, row_version
  ),
  INSERT (
    service_control_id, tenant_id, service_key, settings_version, updated_at, row_version
  ),
  UPDATE (
    service_control_id, tenant_id, service_key, settings_version, updated_at, row_version
  ),
  REFERENCES (
    service_control_id, tenant_id, service_key, settings_version, updated_at, row_version
  )
  ON TABLE "hr_shift_assignment_service_control" FROM PUBLIC, "esbla_app";--> statement-breakpoint
GRANT SELECT ON TABLE "hr_shift_assignment_service_control" TO "esbla_app";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "hr_shift_assignments", "hr_shift_roster_versions"
  FROM PUBLIC, "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "hr_shift_assignments", "hr_shift_roster_versions"
  TO "esbla_app";
