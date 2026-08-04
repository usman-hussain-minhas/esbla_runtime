CREATE TABLE "presentation_surface_registry" (
	"surface_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_registry" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_registry" FROM "esbla_app";--> statement-breakpoint
REVOKE ALL ON TABLE "presentation_surface_registry" FROM "esbla_notification_projector";--> statement-breakpoint
GRANT SELECT ON TABLE "presentation_surface_registry" TO "esbla_app";--> statement-breakpoint
INSERT INTO "presentation_surface_registry" ("surface_id") VALUES
	('surface.mission-control'),
	('surface.hr.mission-control'),
	('surface.hr.workforce'),
	('surface.hr.time-and-scheduling'),
	('surface.hr.requests-and-claims');--> statement-breakpoint
CREATE INDEX "presentation_surface_settings_surface_id_idx" ON "presentation_surface_settings" USING btree ("surface_id");--> statement-breakpoint
CREATE INDEX "presentation_surface_versions_surface_id_idx" ON "presentation_surface_versions" USING btree ("surface_id");--> statement-breakpoint
ALTER TABLE "presentation_surface_settings" ADD CONSTRAINT "presentation_surface_settings_registry_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."presentation_surface_registry"("surface_id") ON DELETE restrict ON UPDATE restrict NOT VALID;--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" ADD CONSTRAINT "presentation_surface_versions_registry_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."presentation_surface_registry"("surface_id") ON DELETE restrict ON UPDATE restrict NOT VALID;--> statement-breakpoint
ALTER TABLE "presentation_surface_settings" VALIDATE CONSTRAINT "presentation_surface_settings_registry_fk";--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" VALIDATE CONSTRAINT "presentation_surface_versions_registry_fk";--> statement-breakpoint
ALTER TABLE "presentation_surface_drafts" DROP CONSTRAINT "presentation_surface_drafts_surface_valid";--> statement-breakpoint
ALTER TABLE "presentation_surface_heads" DROP CONSTRAINT "presentation_surface_heads_surface_valid";--> statement-breakpoint
ALTER TABLE "presentation_surface_overlays" DROP CONSTRAINT "presentation_surface_overlays_surface_valid";--> statement-breakpoint
ALTER TABLE "presentation_surface_settings" DROP CONSTRAINT "presentation_surface_settings_surface_valid";--> statement-breakpoint
ALTER TABLE "presentation_surface_versions" DROP CONSTRAINT "presentation_surface_versions_surface_valid";
