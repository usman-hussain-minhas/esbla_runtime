GRANT SELECT ("tenant_id", "setting_key", "value")
ON TABLE "tenant_settings" TO "esbla_notification_projector";

GRANT SELECT (
  "tenant_id",
  "worker_profile_id",
  "principal_id",
  "workforce_status",
  "current_reporting_relationship_id"
) ON TABLE "hr_worker_profiles" TO "esbla_notification_projector";

GRANT SELECT (
  "tenant_id",
  "reporting_relationship_id",
  "worker_profile_id",
  "manager_worker_profile_id",
  "relationship_status"
) ON TABLE "hr_reporting_relationships" TO "esbla_notification_projector";

GRANT SELECT ("tenant_id", "employment_record_id", "worker_profile_id")
ON TABLE "hr_employment_records" TO "esbla_notification_projector";
