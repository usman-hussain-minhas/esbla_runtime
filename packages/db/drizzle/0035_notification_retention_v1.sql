ALTER TABLE "notification_projections" DROP CONSTRAINT "notification_projections_retention_status_valid";--> statement-breakpoint
ALTER TABLE "notification_projector_evidence" DROP CONSTRAINT "notification_projector_evidence_event_type_valid";--> statement-breakpoint
ALTER TABLE "notification_projections" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_projections" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_projections" ALTER COLUMN "safe_summary" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_projections" ALTER COLUMN "target_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_projections" ALTER COLUMN "target_href" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_projections" ALTER COLUMN "target_read_capability_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_projections" ADD COLUMN "retention_redacted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notification_projections_retention_schedule_idx" ON "notification_projections" USING btree ("occurred_at","tenant_id","notification_id") WHERE "notification_projections"."retention_status" = 'active';--> statement-breakpoint
ALTER TABLE "notification_projections" ADD CONSTRAINT "notification_projections_retention_shape" CHECK ((
        "notification_projections"."retention_status" = 'active'
        AND "notification_projections"."category" IS NOT NULL
        AND "notification_projections"."title" IS NOT NULL
        AND "notification_projections"."safe_summary" IS NOT NULL
        AND "notification_projections"."target_kind" IS NOT NULL
        AND "notification_projections"."target_href" IS NOT NULL
        AND "notification_projections"."target_read_capability_id" IS NOT NULL
        AND "notification_projections"."retention_redacted_at" IS NULL
      ) OR (
        "notification_projections"."retention_status" = 'expired'
        AND "notification_projections"."category" IS NULL
        AND "notification_projections"."title" IS NULL
        AND "notification_projections"."safe_summary" IS NULL
        AND "notification_projections"."target_kind" IS NULL
        AND "notification_projections"."target_resource_id" IS NULL
        AND "notification_projections"."target_href" IS NULL
        AND "notification_projections"."target_read_capability_id" IS NULL
        AND "notification_projections"."read_at" IS NULL
        AND "notification_projections"."retention_redacted_at" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "notification_projections" ADD CONSTRAINT "notification_projections_retention_status_valid" CHECK ("notification_projections"."retention_status" IN ('active', 'expired'));--> statement-breakpoint
ALTER TABLE "notification_projector_evidence" ADD CONSTRAINT "notification_projector_evidence_event_type_valid" CHECK ("notification_projector_evidence"."event_type" IN (
        'platform.notifications.projected',
        'platform.notifications.withheld',
        'platform.notifications.retry_scheduled',
        'platform.notifications.poisoned',
        'platform.notifications.retention_redacted'
      ));--> statement-breakpoint
CREATE POLICY "notification_projections_retention_executor_select"
ON "notification_projections"
FOR SELECT
USING (
  current_user = 'esbla_migrator'
  AND pg_catalog.current_setting('app.notification_retention_executor', true) = 'v1'
);--> statement-breakpoint
CREATE POLICY "notification_projections_retention_executor_update"
ON "notification_projections"
FOR UPDATE
USING (
  current_user = 'esbla_migrator'
  AND pg_catalog.current_setting('app.notification_retention_executor', true) = 'v1'
)
WITH CHECK (
  current_user = 'esbla_migrator'
  AND pg_catalog.current_setting('app.notification_retention_executor', true) = 'v1'
);--> statement-breakpoint
CREATE POLICY "notification_projector_evidence_retention_executor_insert"
ON "notification_projector_evidence"
FOR INSERT
WITH CHECK (
  current_user = 'esbla_migrator'
  AND pg_catalog.current_setting('app.notification_retention_executor', true) = 'v1'
);--> statement-breakpoint
CREATE FUNCTION public.esbla_apply_notification_retention_v1(governed_batch_limit integer)
RETURNS TABLE(tenant_id uuid, redacted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
PARALLEL UNSAFE
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  governed_now timestamptz := pg_catalog.clock_timestamp();
  governed_tenant_id uuid;
  redacted_count integer := 0;
BEGIN
  IF session_user <> 'esbla_notification_projector' THEN
    RAISE EXCEPTION 'notification retention authority is denied'
      USING ERRCODE = '42501';
  END IF;
  IF governed_batch_limit IS NULL
     OR governed_batch_limit < 1
     OR governed_batch_limit > 100 THEN
    RAISE EXCEPTION 'notification retention batch size is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('app.notification_retention_executor', 'v1', true);
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('platform.notifications.retention.v1', 0)
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 0::integer;
    RETURN;
  END IF;

  SELECT projection.tenant_id
    INTO governed_tenant_id
    FROM public.notification_projections AS projection
   WHERE projection.retention_status = 'active'
     AND projection.occurred_at < governed_now - pg_catalog.make_interval(days => 90)
   ORDER BY projection.occurred_at, projection.tenant_id, projection.notification_id
   LIMIT 1;

  IF governed_tenant_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, 0::integer;
    RETURN;
  END IF;

  WITH claimed AS (
    SELECT projection.tenant_id,
           projection.notification_id,
           projection.intent_id,
           projection.source_event_id
      FROM public.notification_projections AS projection
     WHERE projection.tenant_id = governed_tenant_id
       AND projection.retention_status = 'active'
       AND projection.occurred_at < governed_now - pg_catalog.make_interval(days => 90)
     ORDER BY projection.occurred_at, projection.notification_id
     FOR UPDATE SKIP LOCKED
     LIMIT governed_batch_limit
  ), redacted_rows AS (
    UPDATE public.notification_projections AS projection
       SET category = NULL,
           title = NULL,
           safe_summary = NULL,
           target_kind = NULL,
           target_resource_id = NULL,
           target_href = NULL,
           target_read_capability_id = NULL,
           read_at = NULL,
           retention_status = 'expired',
           retention_redacted_at = governed_now,
           row_version = projection.row_version + 1
      FROM claimed
     WHERE projection.tenant_id = claimed.tenant_id
       AND projection.notification_id = claimed.notification_id
       AND projection.retention_status = 'active'
     RETURNING projection.tenant_id,
               projection.intent_id,
               projection.source_event_id
  ), recorded_evidence AS (
    INSERT INTO public.notification_projector_evidence
      (tenant_id,intent_id,source_event_id,event_type,result_code,occurred_at)
    SELECT redacted_row.tenant_id,
           redacted_row.intent_id,
           redacted_row.source_event_id,
           'platform.notifications.retention_redacted',
           'PROJECTION_RETENTION_EXPIRED',
           governed_now
      FROM redacted_rows AS redacted_row
  )
  SELECT pg_catalog.count(*)::integer
    INTO redacted_count
    FROM redacted_rows;

  RETURN QUERY SELECT governed_tenant_id, redacted_count;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.esbla_apply_notification_retention_v1(integer)
FROM PUBLIC, "esbla_app", "esbla_notification_projector";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.esbla_apply_notification_retention_v1(integer)
TO "esbla_notification_projector";
