REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "esbla_current_tenant_id"() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "memberships_tenant_isolation" ON "memberships"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());
--> statement-breakpoint
ALTER TABLE "service_activations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_activations_tenant_isolation" ON "service_activations"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());
--> statement-breakpoint
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_settings_tenant_isolation" ON "tenant_settings"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());
--> statement-breakpoint
ALTER TABLE "work_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "work_items_tenant_isolation" ON "work_items"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());
--> statement-breakpoint
ALTER TABLE "evidence_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "evidence_events_tenant_isolation" ON "evidence_events"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());
--> statement-breakpoint
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());
--> statement-breakpoint
CREATE FUNCTION "esbla_reject_evidence_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evidence_events is append-only' USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "evidence_events_reject_update_delete"
  BEFORE UPDATE OR DELETE ON "evidence_events"
  FOR EACH ROW EXECUTE FUNCTION "esbla_reject_evidence_mutation"();
--> statement-breakpoint
CREATE TRIGGER "evidence_events_reject_truncate"
  BEFORE TRUNCATE ON "evidence_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "esbla_reject_evidence_mutation"();
