CREATE OR REPLACE FUNCTION "public"."esbla_current_tenant_id"() RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::pg_catalog.uuid
$$;
