CREATE TABLE "hr_workforce_profile_service_control" (
	"service_control_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_key" text DEFAULT 'workforce_profile' NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_workforce_profile_service_control_key_exact" CHECK ("hr_workforce_profile_service_control"."service_key" = 'workforce_profile'),
	CONSTRAINT "hr_workforce_profile_service_control_settings_version_positive" CHECK ("hr_workforce_profile_service_control"."settings_version" > 0),
	CONSTRAINT "hr_workforce_profile_service_control_row_version_positive" CHECK ("hr_workforce_profile_service_control"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_workforce_profile_service_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_workforce_profile_service_control" ADD CONSTRAINT "hr_workforce_profile_service_control_activation_fk" FOREIGN KEY ("tenant_id","service_key") REFERENCES "public"."service_activations"("tenant_id","service_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_workforce_profile_service_control_tenant_key" ON "hr_workforce_profile_service_control" USING btree ("tenant_id","service_key");--> statement-breakpoint
ALTER TABLE "hr_workforce_profile_service_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_workforce_profile_service_control_tenant_isolation"
  ON "hr_workforce_profile_service_control"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_workforce_profile_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'workforce profile service control cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'workforce profile service control is activation-managed'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'workforce_profile'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid workforce profile service control creation'
        USING ERRCODE = '55000';
    END IF;

    SELECT activation.state, activation.version
      INTO authority_state, authority_version
      FROM public.service_activations AS activation
      WHERE activation.tenant_id = NEW.tenant_id
        AND activation.service_key = NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'workforce profile activation authority is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.service_control_id, NEW.tenant_id, NEW.service_key, NEW.settings_version)
     IS DISTINCT FROM
     (OLD.service_control_id, OLD.tenant_id, OLD.service_key, OLD.settings_version) THEN
    RAISE EXCEPTION 'immutable workforce profile service control fields changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'invalid workforce profile service control revision'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile activation authority is missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_workforce_profile_service_control"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_workforce_profile_service_control_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_workforce_profile_service_control"
  FOR EACH ROW
  EXECUTE FUNCTION "esbla_enforce_hr_workforce_profile_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_workforce_profile_service_control_reject_truncate"
  BEFORE TRUNCATE ON "hr_workforce_profile_service_control"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "esbla_enforce_hr_workforce_profile_service_control"();--> statement-breakpoint
CREATE FUNCTION "esbla_sync_hr_workforce_profile_service_activation"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  synchronized_rows integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'workforce_profile' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'invalid initial workforce profile activation authority'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.hr_workforce_profile_service_control
      (tenant_id, service_key, settings_version, updated_at, row_version)
    VALUES
      (NEW.tenant_id, NEW.service_key, 1, pg_catalog.statement_timestamp(), 1);
    RETURN NEW;
  END IF;

  IF OLD.service_key <> 'workforce_profile' AND NEW.service_key <> 'workforce_profile' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.service_key <> 'workforce_profile'
     OR NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid workforce profile activation authority transition'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.hr_workforce_profile_service_control AS control
    SET updated_at = GREATEST(
          pg_catalog.statement_timestamp(),
          control.updated_at + interval '1 microsecond'
        ),
        row_version = NEW.version
    WHERE control.tenant_id = NEW.tenant_id
      AND control.service_key = NEW.service_key
      AND control.row_version = OLD.version;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'workforce profile service control projection is missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_sync_hr_workforce_profile_service_activation"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "service_activations_sync_hr_workforce_profile"
  AFTER INSERT OR UPDATE ON "service_activations"
  FOR EACH ROW
  EXECUTE FUNCTION "esbla_sync_hr_workforce_profile_service_activation"();--> statement-breakpoint
DO $$
DECLARE
  governed_tenant_id uuid;
BEGIN
  FOR governed_tenant_id IN
    SELECT tenant.tenant_id FROM public.tenants AS tenant
  LOOP
    PERFORM pg_catalog.set_config('app.tenant_id', governed_tenant_id::text, true);
    IF EXISTS (
      SELECT 1
        FROM public.service_activations AS activation
        WHERE activation.tenant_id = governed_tenant_id
          AND activation.service_key = 'workforce_profile'
    ) THEN
      RAISE EXCEPTION 'pre-existing workforce profile activation lacks governed service control'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.tenant_id', '', true);
END
$$;
