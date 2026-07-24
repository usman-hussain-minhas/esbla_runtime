CREATE TYPE "public"."hr_attendance_observation_kind" AS ENUM('presence_start', 'presence_end');--> statement-breakpoint
CREATE TYPE "public"."hr_attendance_source_kind" AS ENUM('manual', 'synthetic');--> statement-breakpoint
CREATE TABLE "hr_attendance_corrections" (
	"attendance_correction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attendance_observation_id" uuid NOT NULL,
	"corrected_observed_at" timestamp with time zone NOT NULL,
	"corrected_observation_kind" "hr_attendance_observation_kind" NOT NULL,
	"reason" text NOT NULL,
	"correction_version" integer NOT NULL,
	"supersedes_attendance_correction_id" uuid,
	"actor_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_hr_attendance_corrections_composite_identity" UNIQUE("tenant_id","attendance_observation_id","attendance_correction_id"),
	CONSTRAINT "hr_attendance_corrections_reason_valid" CHECK (char_length(trim("hr_attendance_corrections"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "hr_attendance_corrections_predecessor_version_consistent" CHECK (("hr_attendance_corrections"."correction_version" = 1
              AND "hr_attendance_corrections"."supersedes_attendance_correction_id" IS NULL)
          OR ("hr_attendance_corrections"."correction_version" > 1
              AND "hr_attendance_corrections"."supersedes_attendance_correction_id" IS NOT NULL)),
	CONSTRAINT "hr_attendance_corrections_version_positive" CHECK ("hr_attendance_corrections"."correction_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_attendance_corrections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_attendance_observations" (
	"attendance_observation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observation_kind" "hr_attendance_observation_kind" NOT NULL,
	"source_kind" "hr_attendance_source_kind" NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_attendance_observations_composite_identity" UNIQUE("tenant_id","attendance_observation_id"),
	CONSTRAINT "hr_attendance_observations_row_version_fixed" CHECK ("hr_attendance_observations"."row_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_attendance_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_attendance_service_control" (
	"service_control_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_key" text DEFAULT 'attendance' NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_attendance_service_control_key_exact" CHECK ("hr_attendance_service_control"."service_key" = 'attendance'),
	CONSTRAINT "hr_attendance_service_control_settings_version_positive" CHECK ("hr_attendance_service_control"."settings_version" > 0),
	CONSTRAINT "hr_attendance_service_control_row_version_positive" CHECK ("hr_attendance_service_control"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_attendance_service_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_attendance_corrections" ADD CONSTRAINT "hr_attendance_corrections_observation_same_tenant_fk" FOREIGN KEY ("tenant_id","attendance_observation_id") REFERENCES "public"."hr_attendance_observations"("tenant_id","attendance_observation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_corrections" ADD CONSTRAINT "hr_attendance_corrections_predecessor_same_root_fk" FOREIGN KEY ("tenant_id","attendance_observation_id","supersedes_attendance_correction_id") REFERENCES "public"."hr_attendance_corrections"("tenant_id","attendance_observation_id","attendance_correction_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_corrections" ADD CONSTRAINT "hr_attendance_corrections_actor_same_tenant_fk" FOREIGN KEY ("tenant_id","actor_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_observations" ADD CONSTRAINT "hr_attendance_observations_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_observations" ADD CONSTRAINT "hr_attendance_observations_worker_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_observations" ADD CONSTRAINT "hr_attendance_observations_actor_same_tenant_fk" FOREIGN KEY ("tenant_id","actor_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_service_control" ADD CONSTRAINT "hr_attendance_service_control_activation_fk" FOREIGN KEY ("tenant_id","service_key") REFERENCES "public"."service_activations"("tenant_id","service_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hr_attendance_corrections_tenant_observation_version" ON "hr_attendance_corrections" USING btree ("tenant_id","attendance_observation_id","correction_version" DESC NULLS LAST,"attendance_correction_id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_attendance_corrections_tenant_observation_version" ON "hr_attendance_corrections" USING btree ("tenant_id","attendance_observation_id","correction_version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_attendance_corrections_tenant_successor" ON "hr_attendance_corrections" USING btree ("tenant_id","supersedes_attendance_correction_id") WHERE "hr_attendance_corrections"."supersedes_attendance_correction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_hr_attendance_observations_tenant_worker_observed" ON "hr_attendance_observations" USING btree ("tenant_id","worker_profile_id","observed_at" DESC NULLS LAST,"attendance_observation_id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_attendance_service_control_tenant_key" ON "hr_attendance_service_control" USING btree ("tenant_id","service_key");--> statement-breakpoint
ALTER TABLE "hr_attendance_corrections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_attendance_corrections_tenant_isolation"
  ON "hr_attendance_corrections"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_attendance_observations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_attendance_observations_tenant_isolation"
  ON "hr_attendance_observations"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_attendance_service_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_attendance_service_control_tenant_isolation"
  ON "hr_attendance_service_control"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_attendance_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'attendance service control cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.pg_trigger_depth() <> 2
       OR NEW.service_key <> 'attendance'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid attendance service control creation'
        USING ERRCODE = '55000';
    END IF;
    SELECT activation.state, activation.version
      INTO authority_state, authority_version
      FROM public.service_activations AS activation
      WHERE activation.tenant_id = NEW.tenant_id
        AND activation.service_key = NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'attendance activation authority is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.service_control_id, NEW.tenant_id, NEW.service_key)
     IS DISTINCT FROM
     (OLD.service_control_id, OLD.tenant_id, OLD.service_key)
     OR NEW.row_version <> OLD.row_version + 1
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'invalid attendance service control revision'
      USING ERRCODE = '55000';
  END IF;
  SELECT activation.state, activation.version
    INTO authority_state, authority_version
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance activation authority is missing'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.settings_version = OLD.settings_version THEN
    IF pg_catalog.pg_trigger_depth() <> 2 THEN
      RAISE EXCEPTION 'attendance activation revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.settings_version = OLD.settings_version + 1 THEN
    IF pg_catalog.pg_trigger_depth() <> 1 OR authority_state <> 'active' THEN
      RAISE EXCEPTION 'attendance settings revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'attendance settings version is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_attendance_service_control"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_attendance_service_control_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_attendance_service_control"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_attendance_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_attendance_service_control_reject_truncate"
  BEFORE TRUNCATE ON "hr_attendance_service_control"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_attendance_service_control"();--> statement-breakpoint
CREATE FUNCTION "esbla_sync_hr_attendance_service_activation"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  synchronized_rows integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'attendance' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'invalid initial attendance activation authority'
        USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.hr_attendance_service_control
      (tenant_id, service_key, settings_version, updated_at, row_version)
    VALUES
      (NEW.tenant_id, NEW.service_key, 1, pg_catalog.statement_timestamp(), 1);
    RETURN NEW;
  END IF;
  IF OLD.service_key <> 'attendance' AND NEW.service_key <> 'attendance' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.service_key <> 'attendance'
     OR NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid attendance activation authority transition'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.hr_attendance_service_control AS control
    SET updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          control.updated_at + interval '1 microsecond'
        ),
        row_version = control.row_version + 1
    WHERE control.tenant_id = NEW.tenant_id
      AND control.service_key = NEW.service_key;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'attendance service control projection is missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_sync_hr_attendance_service_activation"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "service_activations_sync_hr_attendance"
  AFTER INSERT OR UPDATE ON "service_activations"
  FOR EACH ROW EXECUTE FUNCTION "esbla_sync_hr_attendance_service_activation"();--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_attendance_observation"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  actor_text text;
  correlation_text text;
  governed_actor_id uuid;
  governed_correlation_id uuid;
  governed_tenant_id uuid;
  tenant_text text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'attendance observations cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'attendance observations are immutable'
      USING ERRCODE = '55000';
  END IF;
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  correlation_text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
    governed_correlation_id := correlation_text::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'attendance observation authority is denied'
      USING ERRCODE = '42501';
  END;
  IF NEW.tenant_id IS DISTINCT FROM governed_tenant_id THEN
    RAISE EXCEPTION 'attendance observation authority is denied'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'attendance'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance service is inactive'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.memberships AS membership
    JOIN public.membership_capabilities AS capability
      ON capability.tenant_id = membership.tenant_id
     AND capability.principal_id = membership.principal_id
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = governed_actor_id
      AND membership.status = 'active'
      AND (
        (NEW.source_kind = 'manual'
         AND membership.role_key = 'hr_operator'
         AND capability.capability_id = 'hr.attendance.record_manual')
        OR
        (NEW.source_kind = 'synthetic'
         AND membership.role_key = 'system'
         AND capability.capability_id = 'hr.attendance.record_synthetic_test')
      )
    FOR SHARE OF membership;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance observation authority is denied'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.hr_worker_profiles AS worker
    WHERE worker.tenant_id = governed_tenant_id
      AND worker.worker_profile_id = NEW.worker_profile_id
      AND worker.workforce_status = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance observation worker is unavailable'
      USING ERRCODE = '55000';
  END IF;
  NEW.attendance_observation_id := pg_catalog.gen_random_uuid();
  NEW.actor_principal_id := governed_actor_id;
  NEW.correlation_id := governed_correlation_id;
  NEW.created_at := pg_catalog.statement_timestamp();
  NEW.row_version := 1;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_attendance_observation"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_attendance_observations_enforce_append"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_attendance_observations"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_attendance_observation"();--> statement-breakpoint
CREATE TRIGGER "hr_attendance_observations_reject_truncate"
  BEFORE TRUNCATE ON "hr_attendance_observations"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_attendance_observation"();--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_attendance_correction"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  actor_text text;
  current_correction_id uuid;
  current_correction_version integer;
  governed_actor_id uuid;
  governed_tenant_id uuid;
  tenant_text text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'attendance corrections cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'attendance corrections are immutable'
      USING ERRCODE = '55000';
  END IF;
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'attendance correction authority is denied'
      USING ERRCODE = '42501';
  END;
  IF NEW.tenant_id IS DISTINCT FROM governed_tenant_id THEN
    RAISE EXCEPTION 'attendance correction authority is denied'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'attendance'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance service is inactive'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.memberships AS membership
    JOIN public.membership_capabilities AS capability
      ON capability.tenant_id = membership.tenant_id
     AND capability.principal_id = membership.principal_id
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = governed_actor_id
      AND membership.status = 'active'
      AND membership.role_key = 'hr_operator'
      AND capability.capability_id = 'hr.attendance.correct'
    FOR SHARE OF membership;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance correction authority is denied'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.hr_attendance_observations AS observation
    WHERE observation.tenant_id = governed_tenant_id
      AND observation.attendance_observation_id = NEW.attendance_observation_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance observation is unavailable'
      USING ERRCODE = '55000';
  END IF;
  SELECT correction.attendance_correction_id, correction.correction_version
    INTO current_correction_id, current_correction_version
    FROM public.hr_attendance_corrections AS correction
    WHERE correction.tenant_id = governed_tenant_id
      AND correction.attendance_observation_id = NEW.attendance_observation_id
    ORDER BY correction.correction_version DESC, correction.attendance_correction_id DESC
    LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN
    IF NEW.correction_version <> 1
       OR NEW.supersedes_attendance_correction_id IS NOT NULL THEN
      RAISE EXCEPTION 'attendance correction predecessor is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.correction_version <> current_correction_version + 1
        OR NEW.supersedes_attendance_correction_id IS DISTINCT FROM current_correction_id THEN
    RAISE EXCEPTION 'attendance correction predecessor is invalid'
      USING ERRCODE = '55000';
  END IF;
  NEW.attendance_correction_id := pg_catalog.gen_random_uuid();
  NEW.actor_principal_id := governed_actor_id;
  NEW.created_at := pg_catalog.statement_timestamp();
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_attendance_correction"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_attendance_corrections_enforce_append"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_attendance_corrections"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_attendance_correction"();--> statement-breakpoint
CREATE TRIGGER "hr_attendance_corrections_reject_truncate"
  BEFORE TRUNCATE ON "hr_attendance_corrections"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_attendance_correction"();--> statement-breakpoint
CREATE FUNCTION "esbla_configure_hr_attendance_settings"(
  integer,
  text,
  boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  expected_settings_version ALIAS FOR $1;
  manual_observation_kinds ALIAS FOR $2;
  correction_note_required ALIAS FOR $3;
  actor_text text;
  changed_rows integer;
  current_settings_version integer;
  governed_actor_id uuid;
  governed_tenant_id uuid;
  prior_settings jsonb;
  setting_count integer;
  tenant_text text;
BEGIN
  IF expected_settings_version IS NULL OR expected_settings_version <= 0
     OR manual_observation_kinds IS NULL
     OR manual_observation_kinds NOT IN (
       '', 'presence_start', 'presence_end', 'presence_start,presence_end'
     )
     OR correction_note_required IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'attendance settings input is invalid'
      USING ERRCODE = '22023';
  END IF;
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'attendance settings authority is denied'
      USING ERRCODE = '42501';
  END;
  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'attendance'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance service is inactive'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.memberships AS membership
    JOIN public.membership_capabilities AS capability
      ON capability.tenant_id = membership.tenant_id
     AND capability.principal_id = membership.principal_id
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = governed_actor_id
      AND membership.status = 'active'
      AND membership.role_key = 'tenant_admin'
      AND capability.capability_id = 'hr.attendance.configure_service'
    FOR SHARE OF membership;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance settings authority is denied'
      USING ERRCODE = '42501';
  END IF;
  SELECT control.settings_version
    INTO current_settings_version
    FROM public.hr_attendance_service_control AS control
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'attendance'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance service control is missing'
      USING ERRCODE = '55000';
  END IF;
  IF current_settings_version <> expected_settings_version THEN
    RAISE EXCEPTION 'attendance settings version conflict'
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
        'hr.attendance.correction_note_required',
        'hr.attendance.manual_observation_kinds'
      ]);
  IF expected_settings_version = 1 THEN
    IF setting_count <> 0 THEN
      RAISE EXCEPTION 'attendance settings state is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSIF setting_count <> 2
     OR prior_settings #>> '{hr.attendance.correction_note_required,type}' <> 'boolean'
     OR prior_settings #>> '{hr.attendance.manual_observation_kinds,type}' <> 'text'
     OR (prior_settings #>> '{hr.attendance.correction_note_required,version}')::integer
          <> expected_settings_version - 1
     OR (prior_settings #>> '{hr.attendance.manual_observation_kinds,version}')::integer
          <> expected_settings_version - 1
     OR (prior_settings #>> '{hr.attendance.correction_note_required,value}')::boolean
          IS DISTINCT FROM true
     OR prior_settings #>> '{hr.attendance.manual_observation_kinds,value}' NOT IN (
       '', 'presence_start', 'presence_end', 'presence_start,presence_end'
     ) THEN
    RAISE EXCEPTION 'attendance settings state is inconsistent'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.attendance.correction_note_required',
      'boolean',
      pg_catalog.to_jsonb(correction_note_required),
      1,
      pg_catalog.statement_timestamp()
    ),
    (
      governed_tenant_id,
      'hr.attendance.manual_observation_kinds',
      'text',
      pg_catalog.to_jsonb(manual_observation_kinds),
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
    RAISE EXCEPTION 'attendance settings version conflict'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.hr_attendance_service_control AS control
    SET settings_version = control.settings_version + 1,
        row_version = control.row_version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(), control.updated_at + interval '1 microsecond'
        )
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'attendance'
      AND control.settings_version = expected_settings_version;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'attendance settings version conflict'
      USING ERRCODE = '40001';
  END IF;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_configure_hr_attendance_settings"(
  integer, text, boolean
) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "esbla_configure_hr_attendance_settings"(
  integer, text, boolean
) TO "esbla_app";--> statement-breakpoint
GRANT USAGE ON TYPE "hr_attendance_observation_kind", "hr_attendance_source_kind"
  TO "esbla_app";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "hr_attendance_corrections",
  "hr_attendance_observations",
  "hr_attendance_service_control"
  FROM PUBLIC, "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "hr_attendance_corrections",
  "hr_attendance_observations"
  TO "esbla_app";--> statement-breakpoint
GRANT SELECT ON TABLE "hr_attendance_service_control" TO "esbla_app";
