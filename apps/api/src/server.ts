import {
  assignedWorkspaceTaskPageSchema,
  assignedWorkspaceTaskSchema,
  type HrAttendanceCorrectionBody,
  type HrAttendanceCorrectionPath,
  type HrAttendanceRecordManualBody,
  type HrDecideLeaveRequestBody,
  type HrLeaveListQuery,
  type HrLeaveRequestPath,
  type HrServiceActivateBody,
  type HrServiceControlQuery,
  type HrServiceDeactivateBody,
  type HrSubmitLeaveRequestBody,
  type HrWorkforceChangeReportingRelationshipBody,
  type HrWorkforceChangeStatusBody,
  type HrWorkforceCreateProfileBody,
  type HrWorkforceDetailQuery,
  type HrWorkforceLinkPrincipalBody,
  type HrWorkforceListQuery,
  type HrWorkforceOwnQuery,
  type HrWorkforceProfilePath,
  type HrWorkforceProfileSettings,
  hrAssignedLeaveListQuerySchema,
  hrAssignedLeaveRequestPageSchema,
  hrAssignedLeaveRequestSchema,
  hrAttendanceCorrectionBodySchema,
  hrAttendanceCorrectionPathSchema,
  hrAttendanceCorrectionResponseSchema,
  hrAttendanceObservationResponseSchema,
  hrAttendanceRecordManualBodySchema,
  hrDecideLeaveRequestBodySchema,
  hrLeaveEvidenceEventSchema,
  hrLeaveListQuerySchema,
  hrLeaveRequestDetailRequestSchema,
  hrLeaveRequestDetailSchema,
  hrLeaveRequestPageSchema,
  hrLeaveRequestPathSchema,
  hrLeaveRequestSchema,
  hrReportingRelationshipSchema,
  hrServiceActivateBodySchema,
  hrServiceControlQuerySchema,
  hrServiceControlSchema,
  hrServiceDeactivateBodySchema,
  hrSubmitLeaveRequestBodySchema,
  hrWorkforceChangeReportingRelationshipBodySchema,
  hrWorkforceChangeStatusBodySchema,
  hrWorkforceCreateProfileBodySchema,
  hrWorkforceDetailQuerySchema,
  hrWorkforceLinkPrincipalBodySchema,
  hrWorkforceListQuerySchema,
  hrWorkforceListResponseSchema,
  hrWorkforceOwnQuerySchema,
  hrWorkforceProfilePathSchema,
  hrWorkforceProfileSchema,
  parseHrAttendanceCorrection,
  parseHrAttendanceCorrectionBody,
  parseHrAttendanceCorrectionPath,
  parseHrAttendanceObservation,
  parseHrAttendanceRecordManualBody,
  parseHrServiceActivateBody,
  parseHrServiceControlQuery,
  parseHrServiceDeactivateBody,
  parseHrWorkforceChangeReportingRelationshipBody,
  parseHrWorkforceChangeStatusBody,
  parseHrWorkforceCreateProfileBody,
  parseHrWorkforceDetailQuery,
  parseHrWorkforceLinkPrincipalBody,
  parseHrWorkforceListQuery,
  parseHrWorkforceOwnQuery,
  parseHrWorkforceProfilePath,
  problemDetailsSchema,
  type WorkspaceCompleteTaskBody,
  type WorkspaceCreateTaskBody,
  type WorkspaceTaskListQuery,
  type WorkspaceTaskPath,
  workspaceCompleteTaskBodySchema,
  workspaceCreateTaskBodySchema,
  workspaceTaskDetailSchema,
  workspaceTaskEvidenceEventSchema,
  workspaceTaskListQuerySchema,
  workspaceTaskPathSchema,
  workspaceTaskSchema,
} from "@esbla/contracts";
import {
  type HrServiceConfigureBody,
  hrServiceConfigureBodySchema,
  parseHrServiceConfigureBody,
} from "@esbla/contracts/hr-service-control-api";
import {
  activateWorkforceProfileService,
  appendAttendanceCorrection,
  approveLeaveRequest,
  changeWorkforceReportingRelationship,
  changeWorkforceStatus,
  configureWorkforceProfileService,
  createWorkforceProfile,
  deactivateWorkforceProfileService,
  getAuthorizedWorkforceProfileDetail,
  getLeaveRequestDetail,
  getOwnWorkforceProfile,
  getWorkforceProfileServiceControl,
  HrLeaveError,
  linkWorkforcePrincipal,
  listAssignedLeaveRequests,
  listAuthorizedWorkforceProfiles,
  listOwnLeaveRequests,
  recordManualAttendanceObservation,
  rejectLeaveRequest,
  submitLeaveRequest,
} from "@esbla/hr";
import type { OperationContext } from "@esbla/platform-core";
import {
  completeWorkspaceTask,
  createWorkspaceTask,
  getWorkspaceTaskDetail,
  listAssignedWorkspaceTasks,
  WorkspaceTaskError,
} from "@esbla/workspace";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AuthError, type RequestAuthenticator } from "./auth.js";
import { registerEmploymentRoutes } from "./hr-employment-routes.js";
import { registerShiftAssignmentRoutes } from "./hr-shift-assignment-routes.js";
import { sendProblem } from "./problems.js";

type WorkforceConfigureBody = Extract<
  HrServiceConfigureBody,
  { readonly settings: HrWorkforceProfileSettings }
>;

declare module "fastify" {
  interface FastifyRequest {
    authenticatedRequestId?: string;
    operationContext?: OperationContext;
  }
}

export interface CreateServerOptions {
  readonly authenticate: RequestAuthenticator;
  readonly logger?: boolean;
  readonly migrationReadPool?: Pool;
  readonly pool: Pool;
  readonly runtimeEnvironment?: "development" | "production" | "test";
}

function operationContext(request: FastifyRequest): OperationContext {
  if (!request.operationContext) throw new Error("authenticated operation context is missing");
  return request.operationContext;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key) throw new Error("authenticated idempotency key is missing");
  return key;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertStrictMutationIdempotencyKey(request: FastifyRequest): void {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value) || !value) {
    throw new AuthError("AUTH_REQUIRED", "A UUID Idempotency-Key is required for mutations");
  }
  if (!UUID_PATTERN.test(value)) {
    throw new AuthError("AUTH_INVALID", "The Idempotency-Key is invalid");
  }
}

function requestContractViolation(): Error & { readonly validation: readonly unknown[] } {
  return Object.assign(new Error("Request did not match the API contract"), {
    validation: [{}],
  });
}

function assertStrictRequest<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw requestContractViolation();
  }
}

function parseWorkforceConfigureBody(value: unknown): WorkforceConfigureBody {
  const body = assertStrictRequest(parseHrServiceConfigureBody, value);
  if (!("employeeNumberRequired" in body.settings)) throw requestContractViolation();
  return body as WorkforceConfigureBody;
}

function pageResponse<T extends { leaveRequestId: string; submittedAt: string }>(
  items: readonly T[],
  pageSize: number,
) {
  const last = items.length === pageSize ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: last
      ? { leaveRequestId: last.leaveRequestId, submittedAt: last.submittedAt }
      : null,
  };
}

function workspaceTaskPageResponse<T extends { createdAt: string; taskId: string }>(
  items: readonly T[],
  pageSize: number,
) {
  const last = items.length === pageSize ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: last ? { createdAt: last.createdAt, taskId: last.taskId } : null,
  };
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const server = Fastify({
    ajv: {
      customOptions: {
        coerceTypes: true,
        removeAdditional: false,
        useDefaults: true,
      },
    },
    bodyLimit: 64 * 1024,
    logger: options.logger ?? true,
  });
  for (const schema of [
    hrAttendanceCorrectionBodySchema,
    hrAttendanceCorrectionPathSchema,
    hrAttendanceCorrectionResponseSchema,
    hrAttendanceRecordManualBodySchema,
    hrAttendanceObservationResponseSchema,
    hrSubmitLeaveRequestBodySchema,
    hrServiceControlQuerySchema,
    hrServiceActivateBodySchema,
    hrServiceConfigureBodySchema,
    hrServiceDeactivateBodySchema,
    hrServiceControlSchema,
    hrWorkforceCreateProfileBodySchema,
    hrWorkforceDetailQuerySchema,
    hrWorkforceLinkPrincipalBodySchema,
    hrWorkforceListQuerySchema,
    hrWorkforceListResponseSchema,
    hrWorkforceOwnQuerySchema,
    hrWorkforceChangeReportingRelationshipBodySchema,
    hrWorkforceChangeStatusBodySchema,
    hrWorkforceProfilePathSchema,
    hrWorkforceProfileSchema,
    hrReportingRelationshipSchema,
    hrDecideLeaveRequestBodySchema,
    hrLeaveRequestPathSchema,
    hrLeaveListQuerySchema,
    hrAssignedLeaveListQuerySchema,
    hrAssignedLeaveRequestSchema,
    hrAssignedLeaveRequestPageSchema,
    hrLeaveRequestSchema,
    hrLeaveRequestDetailRequestSchema,
    hrLeaveEvidenceEventSchema,
    hrLeaveRequestPageSchema,
    hrLeaveRequestDetailSchema,
    workspaceCreateTaskBodySchema,
    workspaceCompleteTaskBodySchema,
    workspaceTaskPathSchema,
    workspaceTaskListQuerySchema,
    assignedWorkspaceTaskSchema,
    assignedWorkspaceTaskPageSchema,
    workspaceTaskSchema,
    workspaceTaskEvidenceEventSchema,
    workspaceTaskDetailSchema,
    problemDetailsSchema,
  ]) {
    server.addSchema(schema);
  }

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await options.authenticate(request);
    request.operationContext = principal.operationContext;
    request.authenticatedRequestId = principal.requestId;
    reply.header("x-request-id", principal.requestId);
  };

  server.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/")) {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
    }
  });
  server.setErrorHandler((error, request, reply) => sendProblem(error, request, reply));

  server.get("/health", async () => ({ status: "ok" }));
  server.get("/ready", async (_request, reply) => {
    try {
      await options.pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  registerEmploymentRoutes({
    authenticate,
    migrationReadPool: options.migrationReadPool ?? options.pool,
    pool: options.pool,
    runtimeEnvironment: options.runtimeEnvironment ?? "production",
    server,
  });
  registerShiftAssignmentRoutes({
    authenticate,
    migrationReadPool: options.migrationReadPool ?? options.pool,
    pool: options.pool,
    runtimeEnvironment: options.runtimeEnvironment ?? "production",
    server,
  });

  server.post<{ Body: HrAttendanceRecordManualBody }>(
    "/v1/hr/attendance-observations",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictMutationIdempotencyKey(request);
          assertStrictRequest(parseHrAttendanceRecordManualBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrAttendanceRecordManualRequestV1#" },
        response: {
          200: { $ref: "HrAttendanceObservationResponseV1#" },
          201: { $ref: "HrAttendanceObservationResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = {
        ...operationContext(request),
        correlationId: idempotencyKey(request).toLowerCase(),
      };
      const result = await recordManualAttendanceObservation(options.pool, context, {
        ...assertStrictRequest(parseHrAttendanceRecordManualBody, request.body),
        idempotencyKey: context.correlationId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply
        .code(result.replayed ? 200 : 201)
        .send(parseHrAttendanceObservation(result.observation));
    },
  );

  server.post<{ Body: HrAttendanceCorrectionBody; Params: HrAttendanceCorrectionPath }>(
    "/v1/hr/attendance-observations/:observationId/corrections",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictMutationIdempotencyKey(request);
          assertStrictRequest(parseHrAttendanceCorrectionPath, request.params);
          assertStrictRequest(parseHrAttendanceCorrectionBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrAttendanceCorrectionRequestV1#" },
        params: { $ref: "HrAttendanceCorrectionPathV1#" },
        response: {
          200: { $ref: "HrAttendanceCorrectionResponseV1#" },
          201: { $ref: "HrAttendanceCorrectionResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = {
        ...operationContext(request),
        correlationId: idempotencyKey(request).toLowerCase(),
      };
      const path = assertStrictRequest(parseHrAttendanceCorrectionPath, request.params);
      const result = await appendAttendanceCorrection(options.pool, context, {
        ...assertStrictRequest(parseHrAttendanceCorrectionBody, request.body),
        idempotencyKey: context.correlationId,
        observationId: path.observationId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply
        .code(result.replayed ? 200 : 201)
        .send(parseHrAttendanceCorrection(result.correction));
    },
  );

  server.get<{ Querystring: HrServiceControlQuery }>(
    "/v1/hr/workforce-profiles/service-control",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrServiceControlQuery, request.query);
        },
      ],
      schema: {
        querystring: { $ref: "HrServiceControlQueryV1#" },
        response: {
          200: { $ref: "HrServiceControlResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) =>
      (await getWorkforceProfileServiceControl(options.pool, operationContext(request))).control,
  );

  server.post<{ Body: HrServiceActivateBody }>(
    "/v1/hr/workforce-profiles/service-control/activate",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrServiceActivateBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrServiceActivateRequestV1#" },
        response: {
          200: { $ref: "HrServiceControlResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await activateWorkforceProfileService(
        options.pool,
        options.migrationReadPool ?? options.pool,
        operationContext(request),
        request.body,
        options.runtimeEnvironment === "development" || options.runtimeEnvironment === "test"
          ? "non_production"
          : "production",
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.control);
    },
  );

  server.post<{ Body: HrServiceDeactivateBody }>(
    "/v1/hr/workforce-profiles/service-control/deactivate",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrServiceDeactivateBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrServiceDeactivateRequestV1#" },
        response: {
          200: { $ref: "HrServiceControlResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await deactivateWorkforceProfileService(
        options.pool,
        operationContext(request),
        request.body,
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.control);
    },
  );

  server.patch<{ Body: WorkforceConfigureBody }>(
    "/v1/hr/workforce-profiles/service-control/settings",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictMutationIdempotencyKey(request);
          parseWorkforceConfigureBody(request.body);
        },
      ],
      schema: {
        body: { $ref: "HrServiceConfigureRequestV1#" },
        response: {
          200: { $ref: "HrServiceControlResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = {
        ...operationContext(request),
        correlationId: idempotencyKey(request).toLowerCase(),
      };
      const result = await configureWorkforceProfileService(options.pool, context, request.body);
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.control);
    },
  );

  server.get<{ Querystring: HrWorkforceListQuery }>(
    "/v1/hr/workforce-profiles",
    {
      preHandler: [
        async (request) => {
          assertStrictRequest(parseHrWorkforceListQuery, request.query);
        },
      ],
      preValidation: [authenticate],
      schema: {
        querystring: { $ref: "HrWorkforceListQueryV1#" },
        response: {
          200: { $ref: "HrWorkforceListResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => {
      const query = request.query;
      if (query.status !== undefined) {
        return await listAuthorizedWorkforceProfiles(options.pool, operationContext(request), {
          ...(query.cursorCreatedAt && query.cursorWorkerProfileId
            ? {
                cursor: {
                  createdAt: query.cursorCreatedAt,
                  workerProfileId: query.cursorWorkerProfileId,
                },
              }
            : {}),
          ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
          status: query.status,
        });
      }
      return await listAuthorizedWorkforceProfiles(options.pool, operationContext(request), {
        ...(query.cursorEffectiveAt && query.cursorReportingRelationshipId
          ? {
              cursor: {
                effectiveAt: query.cursorEffectiveAt,
                reportingRelationshipId: query.cursorReportingRelationshipId,
              },
            }
          : {}),
        ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
      });
    },
  );

  server.post<{ Body: HrWorkforceCreateProfileBody }>(
    "/v1/hr/workforce-profiles",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrWorkforceCreateProfileBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrWorkforceCreateProfileRequestV1#" },
        response: {
          200: { $ref: "HrWorkforceProfileResponseV1#" },
          201: { $ref: "HrWorkforceProfileResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await createWorkforceProfile(options.pool, operationContext(request), {
        ...request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(result.profile);
    },
  );

  server.get<{ Querystring: HrWorkforceOwnQuery }>(
    "/v1/hr/workforce-profiles/own",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrWorkforceOwnQuery, request.query);
        },
      ],
      schema: {
        querystring: { $ref: "HrWorkforceOwnQueryV1#" },
        response: {
          200: { $ref: "HrWorkforceProfileResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => await getOwnWorkforceProfile(options.pool, operationContext(request)),
  );

  server.get<{ Params: HrWorkforceProfilePath; Querystring: HrWorkforceDetailQuery }>(
    "/v1/hr/workforce-profiles/by-id/:workerProfileId",
    {
      preHandler: [
        async (request) => {
          assertStrictRequest(parseHrWorkforceDetailQuery, request.query);
        },
      ],
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrWorkforceProfilePath, request.params);
        },
      ],
      schema: {
        params: { $ref: "HrWorkforceProfilePathV1#" },
        querystring: { $ref: "HrWorkforceDetailQueryV1#" },
        response: {
          200: { $ref: "HrWorkforceProfileResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => {
      const query = request.query;
      return await getAuthorizedWorkforceProfileDetail(options.pool, operationContext(request), {
        ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
        ...(query.relationshipCursorReportingRelationshipId && query.relationshipCursorVersion
          ? {
              relationshipCursor: {
                relationshipVersion: query.relationshipCursorVersion,
                reportingRelationshipId: query.relationshipCursorReportingRelationshipId,
              },
            }
          : {}),
        ...(query.statusCursorEffectiveAt && query.statusCursorWorkforceStatusHistoryId
          ? {
              statusCursor: {
                effectiveAt: query.statusCursorEffectiveAt,
                workforceStatusHistoryId: query.statusCursorWorkforceStatusHistoryId,
              },
            }
          : {}),
        workerProfileId: request.params.workerProfileId,
      });
    },
  );

  server.post<{
    Body: HrWorkforceLinkPrincipalBody;
    Params: HrWorkforceProfilePath;
  }>(
    "/v1/hr/workforce-profiles/:workerProfileId/principal-link",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrWorkforceProfilePath, request.params);
          assertStrictRequest(parseHrWorkforceLinkPrincipalBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrWorkforceLinkPrincipalRequestV1#" },
        params: { $ref: "HrWorkforceProfilePathV1#" },
        response: {
          200: { $ref: "HrWorkforceProfileResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await linkWorkforcePrincipal(options.pool, operationContext(request), {
        ...request.body,
        idempotencyKey: idempotencyKey(request),
        workerProfileId: request.params.workerProfileId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.profile);
    },
  );

  server.post<{
    Body: HrWorkforceChangeStatusBody;
    Params: HrWorkforceProfilePath;
  }>(
    "/v1/hr/workforce-profiles/:workerProfileId/status",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrWorkforceProfilePath, request.params);
          assertStrictRequest(parseHrWorkforceChangeStatusBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrWorkforceChangeStatusRequestV1#" },
        params: { $ref: "HrWorkforceProfilePathV1#" },
        response: {
          200: { $ref: "HrWorkforceProfileResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await changeWorkforceStatus(options.pool, operationContext(request), {
        ...request.body,
        idempotencyKey: idempotencyKey(request),
        workerProfileId: request.params.workerProfileId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.profile);
    },
  );

  server.post<{
    Body: HrWorkforceChangeReportingRelationshipBody;
    Params: HrWorkforceProfilePath;
  }>(
    "/v1/hr/workforce-profiles/:workerProfileId/reporting-relationships",
    {
      preValidation: [
        authenticate,
        async (request) => {
          assertStrictRequest(parseHrWorkforceProfilePath, request.params);
          assertStrictRequest(parseHrWorkforceChangeReportingRelationshipBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrWorkforceChangeReportingRelationshipRequestV1#" },
        params: { $ref: "HrWorkforceProfilePathV1#" },
        response: {
          200: { $ref: "HrReportingRelationshipResponseV1#" },
          201: { $ref: "HrReportingRelationshipResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await changeWorkforceReportingRelationship(
        options.pool,
        operationContext(request),
        {
          ...request.body,
          idempotencyKey: idempotencyKey(request),
          workerProfileId: request.params.workerProfileId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(result.relationship);
    },
  );

  server.post<{ Body: HrSubmitLeaveRequestBody }>(
    "/v1/hr/leave-requests",
    {
      preHandler: authenticate,
      schema: {
        body: { $ref: "SubmitLeaveRequest#" },
        response: {
          200: { $ref: "LeaveRequest#" },
          201: { $ref: "LeaveRequest#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await submitLeaveRequest(options.pool, operationContext(request), {
        ...request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(result.request);
    },
  );

  server.get<{ Querystring: HrLeaveListQuery }>(
    "/v1/hr/leave-requests",
    {
      preHandler: authenticate,
      schema: {
        querystring: { $ref: "ListLeaveRequestsQuery#" },
        response: {
          200: { $ref: "LeaveRequestPage#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => {
      const pageSize = request.query.pageSize ?? 50;
      const items = await listOwnLeaveRequests(options.pool, operationContext(request), {
        ...(request.query.cursorLeaveRequestId && request.query.cursorSubmittedAt
          ? {
              cursor: {
                leaveRequestId: request.query.cursorLeaveRequestId,
                submittedAt: request.query.cursorSubmittedAt,
              },
            }
          : {}),
        pageSize,
      });
      return pageResponse(items, pageSize);
    },
  );

  server.get<{ Querystring: HrLeaveListQuery }>(
    "/v1/hr/leave-requests/assigned",
    {
      preHandler: authenticate,
      schema: {
        querystring: { $ref: "AssignedLeaveRequestsQuery#" },
        response: {
          200: { $ref: "AssignedLeaveRequestPage#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => {
      const pageSize = request.query.pageSize ?? 50;
      const items = await listAssignedLeaveRequests(options.pool, operationContext(request), {
        ...(request.query.cursorLeaveRequestId && request.query.cursorSubmittedAt
          ? {
              cursor: {
                leaveRequestId: request.query.cursorLeaveRequestId,
                submittedAt: request.query.cursorSubmittedAt,
              },
            }
          : {}),
        pageSize,
      });
      return pageResponse(items, pageSize);
    },
  );

  server.get<{ Params: HrLeaveRequestPath }>(
    "/v1/hr/leave-requests/:leaveRequestId",
    {
      preHandler: authenticate,
      schema: {
        params: { $ref: "LeaveRequestPath#" },
        response: {
          200: { $ref: "LeaveRequestDetail#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => {
      const detail = await getLeaveRequestDetail(
        options.pool,
        operationContext(request),
        request.params.leaveRequestId,
      );
      if (!detail) throw new HrLeaveError("LEAVE_NOT_FOUND", "Leave request was not found");
      return detail;
    },
  );

  for (const action of ["approve", "reject"] as const) {
    server.post<{ Body: HrDecideLeaveRequestBody; Params: HrLeaveRequestPath }>(
      `/v1/hr/leave-requests/:leaveRequestId/${action}`,
      {
        preHandler: authenticate,
        schema: {
          body: { $ref: "DecideLeaveRequest#" },
          params: { $ref: "LeaveRequestPath#" },
          response: {
            200: { $ref: "LeaveRequest#" },
            default: { $ref: "ProblemDetails#" },
          },
        },
      },
      async (request, reply) => {
        const command = action === "approve" ? approveLeaveRequest : rejectLeaveRequest;
        const result = await command(options.pool, operationContext(request), {
          ...request.body,
          leaveRequestId: request.params.leaveRequestId,
        });
        reply.header("idempotent-replayed", String(result.replayed));
        return result.request;
      },
    );
  }

  server.post<{ Body: WorkspaceCreateTaskBody }>(
    "/v1/workspace/tasks",
    {
      preHandler: authenticate,
      schema: {
        body: { $ref: "WorkspaceCreateTask#" },
        response: {
          200: { $ref: "WorkspaceTask#" },
          201: { $ref: "WorkspaceTask#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await createWorkspaceTask(options.pool, operationContext(request), {
        ...request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(result.task);
    },
  );

  server.get<{ Querystring: WorkspaceTaskListQuery }>(
    "/v1/workspace/tasks/assigned",
    {
      preHandler: authenticate,
      schema: {
        querystring: { $ref: "WorkspaceTaskListQuery#" },
        response: {
          200: { $ref: "AssignedWorkspaceTaskPage#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => {
      const pageSize = request.query.pageSize ?? 50;
      const items = await listAssignedWorkspaceTasks(options.pool, operationContext(request), {
        ...(request.query.cursorTaskId && request.query.cursorCreatedAt
          ? {
              cursor: {
                createdAt: request.query.cursorCreatedAt,
                taskId: request.query.cursorTaskId,
              },
            }
          : {}),
        pageSize,
      });
      return workspaceTaskPageResponse(items, pageSize);
    },
  );

  server.get<{ Params: WorkspaceTaskPath }>(
    "/v1/workspace/tasks/:taskId",
    {
      preHandler: authenticate,
      schema: {
        params: { $ref: "WorkspaceTaskPath#" },
        response: {
          200: { $ref: "WorkspaceTaskDetail#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => {
      const detail = await getWorkspaceTaskDetail(
        options.pool,
        operationContext(request),
        request.params.taskId,
      );
      if (!detail) throw new WorkspaceTaskError("WORKSPACE_TASK_NOT_FOUND", "Task was not found");
      return detail;
    },
  );

  server.post<{ Body: WorkspaceCompleteTaskBody; Params: WorkspaceTaskPath }>(
    "/v1/workspace/tasks/:taskId/complete",
    {
      preHandler: authenticate,
      schema: {
        body: { $ref: "WorkspaceCompleteTask#" },
        params: { $ref: "WorkspaceTaskPath#" },
        response: {
          200: { $ref: "WorkspaceTask#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await completeWorkspaceTask(options.pool, operationContext(request), {
        ...request.body,
        taskId: request.params.taskId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return result.task;
    },
  );

  return server;
}
