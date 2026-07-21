CREATE TYPE "public"."hr_reporting_relationship_status" AS ENUM('assigned', 'unassigned');--> statement-breakpoint
CREATE TABLE "hr_reporting_relationships" (
	"reporting_relationship_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_profile_id" uuid NOT NULL,
	"manager_worker_profile_id" uuid,
	"relationship_status" "hr_reporting_relationship_status" NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_reporting_relationship_id" uuid,
	"relationship_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "uq_hr_reporting_relationships_composite_identity" UNIQUE("tenant_id","worker_profile_id","reporting_relationship_id"),
	CONSTRAINT "hr_reporting_relationships_status_manager_consistent" CHECK (("hr_reporting_relationships"."relationship_status" = 'assigned' AND "hr_reporting_relationships"."manager_worker_profile_id" IS NOT NULL)
          OR ("hr_reporting_relationships"."relationship_status" = 'unassigned' AND "hr_reporting_relationships"."manager_worker_profile_id" IS NULL)),
	CONSTRAINT "hr_reporting_relationships_relationship_version_positive" CHECK ("hr_reporting_relationships"."relationship_version" > 0),
	CONSTRAINT "hr_reporting_relationships_row_version_fixed" CHECK ("hr_reporting_relationships"."row_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_reporting_relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" DROP CONSTRAINT "hr_worker_profiles_relationship_head_blocked";--> statement-breakpoint
ALTER TABLE "hr_reporting_relationships" ADD CONSTRAINT "hr_reporting_relationships_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reporting_relationships" ADD CONSTRAINT "hr_reporting_relationships_report_same_tenant_fk" FOREIGN KEY ("tenant_id","worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reporting_relationships" ADD CONSTRAINT "hr_reporting_relationships_manager_same_tenant_fk" FOREIGN KEY ("tenant_id","manager_worker_profile_id") REFERENCES "public"."hr_worker_profiles"("tenant_id","worker_profile_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reporting_relationships" ADD CONSTRAINT "hr_reporting_relationships_predecessor_same_worker_fk" FOREIGN KEY ("tenant_id","worker_profile_id","supersedes_reporting_relationship_id") REFERENCES "public"."hr_reporting_relationships"("tenant_id","worker_profile_id","reporting_relationship_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_reporting_relationships_tenant_worker_version" ON "hr_reporting_relationships" USING btree ("tenant_id","worker_profile_id","relationship_version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_reporting_relationships_tenant_successor" ON "hr_reporting_relationships" USING btree ("tenant_id","supersedes_reporting_relationship_id") WHERE "hr_reporting_relationships"."supersedes_reporting_relationship_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_hr_reporting_relationships_tenant_manager_current_cursor" ON "hr_reporting_relationships" USING btree ("tenant_id","manager_worker_profile_id","relationship_status","effective_at" DESC,"reporting_relationship_id" DESC);--> statement-breakpoint
CREATE INDEX "idx_hr_reporting_relationships_tenant_worker_history" ON "hr_reporting_relationships" USING btree ("tenant_id","worker_profile_id","relationship_version" DESC,"reporting_relationship_id" DESC);--> statement-breakpoint
ALTER TABLE "hr_worker_profiles" ADD CONSTRAINT "hr_worker_profiles_current_relationship_same_root_fk" FOREIGN KEY ("tenant_id","worker_profile_id","current_reporting_relationship_id") REFERENCES "public"."hr_reporting_relationships"("tenant_id","worker_profile_id","reporting_relationship_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_hr_worker_profiles_tenant_relationship_head" ON "hr_worker_profiles" USING btree ("tenant_id","current_reporting_relationship_id") WHERE "hr_worker_profiles"."current_reporting_relationship_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "hr_reporting_relationships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hr_reporting_relationships_tenant_isolation"
  ON "hr_reporting_relationships"
  FOR ALL
  USING ("tenant_id" = "esbla_current_tenant_id"())
  WITH CHECK ("tenant_id" = "esbla_current_tenant_id"());--> statement-breakpoint
CREATE FUNCTION "esbla_enforce_hr_reporting_relationship_state"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_head uuid;
  manager_membership_role text;
  manager_membership_status text;
  resolved_manager_principal_id uuid;
  manager_status public.hr_workforce_status;
  previous_version integer;
  report_status public.hr_workforce_status;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'reporting relationships are append-only'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'workforce_profile'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile service is inactive'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.relationship_status = 'assigned'
     AND NEW.manager_worker_profile_id IS NOT NULL THEN
    SELECT profile.principal_id
      INTO resolved_manager_principal_id
      FROM public.hr_worker_profiles AS profile
      WHERE profile.tenant_id = NEW.tenant_id
        AND profile.worker_profile_id = NEW.manager_worker_profile_id;
    IF resolved_manager_principal_id IS NULL THEN
      RAISE EXCEPTION 'reporting relationship manager must be active'
        USING ERRCODE = '55000';
    END IF;
    SELECT membership.status, membership.role_key
      INTO manager_membership_status, manager_membership_role
      FROM public.memberships AS membership
      WHERE membership.tenant_id = NEW.tenant_id
        AND membership.principal_id = resolved_manager_principal_id
      FOR SHARE NOWAIT;
    IF manager_membership_status IS DISTINCT FROM 'active'
       OR manager_membership_role IS DISTINCT FROM 'manager' THEN
      RAISE EXCEPTION 'reporting relationship manager membership is not current'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM 1
    FROM public.hr_worker_profiles AS profile
    WHERE profile.tenant_id = NEW.tenant_id
      AND profile.worker_profile_id = ANY(
        pg_catalog.array_remove(
          ARRAY[NEW.worker_profile_id, NEW.manager_worker_profile_id],
          NULL
        )
      )
    ORDER BY profile.worker_profile_id
    FOR UPDATE NOWAIT;

  SELECT profile.workforce_status, profile.current_reporting_relationship_id
    INTO report_status, current_head
    FROM public.hr_worker_profiles AS profile
    WHERE profile.tenant_id = NEW.tenant_id
      AND profile.worker_profile_id = NEW.worker_profile_id;
  IF report_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'reporting relationship report must be active'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.relationship_status = 'assigned'
     AND NEW.manager_worker_profile_id IS NOT NULL THEN
    SELECT profile.workforce_status, profile.principal_id
      INTO manager_status, resolved_manager_principal_id
      FROM public.hr_worker_profiles AS profile
      WHERE profile.tenant_id = NEW.tenant_id
        AND profile.worker_profile_id = NEW.manager_worker_profile_id;
    IF manager_status IS DISTINCT FROM 'active' OR resolved_manager_principal_id IS NULL THEN
      RAISE EXCEPTION 'reporting relationship manager must be active'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.supersedes_reporting_relationship_id IS DISTINCT FROM current_head THEN
    RAISE EXCEPTION 'reporting relationship predecessor is not current'
      USING ERRCODE = '55000';
  END IF;
  IF current_head IS NULL THEN
    IF NEW.relationship_version <> 1 THEN
      RAISE EXCEPTION 'reporting relationship version must advance exactly'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT relationship.relationship_version
      INTO previous_version
      FROM public.hr_reporting_relationships AS relationship
      WHERE relationship.tenant_id = NEW.tenant_id
        AND relationship.worker_profile_id = NEW.worker_profile_id
        AND relationship.reporting_relationship_id = current_head;
    IF previous_version IS NULL OR NEW.relationship_version <> previous_version + 1 THEN
      RAISE EXCEPTION 'reporting relationship version must advance exactly'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  NEW.reporting_relationship_id := pg_catalog.gen_random_uuid();
  NEW.effective_at := pg_catalog.statement_timestamp();
  NEW.created_at := NEW.effective_at;
  NEW.row_version := 1;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_reporting_relationship_state"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "hr_reporting_relationships_enforce_state"
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_reporting_relationships"
  FOR EACH ROW
  EXECUTE FUNCTION "esbla_enforce_hr_reporting_relationship_state"();--> statement-breakpoint
CREATE TRIGGER "hr_reporting_relationships_reject_truncate"
  BEFORE TRUNCATE ON "hr_reporting_relationships"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "esbla_enforce_hr_reporting_relationship_state"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "esbla_enforce_hr_workforce_profile_state"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_predecessor uuid;
  candidate_version integer;
  linked_membership_status text;
  transition_count integer;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'workforce profiles cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workforce profiles cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.service_activations AS activation
    WHERE activation.tenant_id = NEW.tenant_id
      AND activation.service_key = 'workforce_profile'
      AND activation.state = 'active'
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workforce profile service is inactive'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.worker_profile_id := pg_catalog.gen_random_uuid();
    NEW.created_at := pg_catalog.statement_timestamp();
    NEW.updated_at := NEW.created_at;
    IF NEW.principal_id IS NOT NULL
       OR NEW.workforce_status <> 'draft'
       OR NEW.current_reporting_relationship_id IS NOT NULL
       OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'workforce profiles must begin as unlinked draft version 1'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.worker_profile_id IS DISTINCT FROM OLD.worker_profile_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.employee_number IS DISTINCT FROM OLD.employee_number
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'workforce profile immutable fields changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'workforce profile version must advance exactly'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.workforce_status = 'terminated' THEN
    RAISE EXCEPTION 'terminated workforce profiles are immutable'
      USING ERRCODE = '55000';
  END IF;

  transition_count :=
    (NEW.principal_id IS DISTINCT FROM OLD.principal_id)::integer
    + (NEW.workforce_status IS DISTINCT FROM OLD.workforce_status)::integer
    + (NEW.current_reporting_relationship_id IS DISTINCT FROM
       OLD.current_reporting_relationship_id)::integer;
  IF transition_count <> 1 THEN
    RAISE EXCEPTION 'workforce profile must change exactly one supported state'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
    IF OLD.principal_id IS NOT NULL
       OR NEW.principal_id IS NULL
       OR OLD.workforce_status <> 'draft'
       OR NEW.workforce_status <> 'draft' THEN
      RAISE EXCEPTION 'workforce profile link transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT membership.status
      INTO linked_membership_status
      FROM public.memberships AS membership
      WHERE membership.tenant_id = NEW.tenant_id
        AND membership.principal_id = NEW.principal_id
      FOR SHARE NOWAIT;
    IF linked_membership_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'workforce profile link requires an active membership'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.workforce_status IS DISTINCT FROM OLD.workforce_status THEN
    IF NOT (
      (OLD.workforce_status = 'draft' AND NEW.workforce_status = 'active')
      OR (OLD.workforce_status = 'active' AND NEW.workforce_status IN ('suspended', 'terminated'))
      OR (OLD.workforce_status = 'suspended' AND NEW.workforce_status IN ('active', 'terminated'))
    ) THEN
      RAISE EXCEPTION 'workforce profile status transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.workforce_status = 'active' THEN
      IF NEW.principal_id IS NULL THEN
        RAISE EXCEPTION 'active workforce profile requires a linked principal'
          USING ERRCODE = '55000';
      END IF;
      SELECT membership.status
        INTO linked_membership_status
        FROM public.memberships AS membership
        WHERE membership.tenant_id = NEW.tenant_id
          AND membership.principal_id = NEW.principal_id
        FOR SHARE NOWAIT;
      IF linked_membership_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'active workforce profile requires an active membership'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSE
    IF NEW.current_reporting_relationship_id IS NULL THEN
      RAISE EXCEPTION 'workforce profile reporting head transition is invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT relationship.supersedes_reporting_relationship_id,
           relationship.relationship_version
      INTO candidate_predecessor, candidate_version
      FROM public.hr_reporting_relationships AS relationship
      WHERE relationship.tenant_id = NEW.tenant_id
        AND relationship.worker_profile_id = NEW.worker_profile_id
        AND relationship.reporting_relationship_id = NEW.current_reporting_relationship_id;
    IF NOT FOUND
       OR candidate_predecessor IS DISTINCT FROM OLD.current_reporting_relationship_id
       OR candidate_version IS NULL THEN
      RAISE EXCEPTION 'workforce profile reporting head transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  NEW.updated_at := GREATEST(
    pg_catalog.statement_timestamp(),
    OLD.updated_at + interval '1 microsecond'
  );
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "esbla_enforce_hr_workforce_profile_state"() FROM PUBLIC;
