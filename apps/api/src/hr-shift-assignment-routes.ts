import {
  type HrShiftAssignBody,
  type HrShiftAssignmentPath,
  type HrShiftCancelAssignmentBody,
  type HrShiftCreateRosterBody,
  type HrShiftDetailQuery,
  type HrShiftListQuery,
  type HrShiftPublishRosterBody,
  type HrShiftRosterPath,
  hrShiftAssignBodySchema,
  hrShiftAssignmentPathSchema,
  hrShiftAssignmentResponseSchema,
  hrShiftCancelAssignmentBodySchema,
  hrShiftCreateRosterBodySchema,
  hrShiftDetailQuerySchema,
  hrShiftListQuerySchema,
  hrShiftListResponseSchema,
  hrShiftPublishRosterBodySchema,
  hrShiftRosterPathSchema,
  hrShiftRosterResponseSchema,
  parseHrShiftAssignBody,
  parseHrShiftAssignmentPath,
  parseHrShiftAssignmentResponse,
  parseHrShiftCancelAssignmentBody,
  parseHrShiftCreateRosterBody,
  parseHrShiftDetailQuery,
  parseHrShiftListQuery,
  parseHrShiftListResponse,
  parseHrShiftPublishRosterBody,
  parseHrShiftRosterPath,
  parseHrShiftRosterResponse,
} from "@esbla/contracts";
import {
  type HrServiceActivateBody,
  type HrServiceConfigureBody,
  type HrServiceControlQuery,
  type HrServiceDeactivateBody,
  type HrShiftAssignmentSettings,
  parseHrServiceActivateBody,
  parseHrServiceConfigureBody,
  parseHrServiceControl,
  parseHrServiceControlQuery,
  parseHrServiceDeactivateBody,
} from "@esbla/contracts/hr-service-control-api";
import {
  activateShiftAssignmentService,
  assignShift,
  cancelShiftAssignment,
  configureShiftAssignmentService,
  createShiftRoster,
  deactivateShiftAssignmentService,
  getAuthorizedShiftAssignmentDetail,
  getShiftAssignmentServiceControl,
  listAuthorizedShiftAssignments,
  publishShiftRoster,
} from "@esbla/hr";
import type { OperationContext } from "@esbla/platform-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AuthError } from "./auth.js";

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RegisterShiftAssignmentRoutesOptions {
  readonly authenticate: Authenticate;
  readonly migrationReadPool: Pool;
  readonly pool: Pool;
  readonly runtimeEnvironment: "development" | "production" | "test";
  readonly server: FastifyInstance;
}

type ShiftConfigureBody = Extract<
  HrServiceConfigureBody,
  { readonly settings: HrShiftAssignmentSettings }
>;

function operationContext(request: FastifyRequest): OperationContext {
  if (!request.operationContext) throw new Error("authenticated operation context is missing");
  return request.operationContext;
}

function requestContractViolation(): Error & { readonly validation: readonly unknown[] } {
  return Object.assign(new Error("Request did not match the API contract"), { validation: [{}] });
}

function strict<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw requestContractViolation();
  }
}

function mutationContext(request: FastifyRequest): OperationContext {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value) || typeof value !== "string" || value.length === 0) {
    throw new AuthError("AUTH_REQUIRED", "A UUID Idempotency-Key is required for mutations");
  }
  if (!UUID_PATTERN.test(value)) {
    throw new AuthError("AUTH_INVALID", "The Idempotency-Key is invalid");
  }
  return { ...operationContext(request), correlationId: value.toLowerCase() };
}

function listQuery(value: unknown): HrShiftListQuery {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const normalized =
    record && Object.hasOwn(record, "pageSize")
      ? {
          ...record,
          pageSize:
            typeof record.pageSize === "string" && /^[1-9]\d*$/.test(record.pageSize)
              ? Number(record.pageSize)
              : record.pageSize,
        }
      : value;
  return strict(parseHrShiftListQuery, normalized);
}

function shiftConfigureBody(value: unknown): ShiftConfigureBody {
  const body = strict(parseHrServiceConfigureBody, value);
  if (!("overlapAllowed" in body.settings) || !("rosterHorizonDays" in body.settings)) {
    throw requestContractViolation();
  }
  return body as ShiftConfigureBody;
}

export function registerShiftAssignmentRoutes({
  authenticate,
  migrationReadPool,
  pool,
  runtimeEnvironment,
  server,
}: RegisterShiftAssignmentRoutesOptions): void {
  for (const schema of [
    hrShiftAssignBodySchema,
    hrShiftAssignmentPathSchema,
    hrShiftDetailQuerySchema,
    hrShiftCancelAssignmentBodySchema,
    hrShiftCreateRosterBodySchema,
    hrShiftListQuerySchema,
    hrShiftPublishRosterBodySchema,
    hrShiftRosterPathSchema,
    hrShiftAssignmentResponseSchema,
    hrShiftListResponseSchema,
    hrShiftRosterResponseSchema,
  ]) {
    server.addSchema(schema);
  }

  server.get<{ Querystring: HrServiceControlQuery }>(
    "/v1/hr/shift-rosters/service-control",
    {
      preValidation: [
        authenticate,
        async (request) => {
          strict(parseHrServiceControlQuery, request.query);
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
    async (request, reply) =>
      reply
        .code(200)
        .send(
          parseHrServiceControl(
            (await getShiftAssignmentServiceControl(pool, operationContext(request))).control,
          ),
        ),
  );

  server.post<{ Body: HrServiceActivateBody }>(
    "/v1/hr/shift-rosters/service-control/activate",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrServiceActivateBody, request.body);
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
      const result = await activateShiftAssignmentService(
        pool,
        migrationReadPool,
        mutationContext(request),
        request.body,
        runtimeEnvironment === "production" ? "production" : "non_production",
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );

  server.post<{ Body: HrServiceDeactivateBody }>(
    "/v1/hr/shift-rosters/service-control/deactivate",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrServiceDeactivateBody, request.body);
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
      const result = await deactivateShiftAssignmentService(
        pool,
        mutationContext(request),
        request.body,
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );

  server.patch<{ Body: ShiftConfigureBody }>(
    "/v1/hr/shift-rosters/service-control/settings",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          shiftConfigureBody(request.body);
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
      const result = await configureShiftAssignmentService(
        pool,
        mutationContext(request),
        request.body,
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );

  server.post<{ Body: HrShiftCreateRosterBody }>(
    "/v1/hr/shift-rosters",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrShiftCreateRosterBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrShiftCreateRosterRequestV1#" },
        response: {
          200: { $ref: "HrShiftRosterResponseV1#" },
          201: { $ref: "HrShiftRosterResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await createShiftRoster(pool, context, {
        ...request.body,
        idempotencyKey: context.correlationId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply
        .code(result.replayed ? 200 : 201)
        .send(parseHrShiftRosterResponse(result.roster));
    },
  );

  server.post<{ Body: HrShiftAssignBody; Params: HrShiftRosterPath }>(
    "/v1/hr/shift-rosters/:rosterVersionId/assignments",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrShiftRosterPath, request.params);
          strict(parseHrShiftAssignBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrShiftAssignRequestV1#" },
        params: { $ref: "HrShiftRosterPathV1#" },
        response: {
          200: { $ref: "HrShiftAssignmentResponseV1#" },
          201: { $ref: "HrShiftAssignmentResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await assignShift(pool, context, {
        ...request.body,
        idempotencyKey: context.correlationId,
        rosterVersionId: request.params.rosterVersionId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(
        parseHrShiftAssignmentResponse({
          assignment: result.assignment,
          history: result.history,
        }),
      );
    },
  );

  server.post<{ Body: HrShiftPublishRosterBody; Params: HrShiftRosterPath }>(
    "/v1/hr/shift-rosters/:rosterVersionId/publish",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrShiftRosterPath, request.params);
          strict(parseHrShiftPublishRosterBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrShiftPublishRosterRequestV1#" },
        params: { $ref: "HrShiftRosterPathV1#" },
        response: {
          200: { $ref: "HrShiftRosterResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await publishShiftRoster(pool, context, {
        ...request.body,
        idempotencyKey: context.correlationId,
        rosterVersionId: request.params.rosterVersionId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrShiftRosterResponse(result.roster));
    },
  );

  server.post<{ Body: HrShiftCancelAssignmentBody; Params: HrShiftAssignmentPath }>(
    "/v1/hr/shift-assignments/:shiftAssignmentId/cancel",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrShiftAssignmentPath, request.params);
          strict(parseHrShiftCancelAssignmentBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrShiftCancelAssignmentRequestV1#" },
        params: { $ref: "HrShiftAssignmentPathV1#" },
        response: {
          200: { $ref: "HrShiftAssignmentResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await cancelShiftAssignment(pool, context, {
        ...request.body,
        idempotencyKey: context.correlationId,
        shiftAssignmentId: request.params.shiftAssignmentId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(
        parseHrShiftAssignmentResponse({
          assignment: result.assignment,
          history: result.history,
        }),
      );
    },
  );

  server.get<{ Params: HrShiftAssignmentPath; Querystring: HrShiftDetailQuery }>(
    "/v1/hr/shift-assignments/by-id/:shiftAssignmentId",
    {
      preValidation: [
        authenticate,
        async (request) => {
          strict(parseHrShiftAssignmentPath, request.params);
          strict(parseHrShiftDetailQuery, request.query);
        },
      ],
      schema: {
        params: { $ref: "HrShiftAssignmentPathV1#" },
        querystring: { $ref: "HrShiftDetailQueryV1#" },
        response: {
          200: { $ref: "HrShiftAssignmentResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(200)
        .send(
          parseHrShiftAssignmentResponse(
            await getAuthorizedShiftAssignmentDetail(
              pool,
              operationContext(request),
              request.params.shiftAssignmentId,
            ),
          ),
        ),
  );

  server.get<{ Querystring: HrShiftListQuery }>(
    "/v1/hr/shift-assignments",
    {
      preValidation: [
        authenticate,
        async (request) => {
          request.query = listQuery(request.query);
        },
      ],
      schema: {
        querystring: { $ref: "HrShiftListQueryV1#" },
        response: {
          200: { $ref: "HrShiftAssignmentListResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const query = request.query;
      const cursor =
        query.cursorShiftAssignmentId && query.cursorStartsAt
          ? {
              shiftAssignmentId: query.cursorShiftAssignmentId,
              startsAt: query.cursorStartsAt,
            }
          : undefined;
      const result =
        query.mode === "own"
          ? await listAuthorizedShiftAssignments(pool, operationContext(request), {
              ...(cursor ? { cursor } : {}),
              ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
              mode: "own",
              rangeEnd: query.rangeEnd,
              rangeStart: query.rangeStart,
            })
          : await listAuthorizedShiftAssignments(pool, operationContext(request), {
              ...(cursor ? { cursor } : {}),
              ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
              mode: "roster",
              rosterVersionId: query.rosterVersionId,
              status: query.status,
            });
      return reply.code(200).send(parseHrShiftListResponse(result));
    },
  );
}
