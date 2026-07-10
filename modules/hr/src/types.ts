export const HR_LEAVE_SERVICE_KEY = "hr.leave_request";
export const HR_LEAVE_SUBJECT_TYPE = "hr.leave_request";
export const HR_LEAVE_APPROVAL_WORK_TYPE = "hr.leave_request.approval";
export const HR_LEAVE_BILLING_STATE = "non_billable" as const;

export type LeaveCategory = "annual" | "other" | "sick" | "unpaid";
export type LeaveRequestStatus = "approved" | "rejected" | "submitted";

export interface LeaveRequest {
  readonly approverPrincipalId: string;
  readonly categoryCode: LeaveCategory;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly employeePrincipalId: string;
  readonly endDate: string;
  readonly idempotencyKey: string;
  readonly leaveRequestId: string;
  readonly reason: string | null;
  readonly startDate: string;
  readonly status: LeaveRequestStatus;
  readonly submittedAt: string;
  readonly tenantId: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface SubmitLeaveRequestInput {
  readonly categoryCode: LeaveCategory;
  readonly endDate: string;
  readonly idempotencyKey: string;
  readonly leaveRequestId?: string;
  readonly reason?: string | null;
  readonly startDate: string;
}

export interface DecideLeaveRequestInput {
  readonly decisionNote?: string | null;
  readonly expectedVersion: number;
  readonly leaveRequestId: string;
}

export interface LeaveCommandResult {
  readonly billingState: typeof HR_LEAVE_BILLING_STATE;
  readonly replayed: boolean;
  readonly request: LeaveRequest;
}

export interface LeaveListCursor {
  readonly leaveRequestId: string;
  readonly submittedAt: string;
}

export interface LeaveEvidenceCursor {
  readonly evidenceEventId: string;
  readonly occurredAt: string;
}

export interface LeaveEvidenceEvent {
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly evidenceEventId: string;
  readonly newState: string;
  readonly occurredAt: string;
  readonly priorState: string | null;
}
