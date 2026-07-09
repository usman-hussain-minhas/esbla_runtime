export interface RequestContext {
  readonly correlationId: string;
  readonly requestId: string;
  readonly tenantId?: string;
}
