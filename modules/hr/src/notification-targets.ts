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
  return targets.map(({ referenceId, targetKind }) => ({
    outcome:
      targetKind === "hr.leave_request.detail"
        ? (outcomes.get(referenceId) ?? "missing")
        : "denied",
    referenceId,
  }));
}
