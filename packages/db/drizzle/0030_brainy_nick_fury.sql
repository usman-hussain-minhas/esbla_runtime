CREATE TABLE "presentation_surface_settings" (
	"tenant_id" uuid NOT NULL,
	"surface_id" text NOT NULL,
	"personalization_enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_principal_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_surface_settings_pk" PRIMARY KEY("tenant_id","surface_id"),
	CONSTRAINT "presentation_surface_settings_surface_valid" CHECK ("presentation_surface_settings"."surface_id" IN ('surface.mission-control', 'surface.hr.mission-control')),
	CONSTRAINT "presentation_surface_settings_version_positive" CHECK ("presentation_surface_settings"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "presentation_surface_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_settings" ADD CONSTRAINT "presentation_surface_settings_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_settings" ADD CONSTRAINT "presentation_surface_settings_updater_membership_fk" FOREIGN KEY ("tenant_id","updated_by_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE FUNCTION public.esbla_lock_presentation_surface_setting_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'platform.presentation.surface.personalization:' ||
      NEW.tenant_id::text || ':' || NEW.surface_id,
      0
    )
  );
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_lock_presentation_surface_setting_write() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_lock_presentation_surface_setting_write() TO esbla_app;--> statement-breakpoint
CREATE TRIGGER "presentation_surface_settings_lock_write"
  BEFORE INSERT OR UPDATE ON "presentation_surface_settings"
  FOR EACH ROW
  EXECUTE FUNCTION public.esbla_lock_presentation_surface_setting_write();--> statement-breakpoint
CREATE POLICY "presentation_surface_settings_read" ON "presentation_surface_settings"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_settings_write" ON "presentation_surface_settings"
  FOR ALL
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND public.esbla_lock_membership_capability(
      tenant_id,
      nullif(current_setting('app.actor_principal_id', true), '')::uuid,
      'platform.presentation.tenant_defaults.write'
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND public.esbla_lock_membership_capability(
      tenant_id,
      nullif(current_setting('app.actor_principal_id', true), '')::uuid,
      'platform.presentation.tenant_defaults.write'
    )
  );--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_settings" FROM "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "presentation_surface_settings" TO "esbla_app";--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM presentation_surface_versions source
    CROSS JOIN LATERAL jsonb_array_elements(source.layout) element
    WHERE jsonb_typeof(source.layout) <> 'array'
       OR jsonb_typeof(element) <> 'object'
       OR element->>'widgetDefinitionId' IS NULL
       OR element ? 'widgetDefinitionVersion'
       OR element->>'widgetDefinitionId' NOT IN (
      'platform.my-work.queue',
      'hr.shift.my-published',
      'hr.leave.my-requests',
      'hr.timesheet.mine',
      'hr.workforce.my-profile',
      'hr.employment.current-facts'
    )
  ) OR EXISTS (
    SELECT 1
    FROM presentation_surface_drafts source
    CROSS JOIN LATERAL jsonb_array_elements(source.layout) element
    WHERE jsonb_typeof(source.layout) <> 'array'
       OR jsonb_typeof(element) <> 'object'
       OR element->>'widgetDefinitionId' IS NULL
       OR element ? 'widgetDefinitionVersion'
       OR element->>'widgetDefinitionId' NOT IN (
      'platform.my-work.queue',
      'hr.shift.my-published',
      'hr.leave.my-requests',
      'hr.timesheet.mine',
      'hr.workforce.my-profile',
      'hr.employment.current-facts'
    )
  ) OR EXISTS (
    SELECT 1
    FROM presentation_surface_overlays source
    CROSS JOIN LATERAL jsonb_array_elements(source.layout) element
    WHERE jsonb_typeof(source.layout) <> 'array'
       OR jsonb_typeof(element) <> 'object'
       OR element->>'widgetDefinitionId' IS NULL
       OR element ? 'widgetDefinitionVersion'
       OR element->>'widgetDefinitionId' NOT IN (
        'platform.my-work.queue',
        'hr.shift.my-published',
        'hr.leave.my-requests',
        'hr.timesheet.mine',
        'hr.workforce.my-profile',
        'hr.employment.current-facts'
      )
  ) THEN
    RAISE EXCEPTION 'presentation placement version migration found an unknown widget definition';
  END IF;
END
$$;--> statement-breakpoint
UPDATE "presentation_surface_versions"
SET "layout" = (
  SELECT coalesce(
    jsonb_agg(
      element || jsonb_build_object('widgetDefinitionVersion', 1)
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("presentation_surface_versions"."layout")
    WITH ORDINALITY AS placement(element, ordinal)
);--> statement-breakpoint
UPDATE "presentation_surface_drafts"
SET "layout" = (
  SELECT coalesce(
    jsonb_agg(
      element || jsonb_build_object('widgetDefinitionVersion', 1)
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("presentation_surface_drafts"."layout")
    WITH ORDINALITY AS placement(element, ordinal)
);--> statement-breakpoint
UPDATE "presentation_surface_overlays"
SET "layout" = (
  SELECT coalesce(
    jsonb_agg(
      element || jsonb_build_object('widgetDefinitionVersion', 1)
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("presentation_surface_overlays"."layout")
    WITH ORDINALITY AS placement(element, ordinal)
);--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" FORCE ROW LEVEL SECURITY;
