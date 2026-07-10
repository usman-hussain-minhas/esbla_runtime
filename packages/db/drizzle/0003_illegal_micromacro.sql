CREATE TYPE "public"."hr_leave_category" AS ENUM('annual', 'sick', 'unpaid', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_leave_request_status" AS ENUM('submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "hr_leave_requests" (
	"leave_request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_principal_id" uuid NOT NULL,
	"approver_principal_id" uuid NOT NULL,
	"category_code" "hr_leave_category" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text,
	"status" "hr_leave_request_status" DEFAULT 'submitted' NOT NULL,
	"decision_note" text,
	"idempotency_key" varchar(128) NOT NULL,
	"correlation_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_requests_tenant_employee_idempotency_uq" UNIQUE("tenant_id","employee_principal_id","idempotency_key"),
	CONSTRAINT "hr_leave_requests_dates_valid" CHECK ("hr_leave_requests"."end_date" >= "hr_leave_requests"."start_date"),
	CONSTRAINT "hr_leave_requests_distinct_approver" CHECK ("hr_leave_requests"."employee_principal_id" <> "hr_leave_requests"."approver_principal_id"),
	CONSTRAINT "hr_leave_requests_reason_valid" CHECK ("hr_leave_requests"."reason" IS NULL OR (char_length(trim("hr_leave_requests"."reason")) BETWEEN 1 AND 2000)),
	CONSTRAINT "hr_leave_requests_decision_note_valid" CHECK ("hr_leave_requests"."decision_note" IS NULL OR (char_length(trim("hr_leave_requests"."decision_note")) BETWEEN 1 AND 2000)),
	CONSTRAINT "hr_leave_requests_decision_consistent" CHECK (("hr_leave_requests"."status" = 'submitted' AND "hr_leave_requests"."decided_at" IS NULL AND "hr_leave_requests"."decision_note" IS NULL) OR ("hr_leave_requests"."status" IN ('approved', 'rejected') AND "hr_leave_requests"."decided_at" IS NOT NULL)),
	CONSTRAINT "hr_leave_requests_idempotency_not_blank" CHECK (char_length(trim("hr_leave_requests"."idempotency_key")) > 0),
	CONSTRAINT "hr_leave_requests_version_positive" CHECK ("hr_leave_requests"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "evidence_events_tenant_subject_occurred_idx";--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_employee_same_tenant_fk" FOREIGN KEY ("tenant_id","employee_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_approver_same_tenant_fk" FOREIGN KEY ("tenant_id","approver_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_leave_requests_assigned_open_idx" ON "hr_leave_requests" USING btree ("tenant_id","approver_principal_id","submitted_at","leave_request_id") WHERE "hr_leave_requests"."status" = 'submitted';--> statement-breakpoint
CREATE INDEX "hr_leave_requests_employee_history_idx" ON "hr_leave_requests" USING btree ("tenant_id","employee_principal_id","submitted_at" DESC NULLS LAST,"leave_request_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evidence_events_tenant_subject_occurred_idx" ON "evidence_events" USING btree ("tenant_id","subject_type","subject_id","occurred_at","evidence_event_id");--> statement-breakpoint
ALTER TABLE "hr_leave_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_leave_requests_tenant_isolation" ON "hr_leave_requests"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_leave_state"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'hr_leave_requests cannot be deleted in v0.1' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' OR NEW.version <> 1 OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'hr_leave_requests must be created as submitted version 1' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'terminal hr_leave_requests are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid hr_leave_requests state transition' USING ERRCODE = '55000';
  END IF;
  IF (NEW.tenant_id, NEW.employee_principal_id, NEW.approver_principal_id,
      NEW.category_code, NEW.start_date, NEW.end_date, NEW.reason,
      NEW.idempotency_key, NEW.correlation_id, NEW.submitted_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.employee_principal_id, OLD.approver_principal_id,
      OLD.category_code, OLD.start_date, OLD.end_date, OLD.reason,
      OLD.idempotency_key, OLD.correlation_id, OLD.submitted_at, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable hr_leave_requests fields changed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "hr_leave_requests_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_leave_requests"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_hr_leave_state"();--> statement-breakpoint
CREATE TRIGGER "hr_leave_requests_reject_truncate"
  BEFORE TRUNCATE ON "hr_leave_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_hr_leave_state"();
