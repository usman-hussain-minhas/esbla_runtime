export const HR_WORKFORCE_PROFILE_SERVICE_KEY = "workforce_profile" as const;
export const HR_WORKFORCE_PROFILE_SUBJECT_TYPE = "hr.workforce_profile" as const;
export const HR_WORKFORCE_PROFILE_BILLING_STATE = "non_billable" as const;

export type WorkforceStatus = "active" | "draft" | "suspended" | "terminated";

export interface WorkforceProfile {
  readonly createdAt: string;
  readonly employeeNumber: string | null;
  readonly principalLinked: boolean;
  readonly updatedAt: string;
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
  readonly targetStatus: Exclude<WorkforceStatus, "draft">;
  readonly workerProfileId: string;
}

export interface WorkforceProfileCommandResult {
  readonly billingState: typeof HR_WORKFORCE_PROFILE_BILLING_STATE;
  readonly profile: WorkforceProfile;
  readonly replayed: boolean;
}

export interface WorkforceProfileServiceLifecycleInput {
  readonly expectedVersion: number | null;
  readonly idempotencyKey: string;
}

export interface WorkforceProfileServiceLifecycleResult {
  readonly billingState: typeof HR_WORKFORCE_PROFILE_BILLING_STATE;
  readonly replayed: boolean;
  readonly serviceKey: typeof HR_WORKFORCE_PROFILE_SERVICE_KEY;
  readonly state: "active" | "inactive";
  readonly version: number;
}

export interface WorkforceProfileServiceControl {
  readonly activationState: "active" | "inactive";
  readonly activationVersion: number;
  readonly serviceKey: typeof HR_WORKFORCE_PROFILE_SERVICE_KEY;
  readonly settingsVersion: number;
  readonly updatedAt: string;
  readonly version: number;
}
