CREATE INDEX idx_hr_employment_records_tenant_order_cursor
  ON public.hr_employment_records USING btree
  (tenant_id, created_at DESC NULLS LAST, employment_record_id DESC NULLS LAST);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.esbla_enforce_hr_employment_service_control()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'employment record service control cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.pg_trigger_depth() <> 2
       OR NEW.service_key <> 'employment_record'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid employment record service control creation'
        USING ERRCODE = '55000';
    END IF;

    SELECT activation.state, activation.version
      INTO authority_state, authority_version
      FROM public.service_activations AS activation
      WHERE activation.tenant_id = NEW.tenant_id
        AND activation.service_key = NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'employment record activation authority is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.service_control_id, NEW.tenant_id, NEW.service_key)
     IS DISTINCT FROM
     (OLD.service_control_id, OLD.tenant_id, OLD.service_key) THEN
    RAISE EXCEPTION 'immutable employment record service control fields changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'invalid employment record service control revision'
      USING ERRCODE = '55000';
  END IF;

  SELECT activation.state, activation.version
    INTO authority_state, authority_version
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record activation authority is missing'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.settings_version = OLD.settings_version THEN
    IF pg_catalog.pg_trigger_depth() <> 2 THEN
      RAISE EXCEPTION 'employment record service control activation revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.settings_version = OLD.settings_version + 1 THEN
    IF pg_catalog.pg_trigger_depth() <> 1 OR authority_state <> 'active' THEN
      RAISE EXCEPTION 'employment record service control settings revision is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'employment record service control settings version is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_enforce_hr_employment_service_control() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.esbla_sync_hr_employment_record_service_activation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  synchronized_rows integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'employment_record' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'invalid initial employment record activation authority'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.hr_employment_record_service_control
      (tenant_id, service_key, settings_version, updated_at, row_version)
    VALUES
      (NEW.tenant_id, NEW.service_key, 1, pg_catalog.statement_timestamp(), 1);
    RETURN NEW;
  END IF;

  IF OLD.service_key <> 'employment_record' AND NEW.service_key <> 'employment_record' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.service_key <> 'employment_record'
     OR NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid employment record activation authority transition'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.hr_employment_record_service_control AS control
    SET updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          control.updated_at + interval '1 microsecond'
        ),
        row_version = control.row_version + 1
    WHERE control.tenant_id = NEW.tenant_id
      AND control.service_key = NEW.service_key;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'employment record service control projection is missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_sync_hr_employment_record_service_activation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER service_activations_sync_hr_employment_record
  AFTER INSERT OR UPDATE ON public.service_activations
  FOR EACH ROW EXECUTE FUNCTION public.esbla_sync_hr_employment_record_service_activation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.esbla_enforce_hr_employment_record_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  current_head uuid;
  current_status public.hr_employment_record_status;
  current_worker uuid;
  prior_effective_from date;
  prior_effective_to date;
  prior_employment_type_code text;
  prior_kind public.hr_employment_version_kind;
  prior_organization_reference text;
  prior_position_reference text;
  prior_terminal boolean;
  prior_version integer;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'employment record versions are append-only'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'employment_record'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record service is inactive'
      USING ERRCODE = '55000';
  END IF;

  SELECT record.status, record.current_version_id, record.worker_profile_id
    INTO current_status, current_head, current_worker
    FROM public.hr_employment_records AS record
    WHERE record.tenant_id = NEW.tenant_id
      AND record.employment_record_id = NEW.employment_record_id
    FOR UPDATE NOWAIT;
  IF NOT FOUND OR current_status = 'ended' THEN
    RAISE EXCEPTION 'employment record is not mutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.worker_profile_id IS DISTINCT FROM current_worker THEN
    RAISE EXCEPTION 'employment record version worker is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.supersedes_version_id IS DISTINCT FROM current_head THEN
    RAISE EXCEPTION 'employment record predecessor is not current'
      USING ERRCODE = '55000';
  END IF;

  IF current_head IS NULL THEN
    IF current_status <> 'draft' OR NEW.version <> 1 OR NEW.version_kind <> 'effective'
       OR NEW.terminal_version THEN
      RAISE EXCEPTION 'employment record first version is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT version.version, version.version_kind, version.terminal_version,
           version.effective_from, version.effective_to, version.employment_type_code,
           version.organization_reference, version.position_reference
      INTO prior_version, prior_kind, prior_terminal,
           prior_effective_from, prior_effective_to, prior_employment_type_code,
           prior_organization_reference, prior_position_reference
      FROM public.hr_employment_record_versions AS version
      WHERE version.tenant_id = NEW.tenant_id
        AND version.employment_record_id = NEW.employment_record_id
        AND version.employment_record_version_id = current_head;
    IF NOT FOUND OR NEW.version <> prior_version + 1 THEN
      RAISE EXCEPTION 'employment record version must advance exactly'
        USING ERRCODE = '55000';
    END IF;
    IF prior_kind <> 'effective' OR prior_terminal THEN
      RAISE EXCEPTION 'employment record predecessor is not an effective head'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.version_kind = 'effective' AND NOT NEW.terminal_version THEN
      IF prior_effective_to IS NULL THEN
        RAISE EXCEPTION 'open-ended employment record head cannot be superseded'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.effective_from <= prior_effective_to THEN
        RAISE EXCEPTION 'employment record successor must begin after its predecessor'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.effective_to IS NOT NULL AND NEW.effective_to < NEW.effective_from THEN
        NULL;
      ELSIF EXISTS (
        SELECT 1
          FROM public.hr_employment_record_versions AS version
          WHERE version.tenant_id = NEW.tenant_id
            AND version.employment_record_id = NEW.employment_record_id
            AND version.version_kind = 'effective'
            AND pg_catalog.daterange(
                  version.effective_from, version.effective_to, '[]'
                ) && pg_catalog.daterange(NEW.effective_from, NEW.effective_to, '[]')
      ) THEN
        RAISE EXCEPTION 'employment record effective ranges cannot overlap'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.version_kind = 'end' AND NEW.terminal_version THEN
      IF NEW.effective_from IS DISTINCT FROM prior_effective_from
         OR NEW.employment_type_code IS DISTINCT FROM prior_employment_type_code
         OR NEW.organization_reference IS DISTINCT FROM prior_organization_reference
         OR NEW.position_reference IS DISTINCT FROM prior_position_reference THEN
        RAISE EXCEPTION 'employment record terminal version must preserve effective facts'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'employment record successor kind is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  NEW.employment_record_version_id := pg_catalog.gen_random_uuid();
  NEW.row_version := 1;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_enforce_hr_employment_record_version() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.esbla_configure_hr_employment_record_settings(
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
  employment_type_codes ALIAS FOR $2;
  effective_range_overlap_allowed ALIAS FOR $3;
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
     OR employment_type_codes IS NULL
     OR pg_catalog.btrim(employment_type_codes) = ''
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(pg_catalog.string_to_array(employment_type_codes, ',')) AS code(value)
         WHERE pg_catalog.btrim(code.value) = ''
     )
     OR effective_range_overlap_allowed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'employment record settings input is invalid'
      USING ERRCODE = '22023';
  END IF;

  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  IF tenant_text IS NULL OR actor_text IS NULL
     OR tenant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'employment record settings authority is denied'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'employment record settings authority is denied'
      USING ERRCODE = '42501';
  END;

  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'employment_record'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record service is inactive'
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
    RAISE EXCEPTION 'employment record settings authority is denied'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.membership_capabilities AS capability
    WHERE capability.tenant_id = governed_tenant_id
      AND capability.principal_id = governed_actor_id
      AND capability.capability_id = 'hr.employment.configure_service'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record settings authority is denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT control.settings_version
    INTO current_settings_version
    FROM public.hr_employment_record_service_control AS control
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'employment_record'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record service control is missing'
      USING ERRCODE = '55000';
  END IF;
  IF current_settings_version <> expected_settings_version THEN
    RAISE EXCEPTION 'employment record settings version conflict'
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
        'hr.employment_record.employment_type_codes',
        'hr.employment_record.effective_range_overlap_allowed'
      ]);
  IF expected_settings_version = 1 THEN
    IF setting_count <> 0 THEN
      RAISE EXCEPTION 'employment record settings state is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF setting_count <> 2
       OR prior_settings #>> '{hr.employment_record.employment_type_codes,type}' <> 'text'
       OR prior_settings #>> '{hr.employment_record.effective_range_overlap_allowed,type}' <> 'boolean'
       OR (prior_settings #>> '{hr.employment_record.employment_type_codes,version}')::integer
            <> expected_settings_version - 1
       OR (prior_settings #>> '{hr.employment_record.effective_range_overlap_allowed,version}')::integer
            <> expected_settings_version - 1
       OR pg_catalog.jsonb_typeof(
            prior_settings #> '{hr.employment_record.employment_type_codes,value}'
          ) <> 'string'
       OR pg_catalog.jsonb_typeof(
            prior_settings #> '{hr.employment_record.effective_range_overlap_allowed,value}'
          ) <> 'boolean'
       OR (prior_settings #>> '{hr.employment_record.effective_range_overlap_allowed,value}')::boolean
            IS DISTINCT FROM false
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.unnest(pg_catalog.string_to_array(
             prior_settings #>> '{hr.employment_record.employment_type_codes,value}', ','
           )) AS code(value)
           WHERE pg_catalog.btrim(code.value) = ''
       ) THEN
      RAISE EXCEPTION 'employment record settings state is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.employment_record.employment_type_codes',
      'text',
      pg_catalog.to_jsonb(employment_type_codes),
      1,
      pg_catalog.statement_timestamp()
    ),
    (
      governed_tenant_id,
      'hr.employment_record.effective_range_overlap_allowed',
      'boolean',
      pg_catalog.to_jsonb(effective_range_overlap_allowed),
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
    RAISE EXCEPTION 'employment record settings version conflict'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.hr_employment_record_service_control AS control
    SET settings_version = control.settings_version + 1,
        row_version = control.row_version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(), control.updated_at + interval '1 microsecond'
        )
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'employment_record'
      AND control.settings_version = expected_settings_version;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'employment record settings version conflict'
      USING ERRCODE = '40001';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_configure_hr_employment_record_settings(
  integer, text, boolean
) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_configure_hr_employment_record_settings(
  integer, text, boolean
) TO esbla_app;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.hr_employment_record_service_control
  FROM PUBLIC, esbla_app;
--> statement-breakpoint
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
  ON TABLE public.hr_employment_record_service_control FROM PUBLIC, esbla_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.hr_employment_record_service_control TO esbla_app;
