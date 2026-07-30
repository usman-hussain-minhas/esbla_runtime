ALTER TABLE "presentation_setting_values" DROP CONSTRAINT "presentation_setting_values_key_valid";--> statement-breakpoint
ALTER TABLE "presentation_setting_values" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "presentation_setting_values" ADD CONSTRAINT "presentation_setting_values_value_valid" CHECK ((
        ("presentation_setting_values"."setting_key" = 'appearance.palette.v1'
          AND "presentation_setting_values"."value" IN ('"light"'::jsonb, '"dark"'::jsonb))
        OR ("presentation_setting_values"."setting_key" = 'appearance.high_contrast.v1'
          AND "presentation_setting_values"."value" IN ('true'::jsonb, 'false'::jsonb))
        OR ("presentation_setting_values"."setting_key" = 'appearance.reduced_motion.v1'
          AND "presentation_setting_values"."value" IN ('"auto"'::jsonb, '"reduce"'::jsonb))
        OR ("presentation_setting_values"."setting_key" = 'appearance.density.v1'
          AND "presentation_setting_values"."value" IN ('"comfortable"'::jsonb, '"compact"'::jsonb))
      ));--> statement-breakpoint
ALTER TABLE "presentation_setting_values" ADD CONSTRAINT "presentation_setting_values_lock_valid" CHECK ((
        "presentation_setting_values"."locked" = false
        OR (
          "presentation_setting_values"."subject_type" = 'tenant_default'
          AND (
            "presentation_setting_values"."setting_key" = 'appearance.density.v1'
            OR ("presentation_setting_values"."setting_key" = 'appearance.high_contrast.v1'
              AND "presentation_setting_values"."value" = 'true'::jsonb)
            OR ("presentation_setting_values"."setting_key" = 'appearance.reduced_motion.v1'
              AND "presentation_setting_values"."value" = '"reduce"'::jsonb)
          )
        )
      ));--> statement-breakpoint
ALTER TABLE "presentation_setting_values" ADD CONSTRAINT "presentation_setting_values_key_valid" CHECK ("presentation_setting_values"."setting_key" IN (
        'appearance.palette.v1',
        'appearance.high_contrast.v1',
        'appearance.reduced_motion.v1',
        'appearance.density.v1'
      ));--> statement-breakpoint
ALTER TABLE "presentation_setting_values" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "presentation_setting_values"
    GROUP BY "tenant_id", "subject_type", "subject_id"
    HAVING count(DISTINCT "version") <> 1
  ) THEN
    RAISE EXCEPTION 'presentation setting layer contains mixed versions';
  END IF;
END
$$;--> statement-breakpoint
WITH "layers" AS (
  SELECT DISTINCT ON ("tenant_id", "subject_type", "subject_id")
    "tenant_id",
    "subject_type",
    "subject_id",
    "version",
    "updated_by_principal_id",
    "updated_at"
  FROM "presentation_setting_values"
  ORDER BY "tenant_id", "subject_type", "subject_id", "updated_at" DESC, "setting_key"
),
"defaults"("setting_key", "value") AS (
  VALUES
    ('appearance.palette.v1', '"light"'::jsonb),
    ('appearance.high_contrast.v1', 'false'::jsonb),
    ('appearance.reduced_motion.v1', '"auto"'::jsonb),
    ('appearance.density.v1', '"comfortable"'::jsonb)
)
INSERT INTO "presentation_setting_values"
  ("tenant_id", "subject_type", "subject_id", "setting_key", "value", "locked",
   "version", "updated_by_principal_id", "updated_at")
SELECT
  "layers"."tenant_id",
  "layers"."subject_type",
  "layers"."subject_id",
  "defaults"."setting_key",
  "defaults"."value",
  false,
  "layers"."version",
  "layers"."updated_by_principal_id",
  "layers"."updated_at"
FROM "layers"
CROSS JOIN "defaults"
ON CONFLICT ("tenant_id", "subject_type", "subject_id", "setting_key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "presentation_setting_values" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "presentation_setting_values_write_tenant" ON "presentation_setting_values"
  FOR ALL
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND subject_type = 'tenant_default'
    AND subject_id = tenant_id
    AND public.esbla_lock_membership_capability(
      tenant_id,
      nullif(current_setting('app.actor_principal_id', true), '')::uuid,
      'platform.presentation.tenant_defaults.write'
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND subject_type = 'tenant_default'
    AND subject_id = tenant_id
    AND updated_by_principal_id = nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND public.esbla_lock_membership_capability(
      tenant_id,
      nullif(current_setting('app.actor_principal_id', true), '')::uuid,
      'platform.presentation.tenant_defaults.write'
    )
  );--> statement-breakpoint
GRANT DELETE ON TABLE "presentation_setting_values" TO "esbla_app";
