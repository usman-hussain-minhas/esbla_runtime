CREATE TABLE "notification_intents" (
	"intent_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"recipient_principal_id" uuid NOT NULL,
	"source_service_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failure_code" text,
	"intent_payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	"payload_redacted_at" timestamp with time zone,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_intents_tenant_intent_uq" UNIQUE("tenant_id","intent_id"),
	CONSTRAINT "notification_intents_source_recipient_uq" UNIQUE("tenant_id","source_event_id","recipient_principal_id"),
	CONSTRAINT "notification_intents_source_service_key_valid" CHECK ("notification_intents"."source_service_key" ~ '^[a-z][a-z0-9_.-]{0,127}$'),
	CONSTRAINT "notification_intents_state_valid" CHECK ("notification_intents"."state" IN (
        'pending',
        'retrying',
        'projected',
        'withheld_membership',
        'withheld_service_inactive',
        'withheld_target_denied',
        'withheld_target_missing',
        'poisoned'
      )),
	CONSTRAINT "notification_intents_attempt_count_valid" CHECK ("notification_intents"."attempt_count" BETWEEN 0 AND 8),
	CONSTRAINT "notification_intents_failure_code_valid" CHECK ("notification_intents"."last_failure_code" IS NULL
          OR "notification_intents"."last_failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "notification_intents_payload_object" CHECK (jsonb_typeof("notification_intents"."intent_payload") = 'object'),
	CONSTRAINT "notification_intents_terminal_shape" CHECK ((
        "notification_intents"."state" IN ('pending', 'retrying')
        AND "notification_intents"."terminal_at" IS NULL
        AND "notification_intents"."payload_redacted_at" IS NULL
      ) OR (
        "notification_intents"."state" = 'poisoned'
        AND "notification_intents"."terminal_at" IS NOT NULL
        AND "notification_intents"."payload_redacted_at" IS NULL
      ) OR (
        "notification_intents"."state" NOT IN ('pending', 'retrying', 'poisoned')
        AND "notification_intents"."terminal_at" IS NOT NULL
        AND "notification_intents"."payload_redacted_at" IS NOT NULL
      )),
	CONSTRAINT "notification_intents_row_version_positive" CHECK ("notification_intents"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_projection_receipts" (
	"tenant_id" uuid NOT NULL,
	"consumer_key" text NOT NULL,
	"consumer_version" integer NOT NULL,
	"source_event_id" uuid NOT NULL,
	"recipient_principal_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"notification_id" uuid,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_projection_receipts_pk" PRIMARY KEY("tenant_id","consumer_key","consumer_version","source_event_id","recipient_principal_id"),
	CONSTRAINT "notification_projection_receipts_intent_uq" UNIQUE("tenant_id","consumer_key","consumer_version","intent_id"),
	CONSTRAINT "notification_projection_receipts_consumer_exact" CHECK ("notification_projection_receipts"."consumer_key" = 'platform.notifications.projector'
          AND "notification_projection_receipts"."consumer_version" = 1),
	CONSTRAINT "notification_projection_receipts_outcome_valid" CHECK ("notification_projection_receipts"."outcome" IN (
        'projected',
        'withheld_membership',
        'withheld_service_inactive',
        'withheld_target_denied',
        'withheld_target_missing'
      )),
	CONSTRAINT "notification_projection_receipts_projection_shape" CHECK (("notification_projection_receipts"."outcome" = 'projected' AND "notification_projection_receipts"."notification_id" IS NOT NULL)
          OR ("notification_projection_receipts"."outcome" <> 'projected' AND "notification_projection_receipts"."notification_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "notification_projection_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_projections" (
	"notification_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_principal_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"source_service_key" text NOT NULL,
	"category" text NOT NULL,
	"title" varchar(160) NOT NULL,
	"safe_summary" varchar(240) NOT NULL,
	"target_kind" text NOT NULL,
	"target_resource_id" uuid,
	"target_href" text NOT NULL,
	"target_read_capability_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"retention_status" text DEFAULT 'active' NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "notification_projections_tenant_notification_uq" UNIQUE("tenant_id","notification_id"),
	CONSTRAINT "notification_projections_source_recipient_uq" UNIQUE("tenant_id","source_event_id","recipient_principal_id"),
	CONSTRAINT "notification_projections_intent_uq" UNIQUE("tenant_id","intent_id"),
	CONSTRAINT "notification_projections_source_service_key_valid" CHECK ("notification_projections"."source_service_key" ~ '^[a-z][a-z0-9_.-]{0,127}$'),
	CONSTRAINT "notification_projections_category_valid" CHECK ("notification_projections"."category" ~ '^[a-z][a-z0-9_.-]{0,127}$'),
	CONSTRAINT "notification_projections_title_not_blank" CHECK (char_length(trim("notification_projections"."title")) > 0),
	CONSTRAINT "notification_projections_summary_not_blank" CHECK (char_length(trim("notification_projections"."safe_summary")) > 0),
	CONSTRAINT "notification_projections_target_kind_valid" CHECK ("notification_projections"."target_kind" IN (
        'hr.attendance.detail',
        'hr.employment_record.detail',
        'hr.expense_claim.detail',
        'hr.leave_request.detail',
        'hr.shift_assignment.detail',
        'hr.shift_assignment.own_shifts',
        'hr.timesheet.detail',
        'hr.workforce_profile.detail',
        'hr.workforce_profile.direct_reports'
      )),
	CONSTRAINT "notification_projections_target_resource_shape" CHECK (("notification_projections"."target_kind" IN (
              'hr.shift_assignment.own_shifts',
              'hr.workforce_profile.direct_reports'
            )
            AND "notification_projections"."target_resource_id" IS NULL)
          OR ("notification_projections"."target_kind" NOT IN (
              'hr.shift_assignment.own_shifts',
              'hr.workforce_profile.direct_reports'
            )
            AND "notification_projections"."target_resource_id" IS NOT NULL)),
	CONSTRAINT "notification_projections_target_href_valid" CHECK ("notification_projections"."target_href" ~ '^/[^/[:space:]#][^[:space:]#]*([?][^#[:space:]]*)?$'),
	CONSTRAINT "notification_projections_target_capability_valid" CHECK ("notification_projections"."target_read_capability_id" ~ '^[a-z][a-z0-9_.-]{0,127}$'),
	CONSTRAINT "notification_projections_retention_status_valid" CHECK ("notification_projections"."retention_status" = 'active'),
	CONSTRAINT "notification_projections_row_version_positive" CHECK ("notification_projections"."row_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification_projections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_projector_evidence" (
	"evidence_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"result_code" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_projector_evidence_event_type_valid" CHECK ("notification_projector_evidence"."event_type" IN (
        'platform.notifications.projected',
        'platform.notifications.withheld',
        'platform.notifications.retry_scheduled',
        'platform.notifications.poisoned'
      )),
	CONSTRAINT "notification_projector_evidence_result_code_valid" CHECK ("notification_projector_evidence"."result_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "notification_projector_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_event_uq" UNIQUE("tenant_id","event_id");--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_source_event_same_tenant_fk" FOREIGN KEY ("tenant_id","source_event_id") REFERENCES "public"."outbox_events"("tenant_id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_recipient_same_tenant_fk" FOREIGN KEY ("tenant_id","recipient_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projection_receipts" ADD CONSTRAINT "notification_projection_receipts_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projection_receipts" ADD CONSTRAINT "notification_projection_receipts_intent_same_tenant_fk" FOREIGN KEY ("tenant_id","intent_id") REFERENCES "public"."notification_intents"("tenant_id","intent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projection_receipts" ADD CONSTRAINT "notification_projection_receipts_source_same_tenant_fk" FOREIGN KEY ("tenant_id","source_event_id") REFERENCES "public"."outbox_events"("tenant_id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projection_receipts" ADD CONSTRAINT "notification_projection_receipts_projection_same_tenant_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notification_projections"("tenant_id","notification_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projections" ADD CONSTRAINT "notification_projections_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projections" ADD CONSTRAINT "notification_projections_recipient_same_tenant_fk" FOREIGN KEY ("tenant_id","recipient_principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projections" ADD CONSTRAINT "notification_projections_intent_same_tenant_fk" FOREIGN KEY ("tenant_id","intent_id") REFERENCES "public"."notification_intents"("tenant_id","intent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projections" ADD CONSTRAINT "notification_projections_source_event_same_tenant_fk" FOREIGN KEY ("tenant_id","source_event_id") REFERENCES "public"."outbox_events"("tenant_id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projector_evidence" ADD CONSTRAINT "notification_projector_evidence_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projector_evidence" ADD CONSTRAINT "notification_projector_evidence_intent_same_tenant_fk" FOREIGN KEY ("tenant_id","intent_id") REFERENCES "public"."notification_intents"("tenant_id","intent_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projector_evidence" ADD CONSTRAINT "notification_projector_evidence_source_same_tenant_fk" FOREIGN KEY ("tenant_id","source_event_id") REFERENCES "public"."outbox_events"("tenant_id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_intents_projector_idx" ON "notification_intents" USING btree ("next_attempt_at","occurred_at","source_event_id","recipient_principal_id") WHERE "notification_intents"."state" IN ('pending', 'retrying');--> statement-breakpoint
CREATE INDEX "notification_intents_tenant_source_idx" ON "notification_intents" USING btree ("tenant_id","source_event_id","recipient_principal_id");--> statement-breakpoint
CREATE INDEX "notification_projection_receipts_source_idx" ON "notification_projection_receipts" USING btree ("tenant_id","source_event_id","recipient_principal_id");--> statement-breakpoint
CREATE INDEX "notification_projections_recipient_cursor_idx" ON "notification_projections" USING btree ("tenant_id","recipient_principal_id","occurred_at" DESC NULLS LAST,"notification_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_projections_recipient_unread_idx" ON "notification_projections" USING btree ("tenant_id","recipient_principal_id","occurred_at" DESC NULLS LAST,"notification_id" DESC NULLS LAST) WHERE "notification_projections"."read_at" IS NULL AND "notification_projections"."retention_status" = 'active';--> statement-breakpoint
CREATE INDEX "notification_projections_retention_idx" ON "notification_projections" USING btree ("tenant_id","occurred_at","notification_id");--> statement-breakpoint
CREATE INDEX "notification_projector_evidence_tenant_source_idx" ON "notification_projector_evidence" USING btree ("tenant_id","source_event_id","occurred_at");--> statement-breakpoint
ALTER TABLE "notification_intents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_projections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_projection_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_projector_evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE FUNCTION public.esbla_notification_intent_domain_current(
  governed_tenant_id uuid,
  governed_source_event_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    session_user = 'esbla_app'
    AND governed_tenant_id =
      nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM memberships actor
      WHERE actor.tenant_id = governed_tenant_id
        AND actor.principal_id =
          nullif(current_setting('app.actor_principal_id', true), '')::uuid
        AND actor.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM outbox_events source
      WHERE source.tenant_id = governed_tenant_id
        AND source.event_id = governed_source_event_id
        AND source.correlation_id =
          nullif(current_setting('app.correlation_id', true), '')::uuid
    )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_notification_intent_domain_current(uuid,uuid)
FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_notification_intent_domain_current(uuid,uuid)
TO "esbla_app", "esbla_notification_projector";--> statement-breakpoint
CREATE POLICY "notification_intents_domain_insert" ON "notification_intents"
  FOR INSERT
  WITH CHECK (
    public.esbla_notification_intent_domain_current(tenant_id,source_event_id)
  );--> statement-breakpoint
CREATE POLICY "notification_intents_domain_read" ON "notification_intents"
  FOR SELECT
  USING (
    public.esbla_notification_intent_domain_current(tenant_id,source_event_id)
  );--> statement-breakpoint
CREATE POLICY "notification_intents_projector" ON "notification_intents"
  FOR ALL
  USING (
    current_user = 'esbla_notification_projector'
  )
  WITH CHECK (
    current_user = 'esbla_notification_projector'
  );--> statement-breakpoint
CREATE POLICY "notification_projections_own_read" ON "notification_projections"
  FOR SELECT
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND recipient_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM memberships actor
      JOIN membership_capabilities capability
        ON capability.tenant_id = actor.tenant_id
       AND capability.principal_id = actor.principal_id
       AND capability.capability_id = 'platform.notifications.list_own'
      WHERE actor.tenant_id = notification_projections.tenant_id
        AND actor.principal_id = notification_projections.recipient_principal_id
        AND actor.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "notification_projections_own_mark_read" ON "notification_projections"
  FOR UPDATE
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND recipient_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM memberships actor
      JOIN membership_capabilities capability
        ON capability.tenant_id = actor.tenant_id
       AND capability.principal_id = actor.principal_id
       AND capability.capability_id IN (
         'platform.notifications.mark_read_own',
         'platform.notifications.mark_all_read_own'
       )
      WHERE actor.tenant_id = notification_projections.tenant_id
        AND actor.principal_id = notification_projections.recipient_principal_id
        AND actor.status = 'active'
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND recipient_principal_id =
      nullif(current_setting('app.actor_principal_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "notification_projections_projector" ON "notification_projections"
  FOR ALL
  USING (
    current_user = 'esbla_notification_projector'
  )
  WITH CHECK (
    current_user = 'esbla_notification_projector'
  );--> statement-breakpoint
CREATE POLICY "notification_projection_receipts_projector"
  ON "notification_projection_receipts"
  FOR ALL
  USING (
    current_user = 'esbla_notification_projector'
  )
  WITH CHECK (
    current_user = 'esbla_notification_projector'
  );--> statement-breakpoint
CREATE POLICY "notification_projector_evidence_projector"
  ON "notification_projector_evidence"
  FOR ALL
  USING (
    current_user = 'esbla_notification_projector'
  )
  WITH CHECK (
    current_user = 'esbla_notification_projector'
  );--> statement-breakpoint
CREATE FUNCTION public.esbla_reject_notification_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'notification receipt/evidence history is append-only'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_reject_notification_append_only_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "notification_intents_reject_delete"
  BEFORE DELETE ON "notification_intents"
  FOR EACH ROW EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER "notification_intents_reject_truncate"
  BEFORE TRUNCATE ON "notification_intents"
  FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER "notification_projection_receipts_reject_update_delete"
  BEFORE UPDATE OR DELETE ON "notification_projection_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER "notification_projection_receipts_reject_truncate"
  BEFORE TRUNCATE ON "notification_projection_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER "notification_projector_evidence_reject_update_delete"
  BEFORE UPDATE OR DELETE ON "notification_projector_evidence"
  FOR EACH ROW EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER "notification_projector_evidence_reject_truncate"
  BEFORE TRUNCATE ON "notification_projector_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER "notification_projections_reject_delete"
  BEFORE DELETE ON "notification_projections"
  FOR EACH ROW EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER "notification_projections_reject_truncate"
  BEFORE TRUNCATE ON "notification_projections"
  FOR EACH STATEMENT EXECUTE FUNCTION public.esbla_reject_notification_append_only_mutation();--> statement-breakpoint
REVOKE ALL ON TABLE
  "notification_intents",
  "notification_projections",
  "notification_projection_receipts",
  "notification_projector_evidence"
FROM PUBLIC, "esbla_app", "esbla_notification_projector";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "notification_intents" TO "esbla_app";--> statement-breakpoint
GRANT SELECT ON TABLE "notification_projections" TO "esbla_app";--> statement-breakpoint
GRANT UPDATE ("read_at", "row_version") ON TABLE "notification_projections"
TO "esbla_app";--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "esbla_notification_projector";--> statement-breakpoint
GRANT SELECT ON TABLE
  "memberships",
  "membership_capabilities",
  "service_activations",
  "hr_leave_requests",
  "notification_intents"
TO "esbla_notification_projector";--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE "notification_intents" TO "esbla_notification_projector";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "notification_projections",
  "notification_projection_receipts",
  "notification_projector_evidence"
TO "esbla_notification_projector";
