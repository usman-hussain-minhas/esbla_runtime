CREATE OR REPLACE FUNCTION "public"."esbla_enforce_hr_workforce_profile_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'workforce profile service control cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.pg_trigger_depth() <> 2
       OR NEW.service_key <> 'workforce_profile'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid workforce profile service control creation'
        USING ERRCODE = '55000';
    END IF;

    SELECT activation.state, activation.version
      INTO authority_state, authority_version
      FROM public.service_activations AS activation
      WHERE activation.tenant_id = NEW.tenant_id
        AND activation.service_key = NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'workforce profile activation authority is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.service_control_id, NEW.tenant_id, NEW.service_key)
     IS DISTINCT FROM
     (OLD.service_control_id, OLD.tenant_id, OLD.service_key) THEN
    RAISE EXCEPTION 'immutable workforce profile service control fields changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'invalid workforce profile service control revision'
      USING ERRCODE = '55000';
  END IF;

  SELECT activation.state, activation.version
    INTO authority_state, authority_version
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile activation authority is missing'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.settings_version = OLD.settings_version THEN
    IF pg_catalog.pg_trigger_depth() <> 2 THEN
      RAISE EXCEPTION 'workforce profile service control activation revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.settings_version = OLD.settings_version + 1 THEN
    IF pg_catalog.pg_trigger_depth() <> 1 OR authority_state <> 'active' THEN
      RAISE EXCEPTION 'workforce profile service control settings revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'workforce profile service control settings version is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."esbla_sync_hr_workforce_profile_service_activation"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  synchronized_rows integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'workforce_profile' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'invalid initial workforce profile activation authority'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.hr_workforce_profile_service_control
      (tenant_id, service_key, settings_version, updated_at, row_version)
    VALUES
      (NEW.tenant_id, NEW.service_key, 1, pg_catalog.statement_timestamp(), 1);
    RETURN NEW;
  END IF;

  IF OLD.service_key <> 'workforce_profile' AND NEW.service_key <> 'workforce_profile' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.service_key <> 'workforce_profile'
     OR NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid workforce profile activation authority transition'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.hr_workforce_profile_service_control AS control
    SET updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          control.updated_at + interval '1 microsecond'
        ),
        row_version = control.row_version + 1
    WHERE control.tenant_id = NEW.tenant_id
      AND control.service_key = NEW.service_key;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'workforce profile service control projection is missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."esbla_configure_hr_workforce_profile_settings"(
  integer,
  boolean,
  text,
  boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_settings_version ALIAS FOR $1;
  employee_number_required ALIAS FOR $2;
  manager_visibility ALIAS FOR $3;
  unlinked_worker_creation_allowed ALIAS FOR $4;
  governed_tenant_id uuid;
  current_settings_version integer;
  synchronized_rows integer;
BEGIN
  IF expected_settings_version IS NULL OR expected_settings_version <= 0
     OR employee_number_required IS NULL
     OR manager_visibility IS NULL
     OR manager_visibility NOT IN ('minimized', 'none')
     OR unlinked_worker_creation_allowed IS NULL THEN
    RAISE EXCEPTION 'workforce profile settings input is invalid'
      USING ERRCODE = '22023';
  END IF;

  governed_tenant_id := public.esbla_current_tenant_id();
  IF governed_tenant_id IS NULL THEN
    RAISE EXCEPTION 'workforce profile tenant context is missing'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'workforce_profile'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile service is inactive'
      USING ERRCODE = '55000';
  END IF;

  SELECT control.settings_version
    INTO current_settings_version
    FROM public.hr_workforce_profile_service_control AS control
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'workforce_profile'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile service control is missing'
      USING ERRCODE = '55000';
  END IF;
  IF current_settings_version <> expected_settings_version THEN
    RAISE EXCEPTION 'workforce profile settings version conflict'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.workforce_profile.employee_number_required',
      'boolean',
      pg_catalog.to_jsonb(employee_number_required),
      1,
      pg_catalog.statement_timestamp()
    )
  ON CONFLICT (tenant_id, setting_key) DO UPDATE
    SET value_type = EXCLUDED.value_type,
        value = EXCLUDED.value,
        version = setting.version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          setting.updated_at + interval '1 microsecond'
        );

  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.workforce_profile.manager_visibility',
      'enum',
      pg_catalog.to_jsonb(manager_visibility),
      1,
      pg_catalog.statement_timestamp()
    )
  ON CONFLICT (tenant_id, setting_key) DO UPDATE
    SET value_type = EXCLUDED.value_type,
        value = EXCLUDED.value,
        version = setting.version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          setting.updated_at + interval '1 microsecond'
        );

  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.workforce_profile.unlinked_worker_creation_allowed',
      'boolean',
      pg_catalog.to_jsonb(unlinked_worker_creation_allowed),
      1,
      pg_catalog.statement_timestamp()
    )
  ON CONFLICT (tenant_id, setting_key) DO UPDATE
    SET value_type = EXCLUDED.value_type,
        value = EXCLUDED.value,
        version = setting.version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          setting.updated_at + interval '1 microsecond'
        );

  UPDATE public.hr_workforce_profile_service_control AS control
    SET settings_version = control.settings_version + 1,
        row_version = control.row_version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          control.updated_at + interval '1 microsecond'
        )
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'workforce_profile'
      AND control.settings_version = expected_settings_version;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'workforce profile settings version conflict'
      USING ERRCODE = '40001';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."esbla_configure_hr_workforce_profile_settings"(
  integer, boolean, text, boolean
) FROM PUBLIC;
