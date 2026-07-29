CREATE TABLE "presentation_shortcut_user_patches" (
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"context_kind" text NOT NULL,
	"context_id" text NOT NULL,
	"patch" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_principal_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_shortcut_user_patches_pk" PRIMARY KEY("tenant_id","principal_id","setting_key","context_kind","context_id"),
	CONSTRAINT "presentation_shortcut_user_patches_setting_context_valid" CHECK ((
        "presentation_shortcut_user_patches"."setting_key" = 'navigation.universal_shortcuts.v1'
        AND "presentation_shortcut_user_patches"."context_kind" = 'global'
        AND "presentation_shortcut_user_patches"."context_id" = 'global'
      ) OR (
        "presentation_shortcut_user_patches"."setting_key" = 'navigation.contextual_shortcuts.v1'
        AND "presentation_shortcut_user_patches"."context_kind" IN ('service', 'surface')
        AND char_length(trim("presentation_shortcut_user_patches"."context_id")) BETWEEN 1 AND 160
      )),
	CONSTRAINT "presentation_shortcut_user_patches_own_actor_valid" CHECK ("presentation_shortcut_user_patches"."principal_id" = "presentation_shortcut_user_patches"."updated_by_principal_id"),
	CONSTRAINT "presentation_shortcut_user_patches_patch_object_valid" CHECK (jsonb_typeof("presentation_shortcut_user_patches"."patch") = 'object'),
	CONSTRAINT "presentation_shortcut_user_patches_version_positive" CHECK ("presentation_shortcut_user_patches"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "presentation_shortcut_user_patches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_shortcut_user_patches" ADD CONSTRAINT "presentation_shortcut_user_patches_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_shortcut_user_patches" ADD CONSTRAINT "presentation_shortcut_user_patches_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_shortcut_user_patches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "presentation_shortcut_user_patches_read_own"
  ON "presentation_shortcut_user_patches"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "presentation_shortcut_user_patches_write_own"
  ON "presentation_shortcut_user_patches"
  FOR ALL
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
  );--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_shortcut_user_patches" FROM "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "presentation_shortcut_user_patches" TO "esbla_app";
