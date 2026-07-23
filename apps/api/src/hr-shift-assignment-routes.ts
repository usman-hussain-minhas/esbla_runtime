import {
  type HrShiftAssignmentPath,
  type HrShiftDetailQuery,
  type HrShiftListQuery,
  hrShiftAssignmentPathSchema,
  hrShiftAssignmentResponseSchema,
  hrShiftDetailQuerySchema,
  hrShiftListQuerySchema,
  hrShiftListResponseSchema,
  parseHrShiftAssignmentPath,
  parseHrShiftAssignmentResponse,
  parseHrShiftDetailQuery,
  parseHrShiftListQuery,
  parseHrShiftListResponse,
} from "@esbla/contracts";
import { getAuthorizedShiftAssignmentDetail, listAuthorizedShiftAssignments } from "@esbla/hr";
import type { OperationContext } from "@esbla/platform-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface RegisterShiftAssignmentReadRoutesOptions {
  readonly authenticate: Authenticate;
  readonly pool: Pool;
  readonly server: FastifyInstance;
}

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

export function registerShiftAssignmentReadRoutes({
  authenticate,
  pool,
  server,
}: RegisterShiftAssignmentReadRoutesOptions): void {
  for (const schema of [
    hrShiftAssignmentPathSchema,
    hrShiftDetailQuerySchema,
    hrShiftListQuerySchema,
    hrShiftAssignmentResponseSchema,
    hrShiftListResponseSchema,
  ]) {
    server.addSchema(schema);
  }

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
