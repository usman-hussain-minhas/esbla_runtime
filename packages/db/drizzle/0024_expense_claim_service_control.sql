CREATE FUNCTION "esbla_hr_expense_claim_service_admin_current"(text) RETURNS boolean
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
    'hr.expense.activate_service',
    'hr.expense.configure_service',
    'hr.expense.deactivate_service',
    'hr.expense.view_service_control'
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
    FROM public.memberships membership
    JOIN public.membership_capabilities capability
      ON capability.tenant_id=membership.tenant_id
     AND capability.principal_id=membership.principal_id
    WHERE membership.tenant_id=governed_tenant_id
      AND membership.principal_id=governed_actor_id
      AND membership.status='active'
      AND membership.role_key='tenant_admin'
      AND capability.capability_id=action_key
    FOR SHARE OF membership,capability;
  RETURN COALESCE(authority_current,false);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_hr_expense_claim_service_admin_current"(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "esbla_hr_expense_claim_service_admin_current"(text) TO "esbla_app";--> statement-breakpoint

CREATE FUNCTION "esbla_configure_hr_expense_claim_settings"(
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
  category_codes ALIAS FOR $2;
  rejection_note_required ALIAS FOR $3;
  actor_text text;
  changed_rows integer;
  code_count integer;
  current_settings_version integer;
  governed_actor_id uuid;
  governed_tenant_id uuid;
  prior_settings jsonb;
  setting_count integer;
  tenant_text text;
BEGIN
  SELECT pg_catalog.count(*)::integer
    INTO code_count
    FROM (
      SELECT DISTINCT selected
      FROM pg_catalog.unnest(pg_catalog.string_to_array(category_codes, ',')) selected
    ) categories;
  IF expected_settings_version IS NULL OR expected_settings_version <= 0
     OR category_codes IS NULL
     OR category_codes !~ '^[^[:space:],]+(,[^[:space:],]+)*$'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(pg_catalog.string_to_array(category_codes, ',')) selected
       WHERE pg_catalog.char_length(selected) > 64
     )
     OR code_count <> pg_catalog.array_length(pg_catalog.string_to_array(category_codes, ','),1)
     OR rejection_note_required IS NULL THEN
    RAISE EXCEPTION 'expense claim settings input is invalid' USING ERRCODE = '22023';
  END IF;
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_text := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  BEGIN
    governed_tenant_id := tenant_text::uuid;
    governed_actor_id := actor_text::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'expense claim settings authority is denied' USING ERRCODE = '42501';
  END;
  PERFORM 1
    FROM public.service_activations activation
    WHERE activation.tenant_id=governed_tenant_id
      AND activation.service_key='expense_claim_boundary'
      AND activation.state='active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense claim service is inactive' USING ERRCODE = '55000';
  END IF;
  PERFORM 1
    FROM public.memberships membership
    JOIN public.membership_capabilities capability
      ON capability.tenant_id=membership.tenant_id
     AND capability.principal_id=membership.principal_id
    WHERE membership.tenant_id=governed_tenant_id
      AND membership.principal_id=governed_actor_id
      AND membership.status='active'
      AND membership.role_key='tenant_admin'
      AND capability.capability_id='hr.expense.configure_service'
    FOR SHARE OF membership,capability;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense claim settings authority is denied' USING ERRCODE = '42501';
  END IF;
  SELECT control.settings_version
    INTO current_settings_version
    FROM public.hr_expense_claim_service_control control
    WHERE control.tenant_id=governed_tenant_id
      AND control.service_key='expense_claim_boundary'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense claim service control is missing' USING ERRCODE = '55000';
  END IF;
  IF current_settings_version <> expected_settings_version THEN
    RAISE EXCEPTION 'expense claim settings version conflict' USING ERRCODE = '40001';
  END IF;
  SELECT pg_catalog.count(*)::integer,
         COALESCE(pg_catalog.jsonb_object_agg(
           setting.setting_key,
           pg_catalog.jsonb_build_object(
             'type',setting.value_type::text,
             'value',setting.value,
             'version',setting.version
           )
         ),'{}'::jsonb)
    INTO setting_count,prior_settings
    FROM public.tenant_settings setting
    WHERE setting.tenant_id=governed_tenant_id
      AND setting.setting_key=ANY(ARRAY[
        'hr.expense.category_codes',
        'hr.expense.rejection_note_required'
      ]);
  IF expected_settings_version=1 THEN
    IF setting_count<>0 THEN
      RAISE EXCEPTION 'expense claim settings state is inconsistent' USING ERRCODE = '55000';
    END IF;
  ELSIF setting_count<>2
     OR prior_settings #>> '{hr.expense.category_codes,type}' <> 'text'
     OR prior_settings #>> '{hr.expense.rejection_note_required,type}' <> 'boolean'
     OR (prior_settings #>> '{hr.expense.category_codes,version}')::integer
          <> expected_settings_version-1
     OR (prior_settings #>> '{hr.expense.rejection_note_required,version}')::integer
          <> expected_settings_version-1
     OR prior_settings #>> '{hr.expense.category_codes,value}' IS NULL
     OR prior_settings #>> '{hr.expense.rejection_note_required,value}' NOT IN ('true','false')
  THEN
    RAISE EXCEPTION 'expense claim settings state is inconsistent' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.tenant_settings AS setting
    (tenant_id,setting_key,value_type,value,version,updated_at)
  VALUES
    (
      governed_tenant_id,
      'hr.expense.category_codes',
      'text',
      pg_catalog.to_jsonb(category_codes),
      1,
      pg_catalog.statement_timestamp()
    ),
    (
      governed_tenant_id,
      'hr.expense.rejection_note_required',
      'boolean',
      pg_catalog.to_jsonb(rejection_note_required),
      1,
      pg_catalog.statement_timestamp()
    )
  ON CONFLICT (tenant_id,setting_key) DO UPDATE
    SET value_type=EXCLUDED.value_type,
        value=EXCLUDED.value,
        version=setting.version+1,
        updated_at=GREATEST(
          pg_catalog.statement_timestamp(),setting.updated_at+interval '1 microsecond'
        )
    WHERE setting.version=expected_settings_version-1;
  GET DIAGNOSTICS changed_rows=ROW_COUNT;
  IF changed_rows<>2 THEN
    RAISE EXCEPTION 'expense claim settings version conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE public.hr_expense_claim_service_control control
    SET settings_version=control.settings_version+1,
        row_version=control.row_version+1,
        updated_at=GREATEST(
          pg_catalog.statement_timestamp(),control.updated_at+interval '1 microsecond'
        )
    WHERE control.tenant_id=governed_tenant_id
      AND control.service_key='expense_claim_boundary'
      AND control.settings_version=expected_settings_version;
  GET DIAGNOSTICS changed_rows=ROW_COUNT;
  IF changed_rows<>1 THEN
    RAISE EXCEPTION 'expense claim settings version conflict' USING ERRCODE = '40001';
  END IF;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_configure_hr_expense_claim_settings"(
  integer,text,boolean
) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "esbla_configure_hr_expense_claim_settings"(
  integer,text,boolean
) TO "esbla_app";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "esbla_protect_hr_timesheet_retention_evidence"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  evidence_owner text;
  expense_reserved boolean;
  timesheet_reserved boolean;
BEGIN
  expense_reserved :=
    NEW.subject_type = 'hr.expense.retention_qualification'
    OR NEW.subject_id = '3f0ee29f-3b49-4749-98b0-42d06bd52d66'::uuid
    OR NEW.event_type = 'hr.expense.retention.qualified';
  timesheet_reserved :=
    NEW.subject_type = 'hr.timesheet.retention_qualification'
    OR NEW.subject_id = 'ce2fb833-0dff-8e0b-a54e-29b33022ac26'::uuid
    OR NEW.event_type = 'hr.timesheet.retention.qualified';
  IF NOT expense_reserved AND NOT timesheet_reserved THEN RETURN NEW; END IF;
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO evidence_owner
    FROM pg_catalog.pg_class relation
    WHERE relation.oid=TG_RELID;
  IF SESSION_USER IS DISTINCT FROM evidence_owner
     OR (
       expense_reserved AND (
         timesheet_reserved
         OR NEW.subject_type <> 'hr.expense.retention_qualification'
         OR NEW.subject_id <> '3f0ee29f-3b49-4749-98b0-42d06bd52d66'::uuid
         OR NEW.event_type <> 'hr.expense.retention.qualified'
       )
     )
     OR (
       timesheet_reserved AND (
         expense_reserved
         OR NEW.subject_type <> 'hr.timesheet.retention_qualification'
         OR NEW.subject_id <> 'ce2fb833-0dff-8e0b-a54e-29b33022ac26'::uuid
         OR NEW.event_type <> 'hr.timesheet.retention.qualified'
       )
     )
     OR NEW.prior_state IS NOT NULL
     OR NEW.new_state <> 'qualified' THEN
    RAISE EXCEPTION 'HR retention evidence requires protected exact authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_protect_hr_timesheet_retention_evidence"() FROM PUBLIC;--> statement-breakpoint
