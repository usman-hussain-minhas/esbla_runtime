CREATE TYPE "public"."service_activation_state" AS ENUM('inactive', 'active');--> statement-breakpoint
CREATE TYPE "public"."setting_value_type" AS ENUM('boolean', 'integer', 'decimal', 'text', 'enum', 'duration');--> statement-breakpoint
CREATE TYPE "public"."work_item_status" AS ENUM('open', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "evidence_events" (
	"evidence_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"prior_state" text,
	"new_state" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_events_tenant_subject_type_uq" UNIQUE("tenant_id","subject_id","event_type"),
	CONSTRAINT "evidence_events_type_not_blank" CHECK (char_length(trim("evidence_events"."event_type")) > 0),
	CONSTRAINT "evidence_events_new_state_not_blank" CHECK (char_length(trim("evidence_events"."new_state")) > 0)
);
--> statement-breakpoint
ALTER TABLE "evidence_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"membership_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"manager_principal_id" uuid,
	CONSTRAINT "memberships_tenant_principal_uq" UNIQUE("tenant_id","principal_id"),
	CONSTRAINT "memberships_role_key_not_blank" CHECK (char_length(trim("memberships"."role_key")) > 0)
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_events_idempotency_uq" UNIQUE("tenant_id","event_type","aggregate_id","aggregate_version"),
	CONSTRAINT "outbox_events_type_not_blank" CHECK (char_length(trim("outbox_events"."event_type")) > 0),
	CONSTRAINT "outbox_events_aggregate_version_positive" CHECK ("outbox_events"."aggregate_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "principals" (
	"principal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(160) NOT NULL,
	CONSTRAINT "principals_display_name_not_blank" CHECK (char_length(trim("principals"."display_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "service_activations" (
	"tenant_id" uuid NOT NULL,
	"service_key" text NOT NULL,
	"state" "service_activation_state" DEFAULT 'inactive' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "service_activations_pk" PRIMARY KEY("tenant_id","service_key"),
	CONSTRAINT "service_activations_key_not_blank" CHECK (char_length(trim("service_activations"."service_key")) > 0),
	CONSTRAINT "service_activations_version_positive" CHECK ("service_activations"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "service_activations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"value_type" "setting_value_type" NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_settings_pk" PRIMARY KEY("tenant_id","setting_key"),
	CONSTRAINT "tenant_settings_key_not_blank" CHECK (char_length(trim("tenant_settings"."setting_key")) > 0),
	CONSTRAINT "tenant_settings_version_positive" CHECK ("tenant_settings"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"tenant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	CONSTRAINT "tenants_name_not_blank" CHECK (char_length(trim("tenants"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"work_item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assignee_principal_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" "work_item_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "work_items_tenant_subject_uq" UNIQUE("tenant_id","subject_id"),
	CONSTRAINT "work_items_completion_consistent" CHECK (("work_items"."status" = 'completed' AND "work_items"."completed_at" IS NOT NULL) OR ("work_items"."status" <> 'completed' AND "work_items"."completed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "work_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_actor_same_tenant_fk" FOREIGN KEY ("tenant_id","actor_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_manager_principal_id_principals_principal_id_fk" FOREIGN KEY ("manager_principal_id") REFERENCES "public"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_manager_same_tenant_fk" FOREIGN KEY ("tenant_id","manager_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_activations" ADD CONSTRAINT "service_activations_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_same_tenant_fk" FOREIGN KEY ("tenant_id","assignee_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_events_tenant_subject_occurred_idx" ON "evidence_events" USING btree ("tenant_id","subject_id","occurred_at","evidence_event_id");--> statement-breakpoint
CREATE INDEX "memberships_tenant_manager_idx" ON "memberships" USING btree ("tenant_id","manager_principal_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("occurred_at","event_id") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "work_items_tenant_assignee_status_created_idx" ON "work_items" USING btree ("tenant_id","assignee_principal_id","status","created_at");