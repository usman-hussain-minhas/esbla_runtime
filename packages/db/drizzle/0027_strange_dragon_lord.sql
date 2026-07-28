CREATE TABLE "presentation_surface_drafts" (
	"tenant_id" uuid NOT NULL,
	"surface_id" text NOT NULL,
	"based_on_version" integer NOT NULL,
	"definition_hash" text NOT NULL,
	"layout" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_principal_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_surface_drafts_pk" PRIMARY KEY("tenant_id","surface_id"),
	CONSTRAINT "presentation_surface_drafts_surface_valid" CHECK ("presentation_surface_drafts"."surface_id" IN ('surface.mission-control', 'surface.hr.mission-control')),
	CONSTRAINT "presentation_surface_drafts_based_on_version_positive" CHECK ("presentation_surface_drafts"."based_on_version" > 0),
	CONSTRAINT "presentation_surface_drafts_definition_hash_valid" CHECK ("presentation_surface_drafts"."definition_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "presentation_surface_drafts_layout_array" CHECK (jsonb_typeof("presentation_surface_drafts"."layout") = 'array'),
	CONSTRAINT "presentation_surface_drafts_version_positive" CHECK ("presentation_surface_drafts"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" ADD COLUMN "based_on_version" integer;--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" ADD CONSTRAINT "presentation_surface_drafts_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" ADD CONSTRAINT "presentation_surface_drafts_based_on_fk" FOREIGN KEY ("tenant_id","surface_id","based_on_version") REFERENCES "public"."presentation_surface_versions"("tenant_id","surface_id","base_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" ADD CONSTRAINT "presentation_surface_drafts_updater_membership_fk" FOREIGN KEY ("tenant_id","updated_by_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentation_surface_drafts_tenant_updated_idx" ON "presentation_surface_drafts" USING btree ("tenant_id","updated_at");--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" ADD CONSTRAINT "presentation_surface_versions_based_on_fk" FOREIGN KEY ("tenant_id","surface_id","based_on_version") REFERENCES "public"."presentation_surface_versions"("tenant_id","surface_id","base_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" ADD CONSTRAINT "presentation_surface_versions_lineage_valid" CHECK (("presentation_surface_versions"."base_version" = 1 AND "presentation_surface_versions"."based_on_version" IS NULL)
          OR ("presentation_surface_versions"."base_version" > 1 AND "presentation_surface_versions"."based_on_version" > 0
              AND "presentation_surface_versions"."based_on_version" < "presentation_surface_versions"."base_version"));--> statement-breakpoint
CREATE FUNCTION public.esbla_lock_membership_capability(
  p_tenant_id uuid,
  p_actor_principal_id uuid,
  p_capability_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  capability_exists boolean := false;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
       nullif(current_setting('app.tenant_id', true), '')::uuid
     OR p_actor_principal_id IS DISTINCT FROM
       nullif(current_setting('app.actor_principal_id', true), '')::uuid
     OR p_capability_id IS NULL
     OR p_capability_id !~ '^[a-z][a-z0-9_.-]{0,159}$'
  THEN
    RETURN false;
  END IF;

  SELECT true
  INTO capability_exists
  FROM public.membership_capabilities
  WHERE tenant_id = p_tenant_id
    AND principal_id = p_actor_principal_id
    AND capability_id = p_capability_id
  FOR SHARE;

  RETURN coalesce(capability_exists, false);
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_lock_membership_capability(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_lock_membership_capability(uuid, uuid, text) TO esbla_app;--> statement-breakpoint
CREATE FUNCTION public.esbla_lock_service_activation(
  p_tenant_id uuid,
  p_actor_principal_id uuid,
  p_service_key text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  activation_state text := NULL;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
       nullif(current_setting('app.tenant_id', true), '')::uuid
     OR p_actor_principal_id IS DISTINCT FROM
       nullif(current_setting('app.actor_principal_id', true), '')::uuid
     OR p_service_key IS NULL
     OR p_service_key !~ '^[a-z][a-z0-9_.-]{0,127}$'
  THEN
    RETURN NULL;
  END IF;

  SELECT state
  INTO activation_state
  FROM public.service_activations
  WHERE tenant_id = p_tenant_id
    AND service_key = p_service_key
  FOR SHARE;

  RETURN activation_state;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_lock_service_activation(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_lock_service_activation(uuid, uuid, text) TO esbla_app;--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "presentation_surface_versions_read" ON "presentation_surface_versions";--> statement-breakpoint
CREATE POLICY "presentation_surface_versions_read" ON "presentation_surface_versions"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      (
        base_version = 1
        AND based_on_version IS NULL
        AND published_by_principal_id =
          nullif(current_setting('app.actor_principal_id', true), '')::uuid
      )
      OR
      EXISTS (
        SELECT 1
        FROM presentation_surface_heads AS current_head
        WHERE current_head.tenant_id = presentation_surface_versions.tenant_id
          AND current_head.surface_id = presentation_surface_versions.surface_id
          AND current_head.current_base_version = presentation_surface_versions.base_version
      )
      OR EXISTS (
        SELECT 1
        FROM presentation_surface_overlays AS own_overlay
        WHERE own_overlay.tenant_id = presentation_surface_versions.tenant_id
          AND own_overlay.surface_id = presentation_surface_versions.surface_id
          AND own_overlay.base_version = presentation_surface_versions.base_version
          AND own_overlay.principal_id =
            nullif(current_setting('app.actor_principal_id', true), '')::uuid
      )
      OR EXISTS (
        SELECT 1
        FROM membership_capabilities AS studio_capability
        WHERE studio_capability.tenant_id = presentation_surface_versions.tenant_id
          AND studio_capability.principal_id =
            nullif(current_setting('app.actor_principal_id', true), '')::uuid
          AND studio_capability.capability_id = ANY(ARRAY[
            'platform.studio.surface_base.read',
            'platform.studio.surface_base.draft',
            'platform.studio.surface_base.validate',
            'platform.studio.surface_base.publish',
            'platform.studio.surface_base.rollback'
          ]::text[])
      )
    )
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_versions_publish" ON "presentation_surface_versions"
  FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND published_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND base_version > 1
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_versions.tenant_id
        AND studio_capability.principal_id = presentation_surface_versions.published_by_principal_id
        AND studio_capability.capability_id = ANY(ARRAY[
          'platform.studio.surface_base.publish',
          'platform.studio.surface_base.rollback'
        ]::text[])
    )
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_heads_advance" ON "presentation_surface_heads"
  FOR UPDATE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_heads.tenant_id
        AND studio_capability.principal_id =
          nullif(current_setting('app.actor_principal_id', true), '')::uuid
        AND studio_capability.capability_id = ANY(ARRAY[
          'platform.studio.surface_base.publish',
          'platform.studio.surface_base.rollback'
        ]::text[])
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_heads.tenant_id
        AND studio_capability.principal_id = presentation_surface_heads.updated_by_principal_id
        AND studio_capability.capability_id = ANY(ARRAY[
          'platform.studio.surface_base.publish',
          'platform.studio.surface_base.rollback'
        ]::text[])
    )
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_drafts_read" ON "presentation_surface_drafts"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_drafts.tenant_id
        AND studio_capability.principal_id =
          nullif(current_setting('app.actor_principal_id', true), '')::uuid
        AND studio_capability.capability_id = ANY(ARRAY[
          'platform.studio.surface_base.read',
          'platform.studio.surface_base.draft',
          'platform.studio.surface_base.validate',
          'platform.studio.surface_base.publish',
          'platform.studio.surface_base.rollback'
        ]::text[])
    )
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_drafts_write" ON "presentation_surface_drafts"
  FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_drafts.tenant_id
        AND studio_capability.principal_id = presentation_surface_drafts.updated_by_principal_id
        AND studio_capability.capability_id = 'platform.studio.surface_base.draft'
    )
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_drafts_update" ON "presentation_surface_drafts"
  FOR UPDATE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_drafts.tenant_id
        AND studio_capability.principal_id =
          nullif(current_setting('app.actor_principal_id', true), '')::uuid
        AND studio_capability.capability_id = 'platform.studio.surface_base.draft'
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_drafts.tenant_id
        AND studio_capability.principal_id = presentation_surface_drafts.updated_by_principal_id
        AND studio_capability.capability_id = 'platform.studio.surface_base.draft'
    )
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_drafts_publish" ON "presentation_surface_drafts"
  FOR DELETE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM membership_capabilities AS studio_capability
      WHERE studio_capability.tenant_id = presentation_surface_drafts.tenant_id
        AND studio_capability.principal_id =
          nullif(current_setting('app.actor_principal_id', true), '')::uuid
        AND studio_capability.capability_id = 'platform.studio.surface_base.publish'
    )
  );--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_drafts" FROM "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "presentation_surface_drafts" TO "esbla_app";--> statement-breakpoint
GRANT UPDATE ON TABLE "presentation_surface_heads" TO "esbla_app";--> statement-breakpoint
GRANT DELETE ON TABLE "presentation_surface_overlays" TO "esbla_app";
