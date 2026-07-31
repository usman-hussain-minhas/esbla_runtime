import type {
  NotificationTargetVerificationInput,
  NotificationTargetVerificationResult,
} from "@esbla/platform-core";
import type { PoolClient } from "pg";

export async function verifyHrNotificationTargets(
  client: PoolClient,
  tenantId: string,
  targets: readonly NotificationTargetVerificationInput[],
): Promise<readonly NotificationTargetVerificationResult[]> {
  if (targets.length === 0) return [];
  const leaveTargets = targets.filter(({ targetKind }) => targetKind === "hr.leave_request.detail");
  const outcomes = new Map<string, "allowed" | "denied" | "missing">();
  if (leaveTargets.length > 0) {
    const result = await client.query<{
      outcome: "allowed" | "denied" | "missing";
      reference_id: string;
    }>(
      `SELECT item.reference_id,
              CASE
                WHEN request.leave_request_id IS NULL THEN 'missing'
                WHEN request.employee_principal_id=item.recipient_principal_id THEN 'allowed'
                WHEN request.approver_principal_id=item.recipient_principal_id
                  AND recipient.role_key='manager'
                  AND recipient.status='active'
                  THEN 'allowed'
                ELSE 'denied'
              END AS outcome
       FROM jsonb_to_recordset($2::jsonb)
         AS item(reference_id uuid,recipient_principal_id uuid,target_resource_id uuid)
       LEFT JOIN hr_leave_requests request
         ON request.tenant_id=$1
        AND request.leave_request_id=item.target_resource_id
       LEFT JOIN memberships recipient
         ON recipient.tenant_id=$1
        AND recipient.principal_id=item.recipient_principal_id`,
      [
        tenantId,
        JSON.stringify(
          leaveTargets.map(({ recipientPrincipalId, referenceId, targetResourceId }) => ({
            recipient_principal_id: recipientPrincipalId,
            reference_id: referenceId,
            target_resource_id: targetResourceId,
          })),
        ),
      ],
    );
    for (const row of result.rows) outcomes.set(row.reference_id, row.outcome);
  }
  const workforceDetailTargets = targets.filter(
    ({ targetKind }) => targetKind === "hr.workforce_profile.detail",
  );
  if (workforceDetailTargets.length > 0) {
    const result = await client.query<{
      outcome: "allowed" | "denied" | "missing";
      reference_id: string;
    }>(
      `SELECT item.reference_id,
              CASE
                WHEN profile.worker_profile_id IS NULL THEN 'missing'
                WHEN recipient.status<>'active' THEN 'denied'
                WHEN recipient.role_key='employee'
                  AND profile.principal_id=item.recipient_principal_id
                  AND profile.workforce_status='active' THEN 'allowed'
                WHEN recipient.role_key='hr_operator' THEN 'allowed'
                WHEN recipient.role_key='manager'
                  AND COALESCE(
                    (SELECT setting.value FROM tenant_settings setting
                     WHERE setting.tenant_id=$1
                       AND setting.setting_key='hr.workforce_profile.manager_visibility'),
                    '"minimized"'::jsonb
                  )='"minimized"'::jsonb
                  AND EXISTS (
                    SELECT 1
                    FROM hr_worker_profiles manager_profile
                    JOIN hr_reporting_relationships relationship
                      ON relationship.tenant_id=profile.tenant_id
                     AND relationship.worker_profile_id=profile.worker_profile_id
                     AND relationship.reporting_relationship_id=
                         profile.current_reporting_relationship_id
                    WHERE manager_profile.tenant_id=$1
                      AND manager_profile.principal_id=item.recipient_principal_id
                      AND manager_profile.workforce_status='active'
                      AND relationship.manager_worker_profile_id=
                          manager_profile.worker_profile_id
                      AND relationship.relationship_status='assigned'
                  ) THEN 'allowed'
                ELSE 'denied'
              END AS outcome
       FROM jsonb_to_recordset($2::jsonb)
         AS item(reference_id uuid,recipient_principal_id uuid,target_resource_id uuid)
       LEFT JOIN hr_worker_profiles profile
         ON profile.tenant_id=$1 AND profile.worker_profile_id=item.target_resource_id
       LEFT JOIN memberships recipient
         ON recipient.tenant_id=$1
        AND recipient.principal_id=item.recipient_principal_id`,
      [
        tenantId,
        JSON.stringify(
          workforceDetailTargets.map(({ recipientPrincipalId, referenceId, targetResourceId }) => ({
            recipient_principal_id: recipientPrincipalId,
            reference_id: referenceId,
            target_resource_id: targetResourceId,
          })),
        ),
      ],
    );
    for (const row of result.rows) outcomes.set(row.reference_id, row.outcome);
  }
  const workforceDirectReportsTargets = targets.filter(
    ({ targetKind }) => targetKind === "hr.workforce_profile.direct_reports",
  );
  if (workforceDirectReportsTargets.length > 0) {
    const result = await client.query<{
      outcome: "allowed" | "denied";
      reference_id: string;
    }>(
      `SELECT item.reference_id,
              CASE
                WHEN recipient.status='active' AND recipient.role_key='manager'
                  AND 1=(
                    SELECT count(*) FROM hr_worker_profiles manager_profile
                    WHERE manager_profile.tenant_id=$1
                      AND manager_profile.principal_id=item.recipient_principal_id
                      AND manager_profile.workforce_status='active'
                  )
                  AND COALESCE(
                    (SELECT setting.value FROM tenant_settings setting
                     WHERE setting.tenant_id=$1
                       AND setting.setting_key='hr.workforce_profile.manager_visibility'),
                    '"minimized"'::jsonb
                  )='"minimized"'::jsonb
                  THEN 'allowed'
                ELSE 'denied'
              END AS outcome
       FROM jsonb_to_recordset($2::jsonb)
         AS item(reference_id uuid,recipient_principal_id uuid,target_resource_id uuid)
       LEFT JOIN memberships recipient
         ON recipient.tenant_id=$1
        AND recipient.principal_id=item.recipient_principal_id`,
      [
        tenantId,
        JSON.stringify(
          workforceDirectReportsTargets.map(
            ({ recipientPrincipalId, referenceId, targetResourceId }) => ({
              recipient_principal_id: recipientPrincipalId,
              reference_id: referenceId,
              target_resource_id: targetResourceId,
            }),
          ),
        ),
      ],
    );
    for (const row of result.rows) outcomes.set(row.reference_id, row.outcome);
  }
  const employmentTargets = targets.filter(
    ({ targetKind }) => targetKind === "hr.employment_record.detail",
  );
  if (employmentTargets.length > 0) {
    const result = await client.query<{
      outcome: "allowed" | "denied" | "missing";
      reference_id: string;
    }>(
      `SELECT item.reference_id,
              CASE
                WHEN record.employment_record_id IS NULL THEN 'missing'
                WHEN recipient.status<>'active' THEN 'denied'
                WHEN recipient.role_key='hr_operator' THEN 'allowed'
                WHEN recipient.role_key='employee'
                  AND profile.principal_id=item.recipient_principal_id
                  AND profile.workforce_status='active' THEN 'allowed'
                ELSE 'denied'
              END AS outcome
       FROM jsonb_to_recordset($2::jsonb)
         AS item(reference_id uuid,recipient_principal_id uuid,target_resource_id uuid)
       LEFT JOIN hr_employment_records record
         ON record.tenant_id=$1 AND record.employment_record_id=item.target_resource_id
       LEFT JOIN hr_worker_profiles profile
         ON profile.tenant_id=record.tenant_id
        AND profile.worker_profile_id=record.worker_profile_id
       LEFT JOIN memberships recipient
         ON recipient.tenant_id=$1
        AND recipient.principal_id=item.recipient_principal_id`,
      [
        tenantId,
        JSON.stringify(
          employmentTargets.map(({ recipientPrincipalId, referenceId, targetResourceId }) => ({
            recipient_principal_id: recipientPrincipalId,
            reference_id: referenceId,
            target_resource_id: targetResourceId,
          })),
        ),
      ],
    );
    for (const row of result.rows) outcomes.set(row.reference_id, row.outcome);
  }
  return targets.map(({ referenceId, targetKind }) => ({
    outcome:
      targetKind === "hr.leave_request.detail" ||
      targetKind === "hr.workforce_profile.detail" ||
      targetKind === "hr.workforce_profile.direct_reports" ||
      targetKind === "hr.employment_record.detail"
        ? (outcomes.get(referenceId) ?? "missing")
        : "denied",
    referenceId,
  }));
}
