CREATE FUNCTION "esbla_lock_hr_attendance_settings_snapshot"() RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  governed_tenant_id uuid;
  settings_snapshot jsonb;
  settings_version integer;
  tenant_text text;
BEGIN
  tenant_text := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  BEGIN
    governed_tenant_id := tenant_text::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'attendance settings snapshot authority is denied'
      USING ERRCODE = '42501';
  END;

  SELECT control.settings_version
    INTO settings_version
    FROM public.hr_attendance_service_control AS control
    WHERE control.tenant_id = governed_tenant_id
      AND control.service_key = 'attendance'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance service control is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
           'settingsVersion', settings_version,
           'settings', COALESCE(
             pg_catalog.jsonb_object_agg(
               setting.setting_key,
               pg_catalog.jsonb_build_object(
                 'type', setting.value_type::text,
                 'value', setting.value,
                 'version', setting.version
               )
             ),
             '{}'::jsonb
           )
         )
    INTO settings_snapshot
    FROM public.tenant_settings AS setting
    WHERE setting.tenant_id = governed_tenant_id
      AND setting.setting_key = ANY(ARRAY[
        'hr.attendance.correction_note_required',
        'hr.attendance.manual_observation_kinds'
      ]);
  RETURN settings_snapshot;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_lock_hr_attendance_settings_snapshot"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "esbla_lock_hr_attendance_settings_snapshot"() TO "esbla_app";
