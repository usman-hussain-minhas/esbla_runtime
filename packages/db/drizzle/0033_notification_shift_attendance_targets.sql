GRANT SELECT (
  "tenant_id",
  "shift_assignment_id",
  "roster_version_id",
  "worker_profile_id"
) ON TABLE "hr_shift_assignments" TO "esbla_notification_projector";

GRANT SELECT ("tenant_id", "roster_version_id", "status")
ON TABLE "hr_shift_roster_versions" TO "esbla_notification_projector";

GRANT SELECT ("tenant_id", "attendance_observation_id", "worker_profile_id")
ON TABLE "hr_attendance_observations" TO "esbla_notification_projector";
