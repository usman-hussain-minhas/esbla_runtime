CREATE FUNCTION public.esbla_lock_membership_authority(
  expected_tenant_id uuid,
  expected_actor_principal_id uuid,
  subject_principal_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
PARALLEL UNSAFE
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  tenant_setting text;
  actor_setting text;
  governed_tenant_id uuid;
  governed_actor_principal_id uuid;
  authority jsonb;
BEGIN
  tenant_setting := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '');
  actor_setting := NULLIF(pg_catalog.current_setting('app.actor_principal_id', true), '');
  IF expected_tenant_id IS NULL
     OR expected_actor_principal_id IS NULL
     OR subject_principal_id IS NULL
     OR tenant_setting IS NULL
     OR actor_setting IS NULL
     OR tenant_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR actor_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR subject_principal_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'membership authority is denied' USING ERRCODE = '42501';
  END IF;
  BEGIN
    governed_tenant_id := tenant_setting::uuid;
    governed_actor_principal_id := actor_setting::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'membership authority is denied' USING ERRCODE = '42501';
  END;
  IF governed_tenant_id <> expected_tenant_id
     OR governed_actor_principal_id <> expected_actor_principal_id THEN
    RAISE EXCEPTION 'membership authority is denied' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
           'roleKey', membership.role_key,
           'status', membership.status
         )
    INTO authority
    FROM public.memberships AS membership
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = subject_principal_id
    FOR SHARE OF membership;
  RETURN authority;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_lock_membership_authority(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_lock_membership_authority(uuid, uuid, uuid) TO esbla_app;
--> statement-breakpoint
ALTER FUNCTION public.esbla_enforce_hr_workforce_profile_state() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION public.esbla_enforce_hr_workforce_profile_state() SET search_path = pg_catalog;
--> statement-breakpoint
ALTER FUNCTION public.esbla_enforce_hr_workforce_profile_state() SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION public.esbla_enforce_hr_reporting_relationship_state() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION public.esbla_enforce_hr_reporting_relationship_state() SET search_path = pg_catalog;
--> statement-breakpoint
ALTER FUNCTION public.esbla_enforce_hr_reporting_relationship_state() SET row_security = on;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.memberships FROM PUBLIC, esbla_app;
--> statement-breakpoint
REVOKE SELECT (membership_id, tenant_id, principal_id, role_key, manager_principal_id, status),
       INSERT (membership_id, tenant_id, principal_id, role_key, manager_principal_id, status),
       UPDATE (membership_id, tenant_id, principal_id, role_key, manager_principal_id, status),
       REFERENCES (membership_id, tenant_id, principal_id, role_key, manager_principal_id, status)
  ON TABLE public.memberships FROM PUBLIC, esbla_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.memberships TO esbla_app;
