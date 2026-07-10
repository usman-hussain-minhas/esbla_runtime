import {
  type HrDecideLeaveRequestBody,
  type HrLeaveListQuery,
  type HrLeaveRequestPath,
  type HrSubmitLeaveRequestBody,
  hrAssignedLeaveListQuerySchema,
  hrAssignedLeaveRequestPageSchema,
  hrAssignedLeaveRequestSchema,
  hrDecideLeaveRequestBodySchema,
  hrLeaveEvidenceEventSchema,
  hrLeaveListQuerySchema,
  hrLeaveRequestDetailSchema,
  hrLeaveRequestPageSchema,
  hrLeaveRequestPathSchema,
  hrLeaveRequestSchema,
  hrSubmitLeaveRequestBodySchema,
  problemDetailsSchema,
} from "@esbla/contracts";
import {
  approveLeaveRequest,
  getLeaveRequestDetail,
  HrLeaveError,
  listAssignedLeaveRequests,
  listOwnLeaveRequests,
  rejectLeaveRequest,
  submitLeaveRequest,
} from "@esbla/hr";
import type { OperationContext } from "@esbla/platform-core";
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
    hrLeaveEvidenceEventSchema,
    hrLeaveRequestPageSchema,
    hrLeaveRequestDetailSchema,
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

  return server;
}
