export const HR_WORKFORCE_PROFILE_BILLING_STATE = "non_billable" as const;
export const HR_WORKFORCE_REPORTING_RELATIONSHIP_SUBJECT_TYPE =
  "hr.workforce_profile.reporting_relationship" as const;
export const HR_WORKFORCE_PROFILE_SERVICE_KEY = "workforce_profile" as const;
export const HR_WORKFORCE_PROFILE_SUBJECT_TYPE = "hr.workforce_profile" as const;

export type WorkforceStatus = "active" | "draft" | "suspended" | "terminated";
export type WorkforceStatusTarget = Exclude<WorkforceStatus, "draft">;
export type ReportingRelationshipStatus = "assigned" | "unassigned";

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

export interface ChangeWorkforceReportingRelationshipInput {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly managerWorkerProfileId: string | null;
  readonly relationshipStatus: ReportingRelationshipStatus;
  readonly workerProfileId: string;
}

export interface ReportingRelationshipView {
  readonly effectiveAt: string;
  readonly managerWorkerProfileId: string | null;
  readonly relationshipStatus: ReportingRelationshipStatus;
  readonly relationshipVersion: number;
  readonly reportingRelationshipId: string;
  readonly supersedesReportingRelationshipId: string | null;
  readonly workerProfileId: string;
  readonly workerProfileVersion: number;
}

export interface WorkforceListCursor {
  readonly createdAt: string;
  readonly workerProfileId: string;
}

export interface DirectReportsCursor {
  readonly effectiveAt: string;
  readonly reportingRelationshipId: string;
}

export type ListAuthorizedWorkforceOptions =
  | {
      readonly cursor?: WorkforceListCursor;
      readonly pageSize?: number;
      readonly status: WorkforceStatus;
    }
  | {
      readonly cursor?: DirectReportsCursor;
      readonly pageSize?: number;
      readonly status?: undefined;
    };

export interface WorkforceDirectReportView {
  readonly profile: WorkforceProfileView;
  readonly relationship: ReportingRelationshipView;
}

export interface WorkforceListPage {
  readonly items: readonly WorkforceProfileView[];
  readonly kind: "workforce";
  readonly nextCursor: WorkforceListCursor | null;
}

export interface DirectReportsPage {
  readonly items: readonly WorkforceDirectReportView[];
  readonly kind: "direct_reports";
  readonly nextCursor: DirectReportsCursor | null;
}

export type AuthorizedWorkforceListPage = DirectReportsPage | WorkforceListPage;

export interface WorkforceProfileCommandResult {
  readonly billingState: typeof HR_WORKFORCE_PROFILE_BILLING_STATE;
  readonly profile: WorkforceProfileView;
  readonly replayed: boolean;
}

export interface WorkforceReportingRelationshipCommandResult {
  readonly billingState: typeof HR_WORKFORCE_PROFILE_BILLING_STATE;
  readonly relationship: ReportingRelationshipView;
  readonly replayed: boolean;
}
