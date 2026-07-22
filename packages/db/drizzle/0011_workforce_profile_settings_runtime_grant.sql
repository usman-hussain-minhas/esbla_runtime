CREATE OR REPLACE FUNCTION public.esbla_configure_hr_workforce_profile_settings(
  integer, boolean, text, boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_settings_version ALIAS FOR $1; employee_number_required ALIAS FOR $2;
  manager_visibility ALIAS FOR $3; unlinked_worker_creation_allowed ALIAS FOR $4;
  tenant_text text; actor_text text; correlation_text text;
  governed_tenant_id uuid; governed_actor_id uuid; governed_correlation_id uuid;
  activation_state public.service_activation_state; activation_version integer; control_id uuid;
  current_settings_version integer; after_settings_version integer; after_row_version integer;
  after_updated_at timestamp with time zone; prior_settings jsonb;
  updated_iso text; setting_count integer; changed_rows integer;
  before_employee_number_required boolean; before_manager_visibility text;
  before_unlinked_worker_creation_allowed boolean;
  receipt_bytes bytea; receipt_hex text; receipt_id uuid;
  semantic_source text; before_source text; after_source text; response_source text;
  semantic_sha256 text; before_settings_sha256 text; after_settings_sha256 text; response_sha256 text;
  service_control jsonb; event_payload jsonb;
BEGIN
  IF expected_settings_version IS NULL OR expected_settings_version <= 0
     OR employee_number_required IS NULL
     OR manager_visibility IS NULL
     OR manager_visibility NOT IN ('minimized', 'none')
     OR unlinked_worker_creation_allowed IS NULL THEN
    RAISE EXCEPTION 'workforce profile settings input is invalid' USING ERRCODE = '22023';
  END IF;
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  correlation_text := NULLIF(pg_catalog.current_setting('app.correlation_id', true), '');
  IF tenant_text IS NULL OR actor_text IS NULL OR correlation_text IS NULL
     OR tenant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR correlation_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'workforce profile settings authority is denied' USING ERRCODE = '42501';
  END IF;
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
    governed_correlation_id := correlation_text::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workforce profile settings authority is denied' USING ERRCODE = '42501';
  END;
  SELECT activation.state, activation.version
    INTO activation_state, activation_version
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = governed_tenant_id
      AND activation.service_key = 'workforce_profile'
      AND activation.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile service is inactive' USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.memberships AS membership
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = governed_actor_id
      AND membership.status = 'active'
      AND membership.role_key = 'tenant_admin'
    FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.membership_capabilities AS capability
    WHERE capability.tenant_id = governed_tenant_id
      AND capability.principal_id = governed_actor_id
      AND capability.capability_id = 'hr.workforce.configure_service'
  ) THEN
    RAISE EXCEPTION 'workforce profile settings authority is denied' USING ERRCODE = '42501';
  END IF;
  receipt_bytes := pg_catalog.substr(
    pg_catalog.sha256(pg_catalog.convert_to(
      'hr.workforce_profile.service_control.idempotency.v1'
      || pg_catalog.chr(31) || governed_tenant_id::text
      || pg_catalog.chr(31) || governed_actor_id::text
      || pg_catalog.chr(31) || 'configure_service'
      || pg_catalog.chr(31) || governed_correlation_id::text,
      'UTF8'
    )), 1, 16
  );
  receipt_bytes := pg_catalog.set_byte(receipt_bytes, 6,
    (pg_catalog.get_byte(receipt_bytes, 6) & 15) | 128);
  receipt_bytes := pg_catalog.set_byte(receipt_bytes, 8,
    (pg_catalog.get_byte(receipt_bytes, 8) & 63) | 128);
  receipt_hex := pg_catalog.encode(receipt_bytes, 'hex');
  receipt_id := (
    pg_catalog.substr(receipt_hex, 1, 8) || '-'
    || pg_catalog.substr(receipt_hex, 9, 4) || '-'
    || pg_catalog.substr(receipt_hex, 13, 4) || '-'
    || pg_catalog.substr(receipt_hex, 17, 4) || '-'
    || pg_catalog.substr(receipt_hex, 21, 12)
  )::uuid;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(receipt_id::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'hr.workforce_profile.settings.v1:' || governed_tenant_id::text, 0
  ));
  SELECT control.service_control_id, control.settings_version
    INTO control_id, current_settings_version
    FROM public.hr_workforce_profile_service_control AS control
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'workforce_profile'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile service control is missing' USING ERRCODE = '55000';
  END IF;
  IF current_settings_version <> expected_settings_version THEN
    RAISE EXCEPTION 'workforce profile settings version conflict' USING ERRCODE = '40001';
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
        'hr.workforce_profile.employee_number_required',
        'hr.workforce_profile.manager_visibility',
        'hr.workforce_profile.unlinked_worker_creation_allowed'
      ]);
  IF expected_settings_version = 1 THEN
    IF setting_count <> 0 THEN
      RAISE EXCEPTION 'workforce profile settings state is inconsistent' USING ERRCODE = '55000';
    END IF;
    before_employee_number_required := false;
    before_manager_visibility := 'minimized';
    before_unlinked_worker_creation_allowed := true;
  ELSE
    IF setting_count <> 3
       OR prior_settings #>> '{hr.workforce_profile.employee_number_required,type}' <> 'boolean'
       OR prior_settings #>> '{hr.workforce_profile.manager_visibility,type}' <> 'enum'
       OR prior_settings #>> '{hr.workforce_profile.unlinked_worker_creation_allowed,type}' <> 'boolean'
       OR (prior_settings #>> '{hr.workforce_profile.employee_number_required,version}')::integer <> expected_settings_version - 1
       OR (prior_settings #>> '{hr.workforce_profile.manager_visibility,version}')::integer <> expected_settings_version - 1
       OR (prior_settings #>> '{hr.workforce_profile.unlinked_worker_creation_allowed,version}')::integer <> expected_settings_version - 1
       OR pg_catalog.jsonb_typeof(prior_settings #> '{hr.workforce_profile.employee_number_required,value}') <> 'boolean'
       OR pg_catalog.jsonb_typeof(prior_settings #> '{hr.workforce_profile.manager_visibility,value}') <> 'string'
       OR pg_catalog.jsonb_typeof(prior_settings #> '{hr.workforce_profile.unlinked_worker_creation_allowed,value}') <> 'boolean'
       OR prior_settings #>> '{hr.workforce_profile.manager_visibility,value}' NOT IN ('minimized', 'none') THEN
      RAISE EXCEPTION 'workforce profile settings state is inconsistent' USING ERRCODE = '55000';
    END IF;
    before_employee_number_required :=
      (prior_settings #>> '{hr.workforce_profile.employee_number_required,value}')::boolean;
    before_manager_visibility :=
      prior_settings #>> '{hr.workforce_profile.manager_visibility,value}';
    before_unlinked_worker_creation_allowed :=
      (prior_settings #>> '{hr.workforce_profile.unlinked_worker_creation_allowed,value}')::boolean;
  END IF;
  INSERT INTO public.tenant_settings AS setting
    (tenant_id, setting_key, value_type, value, version, updated_at)
  VALUES
    (governed_tenant_id, 'hr.workforce_profile.employee_number_required', 'boolean',
      pg_catalog.to_jsonb(employee_number_required), 1, pg_catalog.statement_timestamp()),
    (governed_tenant_id, 'hr.workforce_profile.manager_visibility', 'enum',
      pg_catalog.to_jsonb(manager_visibility), 1, pg_catalog.statement_timestamp()),
    (governed_tenant_id, 'hr.workforce_profile.unlinked_worker_creation_allowed', 'boolean',
      pg_catalog.to_jsonb(unlinked_worker_creation_allowed), 1, pg_catalog.statement_timestamp())
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
    RAISE EXCEPTION 'workforce profile settings version conflict' USING ERRCODE = '40001';
  END IF;

  UPDATE public.hr_workforce_profile_service_control AS control
    SET settings_version = control.settings_version + 1,
        row_version = control.row_version + 1,
        updated_at = GREATEST(
          pg_catalog.statement_timestamp(), control.updated_at + interval '1 microsecond'
        )
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'workforce_profile'
      AND control.settings_version = expected_settings_version
    RETURNING control.settings_version, control.row_version, control.updated_at
      INTO after_settings_version, after_row_version, after_updated_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile settings version conflict' USING ERRCODE = '40001';
  END IF;

  updated_iso := pg_catalog.to_char(
    after_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  semantic_source := '[' || expected_settings_version::text || ','
    || employee_number_required::text || ',' || pg_catalog.to_jsonb(manager_visibility)::text || ','
    || unlinked_worker_creation_allowed::text || ']';
  before_source := '[' || expected_settings_version::text || ','
    || before_employee_number_required::text || ','
    || pg_catalog.to_jsonb(before_manager_visibility)::text || ','
    || before_unlinked_worker_creation_allowed::text || ']';
  after_source := '[' || after_settings_version::text || ','
    || employee_number_required::text || ',' || pg_catalog.to_jsonb(manager_visibility)::text || ','
    || unlinked_worker_creation_allowed::text || ']';
  response_source := '[' || pg_catalog.to_jsonb(activation_state::text)::text || ','
    || activation_version::text || ',' || pg_catalog.to_jsonb('workforce_profile'::text)::text || ','
    || employee_number_required::text || ',' || pg_catalog.to_jsonb(manager_visibility)::text || ','
    || unlinked_worker_creation_allowed::text || ',' || after_settings_version::text || ','
    || pg_catalog.to_jsonb(updated_iso)::text || ',' || after_row_version::text || ']';
  semantic_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(semantic_source, 'UTF8')), 'hex');
  before_settings_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(before_source, 'UTF8')), 'hex');
  after_settings_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(after_source, 'UTF8')), 'hex');
  response_sha256 := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(response_source, 'UTF8')), 'hex');
  service_control := pg_catalog.jsonb_build_object(
    'activationState', activation_state::text,
    'activationVersion', activation_version,
    'serviceKey', 'workforce_profile',
    'settings', pg_catalog.jsonb_build_object(
      'employeeNumberRequired', employee_number_required, 'managerVisibility', manager_visibility,
      'unlinkedWorkerCreationAllowed', unlinked_worker_creation_allowed
    ),
    'settingsVersion', after_settings_version,
    'updatedAt', updated_iso,
    'version', after_row_version
  );
  event_payload := pg_catalog.jsonb_build_object(
    'action', 'configure_service',
    'actorPrincipalId', governed_actor_id::text,
    'afterSettingsSha256', after_settings_sha256,
    'afterSettingsVersion', after_settings_version,
    'aggregateId', control_id::text,
    'beforeSettingsSha256', before_settings_sha256,
    'beforeSettingsVersion', expected_settings_version,
    'correlationId', governed_correlation_id::text,
    'receiptId', receipt_id::text,
    'serviceControl', service_control,
    'tenantId', governed_tenant_id::text
  );

  INSERT INTO public.evidence_events
    (tenant_id, event_type, subject_type, subject_id, actor_principal_id,
      correlation_id, prior_state, new_state)
  VALUES
    (governed_tenant_id, 'hr.workforce_profile.configure_service',
      'hr.workforce_profile.service_control', control_id, governed_actor_id,
      governed_correlation_id, before_settings_sha256, after_settings_sha256);
  INSERT INTO public.outbox_events
    (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version,
      correlation_id, payload)
  VALUES
    (governed_tenant_id, 'hr.workforce_profile.configure_service',
      'hr.workforce_profile.service_control', control_id, after_row_version,
      governed_correlation_id, event_payload);
  INSERT INTO public.evidence_events
    (tenant_id, event_type, subject_type, subject_id, actor_principal_id,
      correlation_id, prior_state, new_state)
  VALUES
    (governed_tenant_id, 'hr.workforce_profile.configure_service.response_bound',
      'hr.workforce_profile.service_control.idempotency', receipt_id, governed_actor_id,
      governed_correlation_id, semantic_sha256, response_sha256);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_configure_hr_workforce_profile_settings(
  integer, boolean, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_configure_hr_workforce_profile_settings(
  integer, boolean, text, boolean) TO esbla_app;
--> statement-breakpoint
REVOKE ALL ON TABLE public.tenant_settings, public.hr_workforce_profile_service_control FROM esbla_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.tenant_settings, public.hr_workforce_profile_service_control TO esbla_app;
