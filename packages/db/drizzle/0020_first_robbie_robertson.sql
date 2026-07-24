CREATE TYPE "public"."hr_timesheet_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hr_timesheet_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "hr_timesheet_approvals" (
	"timesheet_approval_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"timesheet_version_id" uuid NOT NULL,
	"approver_worker_profile_id" uuid NOT NULL,
	"decision" "hr_timesheet_decision" NOT NULL,
	"decision_note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" uuid NOT NULL,
	CONSTRAINT "hr_timesheet_approvals_note_valid" CHECK ("hr_timesheet_approvals"."decision_note" IS NULL
          OR char_length(trim("hr_timesheet_approvals"."decision_note")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "hr_timesheet_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_timesheet_entries" (
	"timesheet_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"timesheet_version_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_timesheet_entries_minutes_valid" CHECK ("hr_timesheet_entries"."minutes" BETWEEN 1 AND 1440),
	CONSTRAINT "hr_timesheet_entries_description_valid" CHECK ("hr_timesheet_entries"."description" IS NULL
          OR char_length(trim("hr_timesheet_entries"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "hr_timesheet_entries_row_version_positive" CHECK ("hr_timesheet_entries"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_timesheet_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_timesheet_service_control" (
	"service_control_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_key" text DEFAULT 'timesheet' NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_timesheet_service_control_key_exact" CHECK ("hr_timesheet_service_control"."service_key" = 'timesheet'),
	CONSTRAINT "hr_timesheet_service_control_settings_version_positive" CHECK ("hr_timesheet_service_control"."settings_version" > 0),
	CONSTRAINT "hr_timesheet_service_control_row_version_positive" CHECK ("hr_timesheet_service_control"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_timesheet_service_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_timesheet_versions" (
	"timesheet_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"timesheet_id" uuid NOT NULL,
	"supersedes_version_id" uuid,
	"version" integer NOT NULL,
	"status" "hr_timesheet_status" DEFAULT 'draft' NOT NULL,
	"assigned_approver_worker_profile_id" uuid,
	"submitted_at" timestamp with time zone,
	"total_minutes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_timesheet_versions_composite_identity" UNIQUE("tenant_id","timesheet_id","timesheet_version_id"),
	CONSTRAINT "uq_hr_timesheet_versions_tenant_identity" UNIQUE("tenant_id","timesheet_version_id"),
	CONSTRAINT "hr_timesheet_versions_predecessor_version_consistent" CHECK (("hr_timesheet_versions"."version" = 1 AND "hr_timesheet_versions"."supersedes_version_id" IS NULL)
          OR ("hr_timesheet_versions"."version" > 1 AND "hr_timesheet_versions"."supersedes_version_id" IS NOT NULL)),
	CONSTRAINT "hr_timesheet_versions_submission_consistent" CHECK (("hr_timesheet_versions"."status" = 'draft'
            AND "hr_timesheet_versions"."assigned_approver_worker_profile_id" IS NULL
            AND "hr_timesheet_versions"."submitted_at" IS NULL)
          OR ("hr_timesheet_versions"."status" IN ('submitted', 'approved', 'rejected')
            AND "hr_timesheet_versions"."assigned_approver_worker_profile_id" IS NOT NULL
            AND "hr_timesheet_versions"."submitted_at" IS NOT NULL)),
	CONSTRAINT "hr_timesheet_versions_total_minutes_valid" CHECK ("hr_timesheet_versions"."total_minutes" >= 0),
	CONSTRAINT "hr_timesheet_versions_version_positive" CHECK ("hr_timesheet_versions"."version" > 0),
	CONSTRAINT "hr_timesheet_versions_row_version_positive" CHECK ("hr_timesheet_versions"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_timesheet_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_timesheets" (
	"timesheet_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"current_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_timesheets_composite_identity" UNIQUE("tenant_id","timesheet_id"),
	CONSTRAINT "hr_timesheets_period_valid" CHECK ("hr_timesheets"."period_end" >= "hr_timesheets"."period_start"),
	CONSTRAINT "hr_timesheets_row_version_positive" CHECK ("hr_timesheets"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_timesheets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_timesheet_approvals" ADD CONSTRAINT "hr_timesheet_approvals_version_same_tenant_fk" FOREIGN KEY ("tenant_id","timesheet_version_id") REFERENCES "public"."hr_timesheet_versions"("tenant_id","timesheet_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheet_approvals" ADD CONSTRAINT "hr_timesheet_approvals_approver_same_tenant_fk" FOREIGN KEY ("tenant_id","approver_worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheet_entries" ADD CONSTRAINT "hr_timesheet_entries_version_same_tenant_fk" FOREIGN KEY ("tenant_id","timesheet_version_id") REFERENCES "public"."hr_timesheet_versions"("tenant_id","timesheet_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheet_service_control" ADD CONSTRAINT "hr_timesheet_service_control_activation_fk" FOREIGN KEY ("tenant_id","service_key") REFERENCES "public"."service_activations"("tenant_id","service_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheet_versions" ADD CONSTRAINT "hr_timesheet_versions_timesheet_same_tenant_fk" FOREIGN KEY ("tenant_id","timesheet_id") REFERENCES "public"."hr_timesheets"("tenant_id","timesheet_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheet_versions" ADD CONSTRAINT "hr_timesheet_versions_predecessor_same_root_fk" FOREIGN KEY ("tenant_id","timesheet_id","supersedes_version_id") REFERENCES "public"."hr_timesheet_versions"("tenant_id","timesheet_id","timesheet_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheet_versions" ADD CONSTRAINT "hr_timesheet_versions_approver_same_tenant_fk" FOREIGN KEY ("tenant_id","assigned_approver_worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheets" ADD CONSTRAINT "hr_timesheets_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheets" ADD CONSTRAINT "hr_timesheets_worker_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_timesheets" ADD CONSTRAINT "hr_timesheets_current_version_same_root_fk" FOREIGN KEY ("tenant_id","timesheet_id","current_version_id") REFERENCES "public"."hr_timesheet_versions"("tenant_id","timesheet_id","timesheet_version_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_timesheet_approvals_tenant_version" ON "hr_timesheet_approvals" USING btree ("tenant_id","timesheet_version_id");--> statement-breakpoint
CREATE INDEX "idx_hr_timesheet_entries_tenant_version_date" ON "hr_timesheet_entries" USING btree ("tenant_id","timesheet_version_id","entry_date","timesheet_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_timesheet_service_control_tenant_key" ON "hr_timesheet_service_control" USING btree ("tenant_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_timesheet_versions_tenant_number" ON "hr_timesheet_versions" USING btree ("tenant_id","timesheet_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_timesheet_versions_tenant_successor" ON "hr_timesheet_versions" USING btree ("tenant_id","timesheet_id","supersedes_version_id") WHERE "hr_timesheet_versions"."supersedes_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_hr_timesheet_versions_tenant_approver_submitted" ON "hr_timesheet_versions" USING btree ("tenant_id","assigned_approver_worker_profile_id","status","submitted_at","timesheet_version_id");--> statement-breakpoint
CREATE INDEX "idx_hr_timesheet_versions_tenant_timesheet_cursor" ON "hr_timesheet_versions" USING btree ("tenant_id","timesheet_id","version" DESC NULLS LAST,"timesheet_version_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hr_timesheets_tenant_worker_period_cursor" ON "hr_timesheets" USING btree ("tenant_id","worker_profile_id","period_start" DESC NULLS LAST,"timesheet_id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_timesheets_tenant_worker_period" ON "hr_timesheets" USING btree ("tenant_id","worker_profile_id","period_start","period_end");--> statement-breakpoint
ALTER TABLE "hr_timesheet_approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_timesheet_approvals_tenant_isolation"
  ON "hr_timesheet_approvals" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_timesheet_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_timesheet_entries_tenant_isolation"
  ON "hr_timesheet_entries" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_timesheet_service_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_timesheet_service_control_tenant_isolation"
  ON "hr_timesheet_service_control" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_timesheet_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_timesheet_versions_tenant_isolation"
  ON "hr_timesheet_versions" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_timesheets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_timesheets_tenant_isolation"
  ON "hr_timesheets" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_timesheet_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'timesheet service control cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.pg_trigger_depth() <> 2
       OR NEW.service_key <> 'timesheet'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid timesheet service control creation' USING ERRCODE = '55000';
    END IF;
    SELECT activation.state,activation.version
      INTO authority_state,authority_version
      FROM public.service_activations activation
      WHERE activation.tenant_id=NEW.tenant_id
        AND activation.service_key=NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'timesheet activation authority is inconsistent' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.service_control_id,NEW.tenant_id,NEW.service_key,NEW.settings_version)
     IS DISTINCT FROM
     (OLD.service_control_id,OLD.tenant_id,OLD.service_key,OLD.settings_version)
     OR NEW.row_version <> OLD.row_version + 1
     OR NEW.updated_at <= OLD.updated_at
     OR pg_catalog.pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'invalid timesheet service control revision' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_timesheet_service_control"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_service_control_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_timesheet_service_control"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_timesheet_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_service_control_reject_truncate"
  BEFORE TRUNCATE ON "hr_timesheet_service_control"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_timesheet_service_control"();--> statement-breakpoint

CREATE FUNCTION "esbla_sync_hr_timesheet_service_activation"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  synchronized_rows integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'timesheet' THEN RETURN NEW; END IF;
    IF NEW.state <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'invalid initial timesheet activation authority' USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.hr_timesheet_service_control
      (tenant_id,service_key,settings_version,updated_at,row_version)
    VALUES (NEW.tenant_id,NEW.service_key,1,pg_catalog.statement_timestamp(),1);
    RETURN NEW;
  END IF;
  IF OLD.service_key <> 'timesheet' AND NEW.service_key <> 'timesheet' THEN RETURN NEW; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.service_key <> 'timesheet'
     OR NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid timesheet activation authority transition' USING ERRCODE = '55000';
  END IF;
  UPDATE public.hr_timesheet_service_control control
    SET updated_at=GREATEST(pg_catalog.statement_timestamp(),control.updated_at + interval '1 microsecond'),
        row_version=control.row_version + 1
    WHERE control.tenant_id=NEW.tenant_id AND control.service_key=NEW.service_key;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'timesheet service control projection is missing' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_sync_hr_timesheet_service_activation"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "service_activations_sync_hr_timesheet"
  AFTER INSERT OR UPDATE ON "service_activations"
  FOR EACH ROW EXECUTE FUNCTION "esbla_sync_hr_timesheet_service_activation"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_timesheet_root"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  current_number integer;
  next_number integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'timesheet roots cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid initial timesheet root' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.timesheet_id,NEW.tenant_id,NEW.worker_profile_id,NEW.period_start,NEW.period_end,NEW.created_at)
     IS DISTINCT FROM
     (OLD.timesheet_id,OLD.tenant_id,OLD.worker_profile_id,OLD.period_start,OLD.period_end,OLD.created_at)
     OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'invalid timesheet root revision' USING ERRCODE = '55000';
  END IF;
  SELECT version INTO current_number
    FROM public.hr_timesheet_versions
    WHERE tenant_id=OLD.tenant_id
      AND timesheet_id=OLD.timesheet_id
      AND timesheet_version_id=OLD.current_version_id;
  SELECT version INTO next_number
    FROM public.hr_timesheet_versions
    WHERE tenant_id=NEW.tenant_id
      AND timesheet_id=NEW.timesheet_id
      AND timesheet_version_id=NEW.current_version_id;
  IF current_number IS NULL OR next_number <> current_number + 1 THEN
    RAISE EXCEPTION 'timesheet head successor is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_timesheet_root"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_timesheets_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_timesheets"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_timesheet_root"();--> statement-breakpoint
CREATE TRIGGER "hr_timesheets_reject_truncate"
  BEFORE TRUNCATE ON "hr_timesheets"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_timesheet_root"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_timesheet_version"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  entry_total integer;
  root_head uuid;
  predecessor public.hr_timesheet_versions%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'timesheet versions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  SELECT current_version_id INTO root_head
    FROM public.hr_timesheets
    WHERE tenant_id=NEW.tenant_id AND timesheet_id=NEW.timesheet_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.row_version <> 1 OR NEW.total_minutes <> 0 THEN
      RAISE EXCEPTION 'invalid initial timesheet version' USING ERRCODE = '55000';
    END IF;
    IF NEW.version = 1 THEN
      IF NEW.supersedes_version_id IS NOT NULL OR root_head IS DISTINCT FROM NEW.timesheet_version_id THEN
        RAISE EXCEPTION 'invalid first timesheet version' USING ERRCODE = '55000';
      END IF;
    ELSE
      SELECT * INTO predecessor
        FROM public.hr_timesheet_versions
        WHERE tenant_id=NEW.tenant_id
          AND timesheet_id=NEW.timesheet_id
          AND timesheet_version_id=NEW.supersedes_version_id;
      IF NOT FOUND
         OR root_head IS DISTINCT FROM predecessor.timesheet_version_id
         OR predecessor.status NOT IN ('approved','rejected')
         OR NEW.version <> predecessor.version + 1 THEN
        RAISE EXCEPTION 'invalid timesheet correction predecessor' USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.timesheet_version_id,NEW.tenant_id,NEW.timesheet_id,NEW.supersedes_version_id,
      NEW.version,NEW.created_at)
     IS DISTINCT FROM
     (OLD.timesheet_version_id,OLD.tenant_id,OLD.timesheet_id,OLD.supersedes_version_id,
      OLD.version,OLD.created_at)
     OR NEW.row_version <> OLD.row_version + 1
     OR NEW.updated_at <= OLD.updated_at
     OR root_head IS DISTINCT FROM OLD.timesheet_version_id THEN
    RAISE EXCEPTION 'invalid timesheet version revision' USING ERRCODE = '55000';
  END IF;
  IF OLD.status='draft' AND NEW.status='draft' THEN
    IF NEW.assigned_approver_worker_profile_id IS NOT NULL OR NEW.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'invalid timesheet draft revision' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status='draft' AND NEW.status='submitted' THEN
    SELECT COALESCE(sum(minutes),0)::integer INTO entry_total
      FROM public.hr_timesheet_entries
      WHERE tenant_id=NEW.tenant_id AND timesheet_version_id=NEW.timesheet_version_id;
    IF NEW.assigned_approver_worker_profile_id IS NULL
       OR NEW.submitted_at IS NULL
       OR NEW.total_minutes <= 0
       OR NEW.total_minutes <> entry_total THEN
      RAISE EXCEPTION 'invalid timesheet submission' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status='submitted' AND NEW.status IN ('approved','rejected') THEN
    IF (NEW.assigned_approver_worker_profile_id,NEW.submitted_at,NEW.total_minutes)
       IS DISTINCT FROM
       (OLD.assigned_approver_worker_profile_id,OLD.submitted_at,OLD.total_minutes)
       OR NOT EXISTS (
         SELECT 1 FROM public.hr_timesheet_approvals approval
         WHERE approval.tenant_id=NEW.tenant_id
           AND approval.timesheet_version_id=NEW.timesheet_version_id
           AND approval.approver_worker_profile_id=NEW.assigned_approver_worker_profile_id
           AND approval.decision::text=NEW.status::text
       ) THEN
      RAISE EXCEPTION 'invalid timesheet decision' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'timesheet terminal history is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_timesheet_version"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_versions_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_timesheet_versions"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_timesheet_version"();--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_versions_reject_truncate"
  BEFORE TRUNCATE ON "hr_timesheet_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_timesheet_version"();--> statement-breakpoint
CREATE FUNCTION "esbla_require_hr_timesheet_version_head"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hr_timesheets root
    WHERE root.tenant_id=NEW.tenant_id
      AND root.timesheet_id=NEW.timesheet_id
      AND root.current_version_id=NEW.timesheet_version_id
  ) THEN
    RAISE EXCEPTION 'new timesheet version must be the committed current head'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_require_hr_timesheet_version_head"() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "hr_timesheet_versions_require_current_head"
  AFTER INSERT ON "hr_timesheet_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "esbla_require_hr_timesheet_version_head"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_timesheet_entry"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  selected public.hr_timesheet_versions%ROWTYPE;
  root public.hr_timesheets%ROWTYPE;
  target public.hr_timesheet_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'timesheet entries cannot be truncated' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  SELECT * INTO selected FROM public.hr_timesheet_versions
    WHERE tenant_id=target.tenant_id AND timesheet_version_id=target.timesheet_version_id;
  SELECT * INTO root FROM public.hr_timesheets
    WHERE tenant_id=selected.tenant_id
      AND timesheet_id=selected.timesheet_id
      AND current_version_id=selected.timesheet_version_id;
  IF NOT FOUND OR selected.status <> 'draft' THEN
    RAISE EXCEPTION 'timesheet entries require a current draft version' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.entry_date < root.period_start OR NEW.entry_date > root.period_end THEN
    RAISE EXCEPTION 'timesheet entry date is outside the period' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       (NEW.timesheet_entry_id,NEW.tenant_id,NEW.timesheet_version_id,NEW.created_at)
       IS DISTINCT FROM
       (OLD.timesheet_entry_id,OLD.tenant_id,OLD.timesheet_version_id,OLD.created_at)
       OR NEW.row_version <> OLD.row_version + 1
     ) THEN
    RAISE EXCEPTION 'invalid timesheet entry revision' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.row_version <> 1 THEN
    RAISE EXCEPTION 'invalid initial timesheet entry' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_timesheet_entry"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_entries_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_timesheet_entries"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_timesheet_entry"();--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_entries_reject_truncate"
  BEFORE TRUNCATE ON "hr_timesheet_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_timesheet_entry"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_timesheet_approval"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  selected public.hr_timesheet_versions%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'timesheet approvals are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO selected FROM public.hr_timesheet_versions
    WHERE tenant_id=NEW.tenant_id AND timesheet_version_id=NEW.timesheet_version_id;
  IF NOT FOUND
     OR selected.status <> 'submitted'
     OR selected.assigned_approver_worker_profile_id IS DISTINCT FROM NEW.approver_worker_profile_id
     OR (NEW.decision='rejected' AND NEW.decision_note IS NULL) THEN
    RAISE EXCEPTION 'invalid timesheet approval' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_timesheet_approval"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_approvals_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_timesheet_approvals"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_timesheet_approval"();--> statement-breakpoint
CREATE TRIGGER "hr_timesheet_approvals_reject_truncate"
  BEFORE TRUNCATE ON "hr_timesheet_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_timesheet_approval"();--> statement-breakpoint
CREATE FUNCTION "esbla_require_hr_timesheet_approval_decision"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hr_timesheet_versions version
    WHERE version.tenant_id=NEW.tenant_id
      AND version.timesheet_version_id=NEW.timesheet_version_id
      AND version.status::text=NEW.decision::text
  ) THEN
    RAISE EXCEPTION 'timesheet approval and decision must commit atomically'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_require_hr_timesheet_approval_decision"() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "hr_timesheet_approvals_require_decision"
  AFTER INSERT ON "hr_timesheet_approvals"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "esbla_require_hr_timesheet_approval_decision"();--> statement-breakpoint

GRANT SELECT,INSERT ON TABLE "hr_timesheet_approvals" TO "esbla_app";--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "hr_timesheet_entries" TO "esbla_app";--> statement-breakpoint
GRANT SELECT ON TABLE "hr_timesheet_service_control" TO "esbla_app";--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE "hr_timesheet_versions" TO "esbla_app";--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE "hr_timesheets" TO "esbla_app";
