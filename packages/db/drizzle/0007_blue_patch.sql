CREATE TABLE "membership_capabilities" (
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"capability_id" text NOT NULL,
	CONSTRAINT "membership_capabilities_pk" PRIMARY KEY("tenant_id","principal_id","capability_id"),
	CONSTRAINT "membership_capabilities_id_not_blank" CHECK (char_length(trim("membership_capabilities"."capability_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "membership_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_capabilities" ADD CONSTRAINT "membership_capabilities_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."memberships"("tenant_id","principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_capabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "membership_capabilities_tenant_isolation"
  ON "membership_capabilities"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_guard_membership_capability_authority"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  governed_tenant_id uuid;
  governed_principal_id uuid;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'membership capabilities cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.principal_id, NEW.capability_id)
         IS DISTINCT FROM
         (OLD.tenant_id, OLD.principal_id, OLD.capability_id) THEN
    RAISE EXCEPTION 'membership capability identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  governed_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  governed_principal_id :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.principal_id ELSE NEW.principal_id END;
  PERFORM 1
    FROM public.memberships AS membership
    WHERE membership.tenant_id = governed_tenant_id
      AND membership.principal_id = governed_principal_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership capability authority is missing'
      USING ERRCODE = '23503';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_guard_membership_capability_authority"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "membership_capabilities_guard_authority"
  BEFORE INSERT OR UPDATE OR DELETE ON "membership_capabilities"
  FOR EACH ROW
  EXECUTE FUNCTION "esbla_guard_membership_capability_authority"();--> statement-breakpoint
CREATE TRIGGER "membership_capabilities_reject_truncate"
  BEFORE TRUNCATE ON "membership_capabilities"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "esbla_guard_membership_capability_authority"();
