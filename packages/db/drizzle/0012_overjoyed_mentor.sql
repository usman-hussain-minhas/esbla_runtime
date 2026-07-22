CREATE TYPE "public"."hr_employment_record_status" AS ENUM('draft', 'active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."hr_employment_version_kind" AS ENUM('effective', 'end');--> statement-breakpoint
CREATE TABLE "hr_employment_record_service_control" (
	"service_control_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_key" text DEFAULT 'employment_record' NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_employment_record_service_control_key_exact" CHECK ("hr_employment_record_service_control"."service_key" = 'employment_record'),
	CONSTRAINT "hr_employment_record_service_control_settings_version_positive" CHECK ("hr_employment_record_service_control"."settings_version" > 0),
	CONSTRAINT "hr_employment_record_service_control_row_version_positive" CHECK ("hr_employment_record_service_control"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_employment_record_service_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_employment_record_versions" (
	"employment_record_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_record_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"employment_type_code" text,
	"organization_reference" text,
	"position_reference" text,
	"supersedes_version_id" uuid,
	"version" integer NOT NULL,
	"version_kind" "hr_employment_version_kind" NOT NULL,
	"terminal_version" boolean DEFAULT false NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_employment_record_versions_composite_identity" UNIQUE("tenant_id","employment_record_id","employment_record_version_id"),
	CONSTRAINT "hr_employment_record_versions_effective_range_valid" CHECK ("hr_employment_record_versions"."effective_to" IS NULL OR "hr_employment_record_versions"."effective_to" >= "hr_employment_record_versions"."effective_from"),
	CONSTRAINT "hr_employment_record_versions_identifier_values_valid" CHECK (("hr_employment_record_versions"."employment_type_code" IS NULL OR char_length(trim("hr_employment_record_versions"."employment_type_code")) > 0)
          AND ("hr_employment_record_versions"."organization_reference" IS NULL OR char_length(trim("hr_employment_record_versions"."organization_reference")) > 0)
          AND ("hr_employment_record_versions"."position_reference" IS NULL OR char_length(trim("hr_employment_record_versions"."position_reference")) > 0)),
	CONSTRAINT "hr_employment_record_versions_predecessor_version_consistent" CHECK (("hr_employment_record_versions"."version" = 1 AND "hr_employment_record_versions"."supersedes_version_id" IS NULL)
          OR ("hr_employment_record_versions"."version" > 1 AND "hr_employment_record_versions"."supersedes_version_id" IS NOT NULL)),
	CONSTRAINT "hr_employment_record_versions_terminal_kind_consistent" CHECK (("hr_employment_record_versions"."version_kind" = 'effective' AND "hr_employment_record_versions"."terminal_version" = false)
          OR ("hr_employment_record_versions"."version_kind" = 'end' AND "hr_employment_record_versions"."terminal_version" = true
              AND "hr_employment_record_versions"."effective_to" IS NOT NULL)),
	CONSTRAINT "hr_employment_record_versions_version_positive" CHECK ("hr_employment_record_versions"."version" > 0),
	CONSTRAINT "hr_employment_record_versions_row_version_fixed" CHECK ("hr_employment_record_versions"."row_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_employment_record_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_employment_records" (
	"employment_record_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"status" "hr_employment_record_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_employment_records_composite_identity" UNIQUE("tenant_id","employment_record_id"),
	CONSTRAINT "hr_employment_records_status_head_consistent" CHECK (("hr_employment_records"."status" = 'draft' AND "hr_employment_records"."current_version_id" IS NULL)
          OR ("hr_employment_records"."status" IN ('active', 'ended') AND "hr_employment_records"."current_version_id" IS NOT NULL)),
	CONSTRAINT "hr_employment_records_row_version_positive" CHECK ("hr_employment_records"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_employment_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_employment_record_service_control" ADD CONSTRAINT "hr_employment_record_service_control_activation_fk" FOREIGN KEY ("tenant_id","service_key") REFERENCES "public"."service_activations"("tenant_id","service_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_record_versions" ADD CONSTRAINT "hr_employment_record_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_record_versions" ADD CONSTRAINT "hr_employment_record_versions_record_same_tenant_fk" FOREIGN KEY ("tenant_id","employment_record_id") REFERENCES "public"."hr_employment_records"("tenant_id","employment_record_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_record_versions" ADD CONSTRAINT "hr_employment_record_versions_worker_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_record_versions" ADD CONSTRAINT "hr_employment_record_versions_predecessor_same_root_fk" FOREIGN KEY ("tenant_id","employment_record_id","supersedes_version_id") REFERENCES "public"."hr_employment_record_versions"("tenant_id","employment_record_id","employment_record_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_records" ADD CONSTRAINT "hr_employment_records_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_records" ADD CONSTRAINT "hr_employment_records_worker_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_records" ADD CONSTRAINT "hr_employment_records_current_version_same_root_fk" FOREIGN KEY ("tenant_id","employment_record_id","current_version_id") REFERENCES "public"."hr_employment_record_versions"("tenant_id","employment_record_id","employment_record_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_employment_record_service_control_tenant_key" ON "hr_employment_record_service_control" USING btree ("tenant_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_employment_record_versions_tenant_record_version" ON "hr_employment_record_versions" USING btree ("tenant_id","employment_record_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_employment_record_versions_tenant_successor" ON "hr_employment_record_versions" USING btree ("tenant_id","employment_record_id","supersedes_version_id") WHERE "hr_employment_record_versions"."supersedes_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_hr_employment_record_versions_tenant_record_cursor" ON "hr_employment_record_versions" USING btree ("tenant_id","employment_record_id","version" DESC NULLS LAST,"employment_record_version_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hr_employment_records_tenant_cursor" ON "hr_employment_records" USING btree ("tenant_id","worker_profile_id","created_at" DESC NULLS LAST,"employment_record_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hr_employment_records_tenant_worker_active_head" ON "hr_employment_records" USING btree ("tenant_id","worker_profile_id","status","employment_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_employment_records_tenant_worker_current" ON "hr_employment_records" USING btree ("tenant_id","worker_profile_id") WHERE "hr_employment_records"."status" <> 'ended';
--> statement-breakpoint
ALTER TABLE "hr_employment_record_service_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_employment_record_service_control_tenant_isolation"
  ON "hr_employment_record_service_control"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_employment_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_employment_records_tenant_isolation"
  ON "hr_employment_records"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_employment_record_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_employment_record_versions_tenant_isolation"
  ON "hr_employment_record_versions"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_employment_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'employment record service control cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employment record service control cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'employment_record'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record service is inactive'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.service_control_id := pg_catalog.gen_random_uuid();
    NEW.service_key := 'employment_record';
    NEW.settings_version := 1;
    NEW.updated_at := pg_catalog.statement_timestamp();
    NEW.row_version := 1;
    RETURN NEW;
  END IF;

  IF NEW.service_control_id IS DISTINCT FROM OLD.service_control_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.settings_version <> OLD.settings_version + 1
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'employment record service control transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := GREATEST(
    pg_catalog.statement_timestamp(), OLD.updated_at + interval '1 microsecond'
  );
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_employment_service_control"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_employment_record_version"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_head uuid;
  current_status public.hr_employment_record_status;
  current_worker uuid;
  prior_version integer;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'employment record versions are append-only'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'employment_record'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record service is inactive'
      USING ERRCODE = '55000';
  END IF;

  SELECT record.status, record.current_version_id, record.worker_profile_id
    INTO current_status, current_head, current_worker
    FROM public.hr_employment_records AS record
    WHERE record.tenant_id = NEW.tenant_id
      AND record.employment_record_id = NEW.employment_record_id
    FOR UPDATE NOWAIT;
  IF NOT FOUND OR current_status = 'ended' THEN
    RAISE EXCEPTION 'employment record is not mutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.worker_profile_id IS DISTINCT FROM current_worker THEN
    RAISE EXCEPTION 'employment record version worker is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.supersedes_version_id IS DISTINCT FROM current_head THEN
    RAISE EXCEPTION 'employment record predecessor is not current'
      USING ERRCODE = '55000';
  END IF;

  IF current_head IS NULL THEN
    IF current_status <> 'draft' OR NEW.version <> 1 OR NEW.version_kind <> 'effective'
       OR NEW.terminal_version THEN
      RAISE EXCEPTION 'employment record first version is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT version.version
      INTO prior_version
      FROM public.hr_employment_record_versions AS version
      WHERE version.tenant_id = NEW.tenant_id
        AND version.employment_record_id = NEW.employment_record_id
        AND version.employment_record_version_id = current_head;
    IF prior_version IS NULL OR NEW.version <> prior_version + 1 THEN
      RAISE EXCEPTION 'employment record version must advance exactly'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  NEW.employment_record_version_id := pg_catalog.gen_random_uuid();
  NEW.row_version := 1;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_employment_record_version"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_employment_record_root"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_kind public.hr_employment_version_kind;
  candidate_predecessor uuid;
  candidate_terminal boolean;
  candidate_version integer;
  candidate_worker uuid;
  prior_version integer;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'employment records cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employment records cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'employment_record'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employment record service is inactive'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.employment_record_id := pg_catalog.gen_random_uuid();
    NEW.status := 'draft';
    NEW.current_version_id := NULL;
    NEW.created_at := pg_catalog.statement_timestamp();
    NEW.row_version := 1;
    RETURN NEW;
  END IF;

  IF OLD.status = 'ended' THEN
    RAISE EXCEPTION 'ended employment records are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.employment_record_id IS DISTINCT FROM OLD.employment_record_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.worker_profile_id IS DISTINCT FROM OLD.worker_profile_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.row_version <> OLD.row_version + 1
     OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id THEN
    RAISE EXCEPTION 'employment record root transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT version.worker_profile_id, version.supersedes_version_id,
         version.version, version.version_kind, version.terminal_version
    INTO candidate_worker, candidate_predecessor, candidate_version,
         candidate_kind, candidate_terminal
    FROM public.hr_employment_record_versions AS version
    WHERE version.tenant_id = NEW.tenant_id
      AND version.employment_record_id = NEW.employment_record_id
      AND version.employment_record_version_id = NEW.current_version_id;
  IF NOT FOUND OR candidate_worker IS DISTINCT FROM NEW.worker_profile_id
     OR candidate_predecessor IS DISTINCT FROM OLD.current_version_id THEN
    RAISE EXCEPTION 'employment record head transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'active' OR candidate_version <> 1
       OR candidate_kind <> 'effective' OR candidate_terminal THEN
      RAISE EXCEPTION 'employment record first head transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT version.version INTO prior_version
      FROM public.hr_employment_record_versions AS version
      WHERE version.tenant_id = OLD.tenant_id
        AND version.employment_record_id = OLD.employment_record_id
        AND version.employment_record_version_id = OLD.current_version_id;
    IF prior_version IS NULL OR candidate_version <> prior_version + 1 THEN
      RAISE EXCEPTION 'employment record head version is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'active' THEN
      IF candidate_kind <> 'effective' OR candidate_terminal THEN
        RAISE EXCEPTION 'employment record active head transition is invalid'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.status = 'ended' THEN
      IF candidate_kind <> 'end' OR NOT candidate_terminal THEN
        RAISE EXCEPTION 'employment record terminal head transition is invalid'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'employment record status transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_employment_record_root"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "esbla_require_hr_employment_record_version_chain"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    WITH RECURSIVE chain(employment_record_version_id) AS (
      SELECT NEW.employment_record_version_id
      UNION ALL
      SELECT successor.employment_record_version_id
        FROM public.hr_employment_record_versions AS successor
        JOIN chain
          ON successor.supersedes_version_id = chain.employment_record_version_id
        WHERE successor.tenant_id = NEW.tenant_id
          AND successor.employment_record_id = NEW.employment_record_id
    )
    SELECT 1
      FROM public.hr_employment_records AS record
      JOIN chain ON chain.employment_record_version_id = record.current_version_id
      WHERE record.tenant_id = NEW.tenant_id
        AND record.employment_record_id = NEW.employment_record_id
  ) THEN
    RAISE EXCEPTION 'employment record version is not linked to the current head'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_require_hr_employment_record_version_chain"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_employment_record_service_control_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_employment_record_service_control"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_employment_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_employment_record_service_control_reject_truncate"
  BEFORE TRUNCATE ON "hr_employment_record_service_control"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_employment_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_employment_record_versions_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_employment_record_versions"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_employment_record_version"();--> statement-breakpoint
CREATE TRIGGER "hr_employment_record_versions_reject_truncate"
  BEFORE TRUNCATE ON "hr_employment_record_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_employment_record_version"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "hr_employment_record_versions_require_current_chain"
  AFTER INSERT ON "hr_employment_record_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "esbla_require_hr_employment_record_version_chain"();--> statement-breakpoint
CREATE TRIGGER "hr_employment_records_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_employment_records"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_employment_record_root"();--> statement-breakpoint
CREATE TRIGGER "hr_employment_records_reject_truncate"
  BEFORE TRUNCATE ON "hr_employment_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_employment_record_root"();--> statement-breakpoint
GRANT USAGE ON TYPE "hr_employment_record_status", "hr_employment_version_kind" TO "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "hr_employment_record_service_control" TO "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "hr_employment_records" TO "esbla_app";--> statement-breakpoint
GRANT SELECT, INSERT ON "hr_employment_record_versions" TO "esbla_app";
