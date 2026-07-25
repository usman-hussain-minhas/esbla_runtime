CREATE TYPE "public"."hr_expense_claim_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hr_expense_claim_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "hr_expense_claim_approvals" (
	"expense_approval_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_claim_version_id" uuid NOT NULL,
	"approver_worker_profile_id" uuid NOT NULL,
	"decision" "hr_expense_claim_decision" NOT NULL,
	"decision_note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" uuid NOT NULL,
	CONSTRAINT "hr_expense_approvals_note_valid" CHECK ("hr_expense_claim_approvals"."decision_note" IS NULL
          OR char_length(trim("hr_expense_claim_approvals"."decision_note")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "hr_expense_claim_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_expense_claim_lines" (
	"expense_line_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_claim_version_id" uuid NOT NULL,
	"expense_date" date NOT NULL,
	"category_code" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_expense_lines_category_valid" CHECK (char_length(trim("hr_expense_claim_lines"."category_code")) BETWEEN 1 AND 64
          AND "hr_expense_claim_lines"."category_code" !~ '[,[:space:]]'),
	CONSTRAINT "hr_expense_lines_amount_valid" CHECK ("hr_expense_claim_lines"."amount_minor" BETWEEN 1 AND 2147483647),
	CONSTRAINT "hr_expense_lines_description_valid" CHECK ("hr_expense_claim_lines"."description" IS NULL
          OR char_length(trim("hr_expense_claim_lines"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "hr_expense_lines_row_version_positive" CHECK ("hr_expense_claim_lines"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_expense_claim_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_expense_claim_service_control" (
	"service_control_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_key" text DEFAULT 'expense_claim_boundary' NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hr_expense_claim_service_control_key_exact" CHECK ("hr_expense_claim_service_control"."service_key" = 'expense_claim_boundary'),
	CONSTRAINT "hr_expense_claim_service_control_settings_version_positive" CHECK ("hr_expense_claim_service_control"."settings_version" > 0),
	CONSTRAINT "hr_expense_claim_service_control_row_version_positive" CHECK ("hr_expense_claim_service_control"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_expense_claim_service_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_expense_claim_versions" (
	"expense_claim_version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_claim_id" uuid NOT NULL,
	"supersedes_version_id" uuid,
	"version" integer NOT NULL,
	"currency_code" text NOT NULL,
	"status" "hr_expense_claim_status" DEFAULT 'draft' NOT NULL,
	"assigned_approver_worker_profile_id" uuid,
	"submitted_at" timestamp with time zone,
	"total_amount_minor" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_expense_versions_composite_identity" UNIQUE("tenant_id","expense_claim_id","expense_claim_version_id"),
	CONSTRAINT "uq_hr_expense_versions_tenant_identity" UNIQUE("tenant_id","expense_claim_version_id"),
	CONSTRAINT "hr_expense_versions_predecessor_version_consistent" CHECK (("hr_expense_claim_versions"."version" = 1 AND "hr_expense_claim_versions"."supersedes_version_id" IS NULL)
          OR ("hr_expense_claim_versions"."version" > 1 AND "hr_expense_claim_versions"."supersedes_version_id" IS NOT NULL)),
	CONSTRAINT "hr_expense_versions_submission_consistent" CHECK (("hr_expense_claim_versions"."status" = 'draft'
            AND "hr_expense_claim_versions"."assigned_approver_worker_profile_id" IS NULL
            AND "hr_expense_claim_versions"."submitted_at" IS NULL)
          OR ("hr_expense_claim_versions"."status" IN ('submitted', 'approved', 'rejected')
            AND "hr_expense_claim_versions"."assigned_approver_worker_profile_id" IS NOT NULL
            AND "hr_expense_claim_versions"."submitted_at" IS NOT NULL)),
	CONSTRAINT "hr_expense_versions_currency_valid" CHECK ("hr_expense_claim_versions"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "hr_expense_versions_total_amount_valid" CHECK ("hr_expense_claim_versions"."total_amount_minor" BETWEEN 0 AND 2147483647),
	CONSTRAINT "hr_expense_versions_version_positive" CHECK ("hr_expense_claim_versions"."version" > 0),
	CONSTRAINT "hr_expense_versions_row_version_positive" CHECK ("hr_expense_claim_versions"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_expense_claim_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_expense_claims" (
	"expense_claim_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"current_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_expense_claims_composite_identity" UNIQUE("tenant_id","expense_claim_id"),
	CONSTRAINT "hr_expense_claims_row_version_positive" CHECK ("hr_expense_claims"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_approvals" ADD CONSTRAINT "hr_expense_approvals_version_same_tenant_fk" FOREIGN KEY ("tenant_id","expense_claim_version_id") REFERENCES "public"."hr_expense_claim_versions"("tenant_id","expense_claim_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_approvals" ADD CONSTRAINT "hr_expense_approvals_approver_same_tenant_fk" FOREIGN KEY ("tenant_id","approver_worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_lines" ADD CONSTRAINT "hr_expense_lines_version_same_tenant_fk" FOREIGN KEY ("tenant_id","expense_claim_version_id") REFERENCES "public"."hr_expense_claim_versions"("tenant_id","expense_claim_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_service_control" ADD CONSTRAINT "hr_expense_claim_service_control_activation_fk" FOREIGN KEY ("tenant_id","service_key") REFERENCES "public"."service_activations"("tenant_id","service_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_versions" ADD CONSTRAINT "hr_expense_versions_claim_same_tenant_fk" FOREIGN KEY ("tenant_id","expense_claim_id") REFERENCES "public"."hr_expense_claims"("tenant_id","expense_claim_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_versions" ADD CONSTRAINT "hr_expense_versions_predecessor_same_root_fk" FOREIGN KEY ("tenant_id","expense_claim_id","supersedes_version_id") REFERENCES "public"."hr_expense_claim_versions"("tenant_id","expense_claim_id","expense_claim_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_versions" ADD CONSTRAINT "hr_expense_versions_approver_same_tenant_fk" FOREIGN KEY ("tenant_id","assigned_approver_worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ADD CONSTRAINT "hr_expense_claims_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ADD CONSTRAINT "hr_expense_claims_worker_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ADD CONSTRAINT "hr_expense_claims_current_version_same_root_fk" FOREIGN KEY ("tenant_id","expense_claim_id","current_version_id") REFERENCES "public"."hr_expense_claim_versions"("tenant_id","expense_claim_id","expense_claim_version_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_expense_approvals_tenant_version" ON "hr_expense_claim_approvals" USING btree ("tenant_id","expense_claim_version_id");--> statement-breakpoint
CREATE INDEX "idx_hr_expense_lines_tenant_version_date" ON "hr_expense_claim_lines" USING btree ("tenant_id","expense_claim_version_id","expense_date","expense_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_expense_claim_boundary_service_control_tenant_key" ON "hr_expense_claim_service_control" USING btree ("tenant_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_expense_versions_tenant_claim_number" ON "hr_expense_claim_versions" USING btree ("tenant_id","expense_claim_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_expense_versions_tenant_successor" ON "hr_expense_claim_versions" USING btree ("tenant_id","expense_claim_id","supersedes_version_id") WHERE "hr_expense_claim_versions"."supersedes_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_hr_expense_versions_tenant_approver_submitted" ON "hr_expense_claim_versions" USING btree ("tenant_id","assigned_approver_worker_profile_id","status","submitted_at","expense_claim_version_id");--> statement-breakpoint
CREATE INDEX "idx_hr_expense_versions_tenant_claim_cursor" ON "hr_expense_claim_versions" USING btree ("tenant_id","expense_claim_id","version" DESC NULLS LAST,"expense_claim_version_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hr_expense_claims_tenant_worker_created" ON "hr_expense_claims" USING btree ("tenant_id","worker_profile_id","created_at" DESC NULLS LAST,"expense_claim_id" DESC NULLS LAST);--> statement-breakpoint

ALTER TABLE "hr_expense_claim_approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_expense_claim_approvals_tenant_isolation"
  ON "hr_expense_claim_approvals" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_expense_claim_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_expense_claim_lines_tenant_isolation"
  ON "hr_expense_claim_lines" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_expense_claim_service_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_expense_claim_service_control_tenant_isolation"
  ON "hr_expense_claim_service_control" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_expense_claim_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_expense_claim_versions_tenant_isolation"
  ON "hr_expense_claim_versions" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
ALTER TABLE "hr_expense_claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_expense_claims_tenant_isolation"
  ON "hr_expense_claims" FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_expense_claim_service_control"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  authority_state public.service_activation_state;
  authority_version integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'expense claim service control cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.pg_trigger_depth() <> 2
       OR NEW.service_key <> 'expense_claim_boundary'
       OR NEW.settings_version <> 1
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid expense claim service control creation' USING ERRCODE = '55000';
    END IF;
    SELECT activation.state,activation.version
      INTO authority_state,authority_version
      FROM public.service_activations activation
      WHERE activation.tenant_id=NEW.tenant_id
        AND activation.service_key=NEW.service_key;
    IF NOT FOUND OR authority_state <> 'active' OR authority_version <> 1 THEN
      RAISE EXCEPTION 'expense claim activation authority is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.service_control_id,NEW.tenant_id,NEW.service_key)
     IS DISTINCT FROM
     (OLD.service_control_id,OLD.tenant_id,OLD.service_key)
     OR NEW.row_version <> OLD.row_version + 1
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'invalid expense claim service control revision' USING ERRCODE = '55000';
  END IF;
  SELECT activation.state,activation.version
    INTO authority_state,authority_version
    FROM public.service_activations activation
    WHERE activation.tenant_id=NEW.tenant_id
      AND activation.service_key=NEW.service_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense claim activation authority is missing' USING ERRCODE = '55000';
  END IF;
  IF NEW.settings_version = OLD.settings_version THEN
    IF pg_catalog.pg_trigger_depth() <> 2 THEN
      RAISE EXCEPTION 'expense claim activation revision is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.settings_version = OLD.settings_version + 1 THEN
    IF pg_catalog.pg_trigger_depth() <> 1 OR authority_state <> 'active' THEN
      RAISE EXCEPTION 'expense claim settings revision is invalid' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'expense claim settings version is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_expense_claim_service_control"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_service_control_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_expense_claim_service_control"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_service_control"();--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_service_control_reject_truncate"
  BEFORE TRUNCATE ON "hr_expense_claim_service_control"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_service_control"();--> statement-breakpoint

CREATE FUNCTION "esbla_sync_hr_expense_claim_service_activation"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  synchronized_rows integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_key <> 'expense_claim_boundary' THEN RETURN NEW; END IF;
    IF NEW.state <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'invalid initial expense claim activation authority'
        USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.hr_expense_claim_service_control
      (tenant_id,service_key,settings_version,updated_at,row_version)
    VALUES (NEW.tenant_id,NEW.service_key,1,pg_catalog.statement_timestamp(),1);
    RETURN NEW;
  END IF;
  IF OLD.service_key <> 'expense_claim_boundary'
     AND NEW.service_key <> 'expense_claim_boundary' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.service_key IS DISTINCT FROM OLD.service_key
     OR NEW.service_key <> 'expense_claim_boundary'
     OR NEW.state IS NOT DISTINCT FROM OLD.state
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid expense claim activation authority transition'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.hr_expense_claim_service_control control
    SET updated_at=GREATEST(pg_catalog.statement_timestamp(),control.updated_at + interval '1 microsecond'),
        row_version=control.row_version + 1
    WHERE control.tenant_id=NEW.tenant_id AND control.service_key=NEW.service_key;
  GET DIAGNOSTICS synchronized_rows = ROW_COUNT;
  IF synchronized_rows <> 1 THEN
    RAISE EXCEPTION 'expense claim service control projection is missing'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_sync_hr_expense_claim_service_activation"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "service_activations_sync_hr_expense_claim"
  AFTER INSERT OR UPDATE ON "service_activations"
  FOR EACH ROW EXECUTE FUNCTION "esbla_sync_hr_expense_claim_service_activation"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_expense_claim_root"() RETURNS trigger
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
    RAISE EXCEPTION 'expense claim roots cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'invalid initial expense claim root' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.expense_claim_id,NEW.tenant_id,NEW.worker_profile_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.expense_claim_id,OLD.tenant_id,OLD.worker_profile_id,OLD.created_at)
     OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'invalid expense claim root revision' USING ERRCODE = '55000';
  END IF;
  SELECT version INTO current_number
    FROM public.hr_expense_claim_versions
    WHERE tenant_id=OLD.tenant_id
      AND expense_claim_id=OLD.expense_claim_id
      AND expense_claim_version_id=OLD.current_version_id;
  SELECT version INTO next_number
    FROM public.hr_expense_claim_versions
    WHERE tenant_id=NEW.tenant_id
      AND expense_claim_id=NEW.expense_claim_id
      AND expense_claim_version_id=NEW.current_version_id;
  IF current_number IS NULL OR next_number <> current_number + 1 THEN
    RAISE EXCEPTION 'expense claim head successor is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_expense_claim_root"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_expense_claims_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_expense_claims"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_root"();--> statement-breakpoint
CREATE TRIGGER "hr_expense_claims_reject_truncate"
  BEFORE TRUNCATE ON "hr_expense_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_root"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_expense_claim_version"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  line_total bigint;
  root_head uuid;
  predecessor public.hr_expense_claim_versions%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'expense claim versions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  SELECT current_version_id INTO root_head
    FROM public.hr_expense_claims
    WHERE tenant_id=NEW.tenant_id AND expense_claim_id=NEW.expense_claim_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.row_version <> 1 OR NEW.total_amount_minor <> 0 THEN
      RAISE EXCEPTION 'invalid initial expense claim version' USING ERRCODE = '55000';
    END IF;
    IF NEW.version = 1 THEN
      IF NEW.supersedes_version_id IS NOT NULL
         OR root_head IS DISTINCT FROM NEW.expense_claim_version_id THEN
        RAISE EXCEPTION 'invalid first expense claim version' USING ERRCODE = '55000';
      END IF;
    ELSE
      SELECT * INTO predecessor
        FROM public.hr_expense_claim_versions
        WHERE tenant_id=NEW.tenant_id
          AND expense_claim_id=NEW.expense_claim_id
          AND expense_claim_version_id=NEW.supersedes_version_id;
      IF NOT FOUND
         OR root_head IS DISTINCT FROM predecessor.expense_claim_version_id
         OR predecessor.status NOT IN ('approved','rejected')
         OR NEW.version <> predecessor.version + 1
         OR NEW.currency_code IS DISTINCT FROM predecessor.currency_code THEN
        RAISE EXCEPTION 'invalid expense claim correction predecessor'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.expense_claim_version_id,NEW.tenant_id,NEW.expense_claim_id,
      NEW.supersedes_version_id,NEW.version,NEW.currency_code,NEW.created_at)
     IS DISTINCT FROM
     (OLD.expense_claim_version_id,OLD.tenant_id,OLD.expense_claim_id,
      OLD.supersedes_version_id,OLD.version,OLD.currency_code,OLD.created_at)
     OR NEW.row_version <> OLD.row_version + 1
     OR NEW.updated_at <= OLD.updated_at
     OR root_head IS DISTINCT FROM OLD.expense_claim_version_id THEN
    RAISE EXCEPTION 'invalid expense claim version revision' USING ERRCODE = '55000';
  END IF;
  IF OLD.status='draft' AND NEW.status='draft' THEN
    SELECT COALESCE(sum(amount_minor),0) INTO line_total
      FROM public.hr_expense_claim_lines
      WHERE tenant_id=NEW.tenant_id
        AND expense_claim_version_id=NEW.expense_claim_version_id;
    IF NEW.assigned_approver_worker_profile_id IS NOT NULL
       OR NEW.submitted_at IS NOT NULL
       OR line_total > 2147483647
       OR NEW.total_amount_minor <> line_total THEN
      RAISE EXCEPTION 'invalid expense claim draft revision' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status='draft' AND NEW.status='submitted' THEN
    SELECT COALESCE(sum(amount_minor),0) INTO line_total
      FROM public.hr_expense_claim_lines
      WHERE tenant_id=NEW.tenant_id
        AND expense_claim_version_id=NEW.expense_claim_version_id;
    IF NEW.assigned_approver_worker_profile_id IS NULL
       OR NEW.submitted_at IS NULL
       OR NEW.total_amount_minor <= 0
       OR line_total > 2147483647
       OR NEW.total_amount_minor <> line_total THEN
      RAISE EXCEPTION 'invalid expense claim submission' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status='submitted' AND NEW.status IN ('approved','rejected') THEN
    IF (NEW.assigned_approver_worker_profile_id,NEW.submitted_at,NEW.total_amount_minor)
       IS DISTINCT FROM
       (OLD.assigned_approver_worker_profile_id,OLD.submitted_at,OLD.total_amount_minor)
       OR NOT EXISTS (
         SELECT 1 FROM public.hr_expense_claim_approvals approval
         WHERE approval.tenant_id=NEW.tenant_id
           AND approval.expense_claim_version_id=NEW.expense_claim_version_id
           AND approval.approver_worker_profile_id=NEW.assigned_approver_worker_profile_id
           AND approval.decision::text=NEW.status::text
       ) THEN
      RAISE EXCEPTION 'invalid expense claim decision' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'expense claim terminal history is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_expense_claim_version"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_versions_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_expense_claim_versions"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_version"();--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_versions_reject_truncate"
  BEFORE TRUNCATE ON "hr_expense_claim_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_version"();--> statement-breakpoint
CREATE FUNCTION "esbla_require_hr_expense_claim_version_head"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hr_expense_claims root
    WHERE root.tenant_id=NEW.tenant_id
      AND root.expense_claim_id=NEW.expense_claim_id
      AND root.current_version_id=NEW.expense_claim_version_id
  ) THEN
    RAISE EXCEPTION 'new expense claim version must be the committed current head'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_require_hr_expense_claim_version_head"() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "hr_expense_claim_versions_require_current_head"
  AFTER INSERT ON "hr_expense_claim_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "esbla_require_hr_expense_claim_version_head"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_expense_claim_line"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  selected public.hr_expense_claim_versions%ROWTYPE;
  target public.hr_expense_claim_lines%ROWTYPE;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'expense claim lines cannot be truncated' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  SELECT version.* INTO selected
    FROM public.hr_expense_claim_versions version
    JOIN public.hr_expense_claims root
      ON root.tenant_id=version.tenant_id
     AND root.expense_claim_id=version.expense_claim_id
     AND root.current_version_id=version.expense_claim_version_id
    WHERE version.tenant_id=target.tenant_id
      AND version.expense_claim_version_id=target.expense_claim_version_id;
  IF NOT FOUND OR selected.status <> 'draft' THEN
    RAISE EXCEPTION 'expense claim lines require a current draft version'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (
       (NEW.expense_line_id,NEW.tenant_id,NEW.expense_claim_version_id,NEW.created_at)
       IS DISTINCT FROM
       (OLD.expense_line_id,OLD.tenant_id,OLD.expense_claim_version_id,OLD.created_at)
       OR NEW.row_version <> OLD.row_version + 1
     ) THEN
    RAISE EXCEPTION 'invalid expense claim line revision' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.row_version <> 1 THEN
    RAISE EXCEPTION 'invalid initial expense claim line' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_expense_claim_line"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_lines_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_expense_claim_lines"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_line"();--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_lines_reject_truncate"
  BEFORE TRUNCATE ON "hr_expense_claim_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_line"();--> statement-breakpoint

CREATE FUNCTION "esbla_enforce_hr_expense_claim_approval"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  selected public.hr_expense_claim_versions%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'expense claim approvals are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO selected FROM public.hr_expense_claim_versions
    WHERE tenant_id=NEW.tenant_id
      AND expense_claim_version_id=NEW.expense_claim_version_id;
  IF NOT FOUND
     OR selected.status <> 'submitted'
     OR selected.assigned_approver_worker_profile_id
          IS DISTINCT FROM NEW.approver_worker_profile_id THEN
    RAISE EXCEPTION 'invalid expense claim approval' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_expense_claim_approval"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_approvals_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_expense_claim_approvals"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_approval"();--> statement-breakpoint
CREATE TRIGGER "hr_expense_claim_approvals_reject_truncate"
  BEFORE TRUNCATE ON "hr_expense_claim_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_expense_claim_approval"();--> statement-breakpoint
CREATE FUNCTION "esbla_require_hr_expense_claim_approval_decision"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hr_expense_claim_versions version
    WHERE version.tenant_id=NEW.tenant_id
      AND version.expense_claim_version_id=NEW.expense_claim_version_id
      AND version.status::text=NEW.decision::text
  ) THEN
    RAISE EXCEPTION 'expense claim approval and decision must commit atomically'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_require_hr_expense_claim_approval_decision"() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "hr_expense_claim_approvals_require_decision"
  AFTER INSERT ON "hr_expense_claim_approvals"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "esbla_require_hr_expense_claim_approval_decision"();--> statement-breakpoint

GRANT SELECT,INSERT ON TABLE "hr_expense_claim_approvals" TO "esbla_app";--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "hr_expense_claim_lines" TO "esbla_app";--> statement-breakpoint
GRANT SELECT ON TABLE "hr_expense_claim_service_control" TO "esbla_app";--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE "hr_expense_claim_versions" TO "esbla_app";--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE "hr_expense_claims" TO "esbla_app";
