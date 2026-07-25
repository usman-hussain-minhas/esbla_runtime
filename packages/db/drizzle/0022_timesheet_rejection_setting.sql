CREATE OR REPLACE FUNCTION "esbla_enforce_hr_timesheet_approval"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  selected public.hr_timesheet_versions%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'timesheet approvals are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO selected FROM public.hr_timesheet_versions
    WHERE tenant_id=NEW.tenant_id AND timesheet_version_id=NEW.timesheet_version_id;
  IF NOT FOUND
     OR selected.status <> 'submitted'
     OR selected.assigned_approver_worker_profile_id IS DISTINCT FROM NEW.approver_worker_profile_id THEN
    RAISE EXCEPTION 'invalid timesheet approval' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_timesheet_approval"() FROM PUBLIC;
