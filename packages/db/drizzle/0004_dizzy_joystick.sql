CREATE TYPE "public"."workspace_task_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TABLE "workspace_tasks" (
	"task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"assignee_principal_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"description" text,
	"status" "workspace_task_status" DEFAULT 'open' NOT NULL,
	"due_on" date,
	"completion_note" text,
	"idempotency_key" varchar(128) NOT NULL,
	"correlation_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_tasks_tenant_creator_idempotency_uq" UNIQUE("tenant_id","created_by_principal_id","idempotency_key"),
	CONSTRAINT "workspace_tasks_tenant_task_id_uq" UNIQUE("tenant_id","task_id"),
	CONSTRAINT "workspace_tasks_title_valid" CHECK (char_length(trim("workspace_tasks"."title")) BETWEEN 1 AND 160),
	CONSTRAINT "workspace_tasks_description_valid" CHECK ("workspace_tasks"."description" IS NULL OR char_length(trim("workspace_tasks"."description")) BETWEEN 1 AND 2000),
	CONSTRAINT "workspace_tasks_completion_note_valid" CHECK ("workspace_tasks"."completion_note" IS NULL OR char_length(trim("workspace_tasks"."completion_note")) BETWEEN 1 AND 2000),
	CONSTRAINT "workspace_tasks_completion_consistent" CHECK (("workspace_tasks"."status" = 'open' AND "workspace_tasks"."completed_at" IS NULL AND "workspace_tasks"."completion_note" IS NULL) OR ("workspace_tasks"."status" = 'completed' AND "workspace_tasks"."completed_at" IS NOT NULL)),
	CONSTRAINT "workspace_tasks_idempotency_not_blank" CHECK (char_length(trim("workspace_tasks"."idempotency_key")) > 0),
	CONSTRAINT "workspace_tasks_version_positive" CHECK ("workspace_tasks"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_creator_same_tenant_fk" FOREIGN KEY ("tenant_id","created_by_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_assignee_same_tenant_fk" FOREIGN KEY ("tenant_id","assignee_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_tasks_assignee_open_idx" ON "workspace_tasks" USING btree ("tenant_id","assignee_principal_id","due_on","created_at","task_id") WHERE "workspace_tasks"."status" = 'open';--> statement-breakpoint
ALTER TABLE "workspace_tasks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_tasks_tenant_isolation" ON "workspace_tasks"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_workspace_task_state"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'workspace_tasks cannot be deleted in v0.1' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.completed_at IS NOT NULL OR NEW.completion_note IS NOT NULL THEN
      RAISE EXCEPTION 'workspace_tasks must be created open version 1' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'completed workspace_tasks are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'completed' OR NEW.version <> OLD.version + 1 OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'invalid workspace_tasks state transition' USING ERRCODE = '55000';
  END IF;
  IF (NEW.tenant_id, NEW.created_by_principal_id, NEW.assignee_principal_id,
      NEW.title, NEW.description, NEW.due_on, NEW.idempotency_key,
      NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.created_by_principal_id, OLD.assignee_principal_id,
      OLD.title, OLD.description, OLD.due_on, OLD.idempotency_key,
      OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable workspace_tasks fields changed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_tasks_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "workspace_tasks"
  FOR EACH ROW EXECUTE FUNCTION "esbla_enforce_workspace_task_state"();--> statement-breakpoint
CREATE TRIGGER "workspace_tasks_reject_truncate"
  BEFORE TRUNCATE ON "workspace_tasks"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_enforce_workspace_task_state"();
