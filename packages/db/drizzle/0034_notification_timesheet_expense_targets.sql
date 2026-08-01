GRANT SELECT ("tenant_id", "timesheet_id", "worker_profile_id")
ON TABLE "hr_timesheets" TO "esbla_notification_projector";

GRANT SELECT ("tenant_id", "timesheet_id", "timesheet_version_id")
ON TABLE "hr_timesheet_versions" TO "esbla_notification_projector";

GRANT SELECT ("tenant_id", "expense_claim_id", "worker_profile_id")
ON TABLE "hr_expense_claims" TO "esbla_notification_projector";

GRANT SELECT ("tenant_id", "expense_claim_id", "expense_claim_version_id")
ON TABLE "hr_expense_claim_versions" TO "esbla_notification_projector";

GRANT SELECT (
  "tenant_id",
  "assignee_principal_id",
  "work_type",
  "subject_type",
  "subject_id",
  "status"
) ON TABLE "work_items" TO "esbla_notification_projector";
