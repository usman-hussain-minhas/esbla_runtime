CREATE TABLE "presentation_setting_values" (
	"tenant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_principal_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_setting_values_pk" PRIMARY KEY("tenant_id","subject_type","subject_id","setting_key"),
	CONSTRAINT "presentation_setting_values_subject_type_valid" CHECK ("presentation_setting_values"."subject_type" IN ('tenant_default', 'user_override')),
	CONSTRAINT "presentation_setting_values_subject_shape_valid" CHECK ("presentation_setting_values"."subject_type" <> 'tenant_default' OR "presentation_setting_values"."subject_id" = "presentation_setting_values"."tenant_id"),
	CONSTRAINT "presentation_setting_values_key_valid" CHECK ("presentation_setting_values"."setting_key" IN ('appearance.palette.v1', 'appearance.high_contrast.v1')),
	CONSTRAINT "presentation_setting_values_version_positive" CHECK ("presentation_setting_values"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "presentation_setting_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "presentation_setting_values" ADD CONSTRAINT "presentation_setting_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_setting_values" ADD CONSTRAINT "presentation_setting_values_updater_membership_fk" FOREIGN KEY ("tenant_id","updated_by_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentation_setting_values_tenant_subject_idx" ON "presentation_setting_values" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
ALTER TABLE "presentation_setting_values" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "presentation_setting_values_read" ON "presentation_setting_values"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      subject_type = 'tenant_default'
      OR (
        subject_type = 'user_override'
        AND subject_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
      )
    )
  );--> statement-breakpoint
CREATE POLICY "presentation_setting_values_write_own" ON "presentation_setting_values"
  FOR ALL
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND subject_type = 'user_override'
    AND subject_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND updated_by_principal_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND subject_type = 'user_override'
    AND subject_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND updated_by_principal_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
  );--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_setting_values" FROM "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "presentation_setting_values" TO "esbla_app";
