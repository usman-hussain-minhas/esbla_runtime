export const HR_WORKFORCE_PROFILE_BILLING_STATE = "non_billable" as const;
export const HR_WORKFORCE_PROFILE_SERVICE_KEY = "workforce_profile" as const;
export const HR_WORKFORCE_PROFILE_SUBJECT_TYPE = "hr.workforce_profile" as const;

export type WorkforceStatus = "active" | "draft" | "suspended" | "terminated";
export type WorkforceStatusTarget = Exclude<WorkforceStatus, "draft">;

export interface WorkforceProfileView {
  readonly employeeNumber: string | null;
  readonly principalLinked: boolean;
  readonly version: number;
  readonly workerProfileId: string;
  readonly workforceStatus: WorkforceStatus;
}

export interface CreateWorkforceProfileInput {
  readonly employeeNumber?: string | null;
  readonly idempotencyKey: string;
}

export interface LinkWorkforcePrincipalInput {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly workerProfileId: string;
}

export interface ChangeWorkforceStatusInput {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly status: WorkforceStatusTarget;
  readonly workerProfileId: string;
}

export interface WorkforceProfileCommandResult {
  readonly billingState: typeof HR_WORKFORCE_PROFILE_BILLING_STATE;
  readonly profile: WorkforceProfileView;
  readonly replayed: boolean;
}
