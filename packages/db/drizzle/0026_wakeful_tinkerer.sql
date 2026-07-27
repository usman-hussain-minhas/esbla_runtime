CREATE TABLE "presentation_surface_heads" (
	"tenant_id" uuid NOT NULL,
	"surface_id" text NOT NULL,
	"current_base_version" integer NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"updated_by_principal_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_surface_heads_pk" PRIMARY KEY("tenant_id","surface_id"),
	CONSTRAINT "presentation_surface_heads_surface_valid" CHECK ("presentation_surface_heads"."surface_id" IN ('surface.mission-control', 'surface.hr.mission-control')),
	CONSTRAINT "presentation_surface_heads_current_version_positive" CHECK ("presentation_surface_heads"."current_base_version" > 0),
	CONSTRAINT "presentation_surface_heads_row_version_positive" CHECK ("presentation_surface_heads"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "presentation_surface_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "presentation_surface_overlays" (
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"surface_id" text NOT NULL,
	"base_version" integer NOT NULL,
	"layout" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_principal_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_surface_overlays_pk" PRIMARY KEY("tenant_id","principal_id","surface_id"),
	CONSTRAINT "presentation_surface_overlays_surface_valid" CHECK ("presentation_surface_overlays"."surface_id" IN ('surface.mission-control', 'surface.hr.mission-control')),
	CONSTRAINT "presentation_surface_overlays_base_version_positive" CHECK ("presentation_surface_overlays"."base_version" > 0),
	CONSTRAINT "presentation_surface_overlays_layout_array" CHECK (jsonb_typeof("presentation_surface_overlays"."layout") = 'array'),
	CONSTRAINT "presentation_surface_overlays_version_positive" CHECK ("presentation_surface_overlays"."version" > 0),
	CONSTRAINT "presentation_surface_overlays_own_update" CHECK ("presentation_surface_overlays"."principal_id" = "presentation_surface_overlays"."updated_by_principal_id")
);
--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "presentation_surface_versions" (
	"tenant_id" uuid NOT NULL,
	"surface_id" text NOT NULL,
	"base_version" integer NOT NULL,
	"definition_hash" text NOT NULL,
	"layout" jsonb NOT NULL,
	"published_by_principal_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_surface_versions_pk" PRIMARY KEY("tenant_id","surface_id","base_version"),
	CONSTRAINT "presentation_surface_versions_surface_valid" CHECK ("presentation_surface_versions"."surface_id" IN ('surface.mission-control', 'surface.hr.mission-control')),
	CONSTRAINT "presentation_surface_versions_base_version_positive" CHECK ("presentation_surface_versions"."base_version" > 0),
	CONSTRAINT "presentation_surface_versions_definition_hash_valid" CHECK ("presentation_surface_versions"."definition_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "presentation_surface_versions_layout_array" CHECK (jsonb_typeof("presentation_surface_versions"."layout") = 'array')
);
--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_heads" ADD CONSTRAINT "presentation_surface_heads_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_heads" ADD CONSTRAINT "presentation_surface_heads_current_version_fk" FOREIGN KEY ("tenant_id","surface_id","current_base_version") REFERENCES "public"."presentation_surface_versions"("tenant_id","surface_id","base_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_heads" ADD CONSTRAINT "presentation_surface_heads_updater_membership_fk" FOREIGN KEY ("tenant_id","updated_by_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" ADD CONSTRAINT "presentation_surface_overlays_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" ADD CONSTRAINT "presentation_surface_overlays_owner_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" ADD CONSTRAINT "presentation_surface_overlays_base_version_fk" FOREIGN KEY ("tenant_id","surface_id","base_version") REFERENCES "public"."presentation_surface_versions"("tenant_id","surface_id","base_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" ADD CONSTRAINT "presentation_surface_overlays_updater_membership_fk" FOREIGN KEY ("tenant_id","updated_by_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" ADD CONSTRAINT "presentation_surface_versions_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" ADD CONSTRAINT "presentation_surface_versions_publisher_membership_fk" FOREIGN KEY ("tenant_id","published_by_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentation_surface_overlays_tenant_principal_idx" ON "presentation_surface_overlays" USING btree ("tenant_id","principal_id");--> statement-breakpoint
CREATE INDEX "presentation_surface_versions_tenant_surface_published_idx" ON "presentation_surface_versions" USING btree ("tenant_id","surface_id","published_at");--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "presentation_surface_versions_read" ON "presentation_surface_versions"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_versions_initialize" ON "presentation_surface_versions"
  FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND published_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND base_version = 1
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_heads_read" ON "presentation_surface_heads"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_heads_initialize" ON "presentation_surface_heads"
  FOR INSERT
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND current_base_version = 1
    AND row_version = 1
  );--> statement-breakpoint
CREATE POLICY "presentation_surface_overlays_own" ON "presentation_surface_overlays"
  FOR ALL
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND principal_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND principal_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND updated_by_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
  );--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_versions" FROM "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "presentation_surface_versions" TO "esbla_app";--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_heads" FROM "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "presentation_surface_heads" TO "esbla_app";--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_overlays" FROM "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "presentation_surface_overlays" TO "esbla_app";
