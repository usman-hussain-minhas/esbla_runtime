ALTER TABLE "evidence_events" DROP CONSTRAINT "evidence_events_tenant_subject_type_uq";--> statement-breakpoint
ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_idempotency_uq";--> statement-breakpoint
ALTER TABLE "work_items" DROP CONSTRAINT "work_items_tenant_subject_uq";--> statement-breakpoint
ALTER TABLE "evidence_events" ADD COLUMN "subject_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "aggregate_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "correlation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "work_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "subject_type" text NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_tenant_correlation_idx" ON "outbox_events" USING btree ("tenant_id","correlation_id");--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_idempotency_uq" UNIQUE("tenant_id","subject_type","subject_id","event_type","correlation_id");--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_idempotency_uq" UNIQUE("tenant_id","event_type","aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_tenant_work_subject_uq" UNIQUE("tenant_id","work_type","subject_type","subject_id");--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_subject_type_not_blank" CHECK (char_length(trim("evidence_events"."subject_type")) > 0);--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_status_valid" CHECK ("memberships"."status" IN ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_aggregate_type_not_blank" CHECK (char_length(trim("outbox_events"."aggregate_type")) > 0);--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_work_type_not_blank" CHECK (char_length(trim("work_items"."work_type")) > 0);--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_subject_type_not_blank" CHECK (char_length(trim("work_items"."subject_type")) > 0);