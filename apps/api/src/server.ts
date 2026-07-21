import {
  assignedWorkspaceTaskPageSchema,
  assignedWorkspaceTaskSchema,
  type HrDecideLeaveRequestBody,
  type HrLeaveListQuery,
  type HrLeaveRequestPath,
  type HrSubmitLeaveRequestBody,
  type HrWorkforceChangeStatusBody,
  type HrWorkforceCreateProfileBody,
  type HrWorkforceLinkPrincipalBody,
  type HrWorkforceProfilePath,
  type HrWorkforceServiceLifecycleBody,
  hrAssignedLeaveListQuerySchema,
  hrAssignedLeaveRequestPageSchema,
  hrAssignedLeaveRequestSchema,
  hrDecideLeaveRequestBodySchema,
  hrLeaveEvidenceEventSchema,
  hrLeaveListQuerySchema,
  hrLeaveRequestDetailRequestSchema,
  hrLeaveRequestDetailSchema,
  hrLeaveRequestPageSchema,
  hrLeaveRequestPathSchema,
  hrLeaveRequestSchema,
  hrSubmitLeaveRequestBodySchema,
  hrWorkforceChangeStatusBodySchema,
  hrWorkforceCreateProfileBodySchema,
  hrWorkforceLinkPrincipalBodySchema,
  hrWorkforceProfilePathSchema,
  hrWorkforceProfileSchema,
  hrWorkforceServiceActivateBodySchema,
  hrWorkforceServiceControlSchema,
  hrWorkforceServiceDeactivateBodySchema,
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
  activateWorkforceProfileService,
  approveLeaveRequest,
  changeWorkforceStatus,
  createWorkforceProfile,
  deactivateWorkforceProfileService,
  getLeaveRequestDetail,
  getOwnWorkforceProfile,
  getWorkforceProfileServiceControl,
  HrLeaveError,
  HrWorkforceProfileError,
  linkWorkforcePrincipal,
  listAssignedLeaveRequests,
  listOwnLeaveRequests,
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
import type { RequestAuthenticator } from "./auth.js";
import { sendProblem } from "./problems.js";

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

function workforceActivationMigrationPool(options: CreateServerOptions): Pool {
  if (!options.migrationReadPool) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_SERVICE_INACTIVE",
      "Workforce Profile activation readiness is unavailable",
    );
  }
  return options.migrationReadPool;
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
    hrSubmitLeaveRequestBodySchema,
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
    hrWorkforceCreateProfileBodySchema,
    hrWorkforceLinkPrincipalBodySchema,
    hrWorkforceChangeStatusBodySchema,
    hrWorkforceProfilePathSchema,
    hrWorkforceProfileSchema,
    hrWorkforceServiceActivateBodySchema,
    hrWorkforceServiceDeactivateBodySchema,
    hrWorkforceServiceControlSchema,
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

  server.get(
    "/v1/hr/workforce-profiles/own",
    {
      preHandler: authenticate,
      schema: {
        response: {
          200: { $ref: "HrWorkforceProfileResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) => await getOwnWorkforceProfile(options.pool, operationContext(request)),
  );

  server.get(
    "/v1/hr/workforce-profiles/service-control",
    {
      preHandler: authenticate,
      schema: {
        response: {
          200: { $ref: "HrServiceControlResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) =>
      await getWorkforceProfileServiceControl(options.pool, operationContext(request)),
  );

  for (const action of ["activate", "deactivate"] as const) {
    server.post<{ Body: HrWorkforceServiceLifecycleBody }>(
      `/v1/hr/workforce-profiles/service-control/${action}`,
      {
        preHandler: authenticate,
        schema: {
          body: {
            $ref:
              action === "activate"
                ? "HrServiceActivateRequestV1#"
                : "HrServiceDeactivateRequestV1#",
          },
          response: {
            200: { $ref: "HrServiceControlResponseV1#" },
            default: { $ref: "ProblemDetails#" },
          },
        },
      },
      async (request, reply) => {
        const input = {
          ...request.body,
          idempotencyKey: idempotencyKey(request),
        };
        const result =
          action === "activate"
            ? await activateWorkforceProfileService(
                options.pool,
                workforceActivationMigrationPool(options),
                operationContext(request),
                input,
              )
            : await deactivateWorkforceProfileService(
                options.pool,
                operationContext(request),
                input,
              );
        reply.header("idempotent-replayed", String(result.replayed));
        return await getWorkforceProfileServiceControl(options.pool, operationContext(request));
      },
    );
  }

  server.post<{ Body: HrWorkforceCreateProfileBody }>(
    "/v1/hr/workforce-profiles",
    {
      preHandler: authenticate,
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

  server.post<{
    Body: HrWorkforceLinkPrincipalBody;
    Params: HrWorkforceProfilePath;
  }>(
    "/v1/hr/workforce-profiles/:workerProfileId/principal-link",
    {
      preHandler: authenticate,
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
      return result.profile;
    },
  );

  server.post<{
    Body: HrWorkforceChangeStatusBody;
    Params: HrWorkforceProfilePath;
  }>(
    "/v1/hr/workforce-profiles/:workerProfileId/status",
    {
      preHandler: authenticate,
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
      return result.profile;
    },
  );

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
