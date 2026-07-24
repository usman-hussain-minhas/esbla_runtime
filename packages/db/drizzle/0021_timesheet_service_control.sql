CREATE OR REPLACE FUNCTION "esbla_enforce_hr_timesheet_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'timesheet service control cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.pg_trigger_depth() <> 2
       OR NEW.service_key <> 'timesheet'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid timesheet service control creation'
        USING ERRCODE = '55000';
    END IF;
    SELECT activation.state, activation.version
      INTO authority_state, authority_version
      FROM public.service_activations AS activation
      WHERE activation.tenant_id = NEW.tenant_id
        AND activation.service_key = NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'timesheet activation authority is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.service_control_id, NEW.tenant_id, NEW.service_key)
     IS DISTINCT FROM
     (OLD.service_control_id, OLD.tenant_id, OLD.service_key)
     OR NEW.row_version <> OLD.row_version + 1
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'invalid timesheet service control revision'
      USING ERRCODE = '55000';
  END IF;
  SELECT activation.state, activation.version
    INTO authority_state, authority_version
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'timesheet activation authority is missing'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.settings_version = OLD.settings_version THEN
    IF pg_catalog.pg_trigger_depth() <> 2 THEN
      RAISE EXCEPTION 'timesheet activation revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.settings_version = OLD.settings_version + 1 THEN
    IF pg_catalog.pg_trigger_depth() <> 1 OR authority_state <> 'active' THEN
      RAISE EXCEPTION 'timesheet settings revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'timesheet settings version is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_timesheet_service_control"() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "esbla_hr_timesheet_service_admin_current"(text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  action_key ALIAS FOR $1;
  actor_text text;
  authority_current boolean;
  governed_actor_id uuid;
  governed_tenant_id uuid;
  tenant_text text;
BEGIN
  IF action_key NOT IN (
    'hr.timesheet.activate_service',
    'hr.timesheet.configure_service',
    'hr.timesheet.deactivate_service',
    'hr.timesheet.view_service_control'
  ) THEN
    RETURN false;
  END IF;
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RETURN false;
  END;
  SELECT true
    INTO authority_current
    FROM public.memberships AS membership
    JOIN public.membership_capabilities AS capability
      ON capability.tenant_id = membership.tenant_id
     AND capability.principal_id = membership.principal_id
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = governed_actor_id
      AND membership.status = 'active'
      AND membership.role_key = 'tenant_admin'
      AND capability.capability_id = action_key
    FOR SHARE OF membership, capability;
  RETURN COALESCE(authority_current, false);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_hr_timesheet_service_admin_current"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "esbla_hr_timesheet_service_admin_current"(text) TO "esbla_app";
--> statement-breakpoint
CREATE FUNCTION "esbla_configure_hr_timesheet_settings"(
  integer,
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
  max_daily_minutes ALIAS FOR $2;
  period_cadence ALIAS FOR $3;
  rejection_note_required ALIAS FOR $4;
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
     OR max_daily_minutes IS NULL OR max_daily_minutes NOT BETWEEN 1 AND 1440
     OR period_cadence IS DISTINCT FROM 'weekly'
     OR rejection_note_required IS NULL THEN
    RAISE EXCEPTION 'timesheet settings input is invalid'
      USING ERRCODE = '22023';
  END IF;
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'timesheet settings authority is denied'
      USING ERRCODE = '42501';
  END;
  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'timesheet'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'timesheet service is inactive'
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
      AND capability.capability_id = 'hr.timesheet.configure_service'
    FOR SHARE OF membership, capability;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'timesheet settings authority is denied'
      USING ERRCODE = '42501';
  END IF;
  SELECT control.settings_version
    INTO current_settings_version
    FROM public.hr_timesheet_service_control AS control
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'timesheet'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'timesheet service control is missing'
      USING ERRCODE = '55000';
  END IF;
  IF current_settings_version <> expected_settings_version THEN
    RAISE EXCEPTION 'timesheet settings version conflict'
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
        'hr.timesheet.max_daily_minutes',
        'hr.timesheet.period_cadence',
        'hr.timesheet.rejection_note_required'
      ]);
  IF expected_settings_version = 1 THEN
    IF setting_count <> 0 THEN
      RAISE EXCEPTION 'timesheet settings state is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSIF setting_count <> 3
     OR prior_settings #>> '{hr.timesheet.max_daily_minutes,type}' <> 'integer'
     OR prior_settings #>> '{hr.timesheet.period_cadence,type}' <> 'enum'
     OR prior_settings #>> '{hr.timesheet.rejection_note_required,type}' <> 'boolean'
     OR (prior_settings #>> '{hr.timesheet.max_daily_minutes,version}')::integer
          <> expected_settings_version - 1
     OR (prior_settings #>> '{hr.timesheet.period_cadence,version}')::integer
          <> expected_settings_version - 1
     OR (prior_settings #>> '{hr.timesheet.rejection_note_required,version}')::integer
          <> expected_settings_version - 1
     OR prior_settings #>> '{hr.timesheet.max_daily_minutes,value}' IS NULL
     OR (prior_settings #>> '{hr.timesheet.max_daily_minutes,value}')::integer
          NOT BETWEEN 1 AND 1440
     OR prior_settings #>> '{hr.timesheet.period_cadence,value}' <> 'weekly'
     OR prior_settings #>> '{hr.timesheet.rejection_note_required,value}' IS NULL
     OR prior_settings #>> '{hr.timesheet.rejection_note_required,value}' NOT IN ('true', 'false')
  THEN
    RAISE EXCEPTION 'timesheet settings state is inconsistent'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.timesheet.max_daily_minutes',
      'integer',
      pg_catalog.to_jsonb(max_daily_minutes),
      1,
      pg_catalog.statement_timestamp()
    ),
    (
      governed_tenant_id,
      'hr.timesheet.period_cadence',
      'enum',
      pg_catalog.to_jsonb(period_cadence),
      1,
      pg_catalog.statement_timestamp()
    ),
    (
      governed_tenant_id,
      'hr.timesheet.rejection_note_required',
      'boolean',
      pg_catalog.to_jsonb(rejection_note_required),
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
  IF changed_rows <> 3 THEN
    RAISE EXCEPTION 'timesheet settings version conflict'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.hr_timesheet_service_control AS control
    SET settings_version = control.settings_version + 1,
        row_version = control.row_version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(), control.updated_at + interval '1 microsecond'
        )
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'timesheet'
      AND control.settings_version = expected_settings_version;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'timesheet settings version conflict'
      USING ERRCODE = '40001';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_configure_hr_timesheet_settings"(
  integer, integer, text, boolean
) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "esbla_configure_hr_timesheet_settings"(
  integer, integer, text, boolean
) TO "esbla_app";
--> statement-breakpoint
CREATE FUNCTION "esbla_protect_hr_timesheet_retention_evidence"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  evidence_owner text;
  reserved boolean;
BEGIN
  reserved :=
    NEW.subject_type = 'hr.timesheet.retention_qualification'
    OR NEW.subject_id = 'ce2fb833-0dff-8e0b-a54e-29b33022ac26'::uuid
    OR NEW.event_type = 'hr.timesheet.retention.qualified';
  IF NOT reserved THEN RETURN NEW; END IF;
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO evidence_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = TG_RELID;
  IF SESSION_USER IS DISTINCT FROM evidence_owner
     OR NEW.subject_type <> 'hr.timesheet.retention_qualification'
     OR NEW.subject_id <> 'ce2fb833-0dff-8e0b-a54e-29b33022ac26'::uuid
     OR NEW.event_type <> 'hr.timesheet.retention.qualified'
     OR NEW.prior_state IS NOT NULL
     OR NEW.new_state <> 'qualified' THEN
    RAISE EXCEPTION 'timesheet retention evidence requires protected exact authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_protect_hr_timesheet_retention_evidence"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "evidence_events_protect_hr_timesheet_retention"
  BEFORE INSERT ON "evidence_events"
  FOR EACH ROW EXECUTE FUNCTION "esbla_protect_hr_timesheet_retention_evidence"();
