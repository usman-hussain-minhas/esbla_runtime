import {
  type HrEmploymentCreateRecordBody,
  type HrEmploymentCreateVersionBody,
  type HrEmploymentDetailQuery,
  type HrEmploymentEndRecordBody,
  type HrEmploymentListQuery,
  type HrEmploymentListResponse,
  type HrEmploymentRecord,
  type HrEmploymentRecordPath,
  type HrEmploymentRecordSummary,
  type HrEmploymentRecordVersion,
  hrEmploymentCreateRecordBodySchema,
  hrEmploymentCreateVersionBodySchema,
  hrEmploymentDetailQuerySchema,
  hrEmploymentEndRecordBodySchema,
  hrEmploymentListQuerySchema,
  hrEmploymentListResponseSchema,
  hrEmploymentRecordPathSchema,
  hrEmploymentRecordSchema,
  parseHrEmploymentCreateRecordBody,
  parseHrEmploymentCreateVersionBody,
  parseHrEmploymentDetailQuery,
  parseHrEmploymentEndRecordBody,
  parseHrEmploymentListQuery,
  parseHrEmploymentListResponse,
  parseHrEmploymentRecord,
  parseHrEmploymentRecordPath,
} from "@esbla/contracts";
import {
  type HrEmploymentRecordSettings,
  type HrServiceActivateBody,
  type HrServiceConfigureBody,
  type HrServiceControlQuery,
  type HrServiceDeactivateBody,
  parseHrServiceActivateBody,
  parseHrServiceConfigureBody,
  parseHrServiceControlQuery,
  parseHrServiceDeactivateBody,
} from "@esbla/contracts/hr-service-control-api";
import {
  activateEmploymentRecordService,
  configureEmploymentRecordService,
  createEmploymentRecord,
  createEmploymentRecordVersion,
  deactivateEmploymentRecordService,
  type EmploymentRecordDetailResult,
  type EmploymentRecordListResult,
  type EmploymentRecordVersionView,
  type EmploymentRecordView,
  endEmploymentRecord,
  getAuthorizedEmploymentRecordDetail,
  getEmploymentRecordServiceControl,
  listAuthorizedEmploymentRecords,
} from "@esbla/hr";
import type { OperationContext } from "@esbla/platform-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AuthError } from "./auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type EmploymentConfigureBody = Extract<
  HrServiceConfigureBody,
  { readonly settings: HrEmploymentRecordSettings }
>;

export interface RegisterEmploymentRoutesOptions {
  readonly authenticate: Authenticate;
  readonly migrationReadPool: Pool;
  readonly pool: Pool;
  readonly runtimeEnvironment: "development" | "production" | "test";
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

function parseEmploymentConfigureBody(value: unknown): EmploymentConfigureBody {
  const body = strict(parseHrServiceConfigureBody, value);
  if (!("effectiveRangeOverlapAllowed" in body.settings)) {
    throw requestContractViolation();
  }
  return body as EmploymentConfigureBody;
}

function versionResponse(version: EmploymentRecordVersionView): HrEmploymentRecordVersion {
  return {
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    employmentRecordVersionId: version.employmentRecordVersionId,
    employmentTypeCode: version.employmentTypeCode,
    kind: version.kind,
    organizationReference: version.organizationReference,
    positionReference: version.positionReference,
    rowVersion: version.rowVersion,
    supersedesVersionId: version.supersedesVersionId,
    terminal: version.terminal,
    version: version.version,
  };
}

function summaryResponse(record: EmploymentRecordView): HrEmploymentRecordSummary {
  return {
    createdAt: record.createdAt,
    currentVersion: record.currentVersion ? versionResponse(record.currentVersion) : null,
    employmentRecordId: record.employmentRecordId,
    status: record.status,
    version: record.version,
    workerProfileId: record.workerProfileId,
  };
}

function listResponse(result: EmploymentRecordListResult): HrEmploymentListResponse {
  return parseHrEmploymentListResponse({
    accessScope: result.accessScope,
    items: result.items.map(summaryResponse),
    nextCursor: result.nextCursor,
  });
}

function detailResponse(result: EmploymentRecordDetailResult): HrEmploymentRecord {
  return parseHrEmploymentRecord({
    ...summaryResponse(result),
    accessScope: result.accessScope,
    history: {
      items: result.history.items.map(versionResponse),
      nextCursor: result.history.nextCursor,
    },
  });
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

function idempotencyKey(request: FastifyRequest): string {
  return mutationContext(request).correlationId;
}

export function registerEmploymentRoutes({
  authenticate,
  migrationReadPool,
  pool,
  runtimeEnvironment,
  server,
}: RegisterEmploymentRoutesOptions): void {
  for (const schema of [
    hrEmploymentCreateRecordBodySchema,
    hrEmploymentCreateVersionBodySchema,
    hrEmploymentEndRecordBodySchema,
    hrEmploymentRecordPathSchema,
    hrEmploymentListQuerySchema,
    hrEmploymentDetailQuerySchema,
    hrEmploymentRecordSchema,
    hrEmploymentListResponseSchema,
  ]) {
    server.addSchema(schema);
  }

  server.get<{ Querystring: HrServiceControlQuery }>(
    "/v1/hr/employment-records/service-control",
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
    async (request) =>
      (await getEmploymentRecordServiceControl(pool, operationContext(request))).control,
  );

  server.post<{ Body: HrServiceActivateBody }>(
    "/v1/hr/employment-records/service-control/activate",
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
      const result = await activateEmploymentRecordService(
        pool,
        migrationReadPool,
        mutationContext(request),
        request.body,
        runtimeEnvironment === "production" ? "production" : "non_production",
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.control);
    },
  );

  server.post<{ Body: HrServiceDeactivateBody }>(
    "/v1/hr/employment-records/service-control/deactivate",
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
      const result = await deactivateEmploymentRecordService(
        pool,
        mutationContext(request),
        request.body,
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.control);
    },
  );

  server.patch<{ Body: EmploymentConfigureBody }>(
    "/v1/hr/employment-records/service-control/settings",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          parseEmploymentConfigureBody(request.body);
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
      const result = await configureEmploymentRecordService(
        pool,
        mutationContext(request),
        request.body,
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(result.control);
    },
  );

  server.get<{ Querystring: HrEmploymentListQuery }>(
    "/v1/hr/employment-records",
    {
      preHandler: [
        async (request) => {
          strict(parseHrEmploymentListQuery, request.query);
        },
      ],
      preValidation: [authenticate],
      schema: {
        querystring: { $ref: "HrEmploymentListQueryV1#" },
        response: {
          200: { $ref: "HrEmploymentListResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) =>
      listResponse(
        await listAuthorizedEmploymentRecords(pool, operationContext(request), {
          ...(request.query.cursorCreatedAt && request.query.cursorEmploymentRecordId
            ? {
                cursor: {
                  createdAt: request.query.cursorCreatedAt,
                  employmentRecordId: request.query.cursorEmploymentRecordId,
                },
              }
            : {}),
          ...(request.query.pageSize === undefined ? {} : { pageSize: request.query.pageSize }),
        }),
      ),
  );

  server.post<{ Body: HrEmploymentCreateRecordBody }>(
    "/v1/hr/employment-records",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrEmploymentCreateRecordBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrEmploymentCreateRecordRequestV1#" },
        response: {
          200: { $ref: "HrEmploymentRecordResponseV1#" },
          201: { $ref: "HrEmploymentRecordResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await createEmploymentRecord(pool, mutationContext(request), {
        ...request.body,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(detailResponse(result.record));
    },
  );

  server.get<{ Params: HrEmploymentRecordPath; Querystring: HrEmploymentDetailQuery }>(
    "/v1/hr/employment-records/by-id/:employmentRecordId",
    {
      preHandler: [
        async (request) => {
          strict(parseHrEmploymentDetailQuery, request.query);
        },
      ],
      preValidation: [
        authenticate,
        async (request) => {
          strict(parseHrEmploymentRecordPath, request.params);
        },
      ],
      schema: {
        params: { $ref: "HrEmploymentRecordPathV1#" },
        querystring: { $ref: "HrEmploymentDetailQueryV1#" },
        response: {
          200: { $ref: "HrEmploymentRecordResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) =>
      detailResponse(
        await getAuthorizedEmploymentRecordDetail(pool, operationContext(request), {
          ...(request.query.cursorVersion && request.query.cursorEmploymentRecordVersionId
            ? {
                cursor: {
                  employmentRecordVersionId: request.query.cursorEmploymentRecordVersionId,
                  version: request.query.cursorVersion,
                },
              }
            : {}),
          employmentRecordId: request.params.employmentRecordId,
          ...(request.query.pageSize === undefined ? {} : { pageSize: request.query.pageSize }),
        }),
      ),
  );

  server.post<{
    Body: HrEmploymentCreateVersionBody;
    Params: HrEmploymentRecordPath;
  }>(
    "/v1/hr/employment-records/:employmentRecordId/versions",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrEmploymentRecordPath, request.params);
          strict(parseHrEmploymentCreateVersionBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrEmploymentCreateVersionRequestV1#" },
        params: { $ref: "HrEmploymentRecordPathV1#" },
        response: {
          200: { $ref: "HrEmploymentRecordResponseV1#" },
          201: { $ref: "HrEmploymentRecordResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await createEmploymentRecordVersion(pool, mutationContext(request), {
        ...request.body,
        employmentRecordId: request.params.employmentRecordId,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(detailResponse(result.record));
    },
  );

  server.post<{ Body: HrEmploymentEndRecordBody; Params: HrEmploymentRecordPath }>(
    "/v1/hr/employment-records/:employmentRecordId/end",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrEmploymentRecordPath, request.params);
          strict(parseHrEmploymentEndRecordBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrEmploymentEndRecordRequestV1#" },
        params: { $ref: "HrEmploymentRecordPathV1#" },
        response: {
          200: { $ref: "HrEmploymentRecordResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await endEmploymentRecord(pool, mutationContext(request), {
        ...request.body,
        employmentRecordId: request.params.employmentRecordId,
        idempotencyKey: idempotencyKey(request),
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(detailResponse(result.record));
    },
  );
}
