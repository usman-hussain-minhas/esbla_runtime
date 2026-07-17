SELECT pg_catalog.pg_advisory_xact_lock(1163084364, 1413829460);--> statement-breakpoint
CREATE TABLE "public"."migration_barrier_probe" (
  "backend_pid" integer NOT NULL
);--> statement-breakpoint
INSERT INTO "public"."migration_barrier_probe" ("backend_pid")
VALUES (pg_catalog.pg_backend_pid());
