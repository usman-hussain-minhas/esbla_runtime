import {
  type HrServiceActivateBody,
  type HrServiceConfigureBody,
  type HrServiceControlQuery,
  type HrServiceDeactivateBody,
  type HrTimesheetSettings,
  parseHrServiceActivateBody,
  parseHrServiceConfigureBody,
  parseHrServiceControl,
  parseHrServiceControlQuery,
  parseHrServiceDeactivateBody,
} from "@esbla/contracts/hr-service-control-api";
import {
  type HrTimesheetApproveBody,
  type HrTimesheetAssignedListQuery,
  type HrTimesheetCreateBody,
  type HrTimesheetCreateCorrectionBody,
  type HrTimesheetDetailQuery,
  type HrTimesheetEditDraftBody,
  type HrTimesheetOwnListQuery,
  type HrTimesheetPath,
  type HrTimesheetRejectBody,
  type HrTimesheetSubmitBody,
  hrTimesheetApproveBodySchema,
  hrTimesheetAssignedListQuerySchema,
  hrTimesheetCreateBodySchema,
  hrTimesheetCreateCorrectionBodySchema,
  hrTimesheetDetailQuerySchema,
  hrTimesheetEditDraftBodySchema,
  hrTimesheetListResponseSchema,
  hrTimesheetOwnListQuerySchema,
  hrTimesheetPathSchema,
  hrTimesheetRejectBodySchema,
  hrTimesheetResponseSchema,
  hrTimesheetSubmitBodySchema,
  parseHrTimesheetApproveBody,
  parseHrTimesheetAssignedListQuery,
  parseHrTimesheetCreateBody,
  parseHrTimesheetCreateCorrectionBody,
  parseHrTimesheetDetailQuery,
  parseHrTimesheetEditDraftBody,
  parseHrTimesheetListResponse,
  parseHrTimesheetOwnListQuery,
  parseHrTimesheetPath,
  parseHrTimesheetRejectBody,
  parseHrTimesheetResponse,
  parseHrTimesheetSubmitBody,
} from "@esbla/contracts/hr-timesheet-api";
import {
  activateTimesheetService,
  approveTimesheet,
  configureTimesheetService,
  createTimesheet,
  createTimesheetCorrection,
  deactivateTimesheetService,
  editTimesheetDraft,
  getAuthorizedTimesheetDetail,
  getTimesheetServiceControl,
  inspectTimesheetActionAuthority,
  listAssignedTimesheets,
  listOwnTimesheets,
  rejectTimesheet,
  submitTimesheet,
} from "@esbla/hr";
import type { OperationContext } from "@esbla/platform-core";
import { workspaceManifest } from "@esbla/workspace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AuthError } from "./auth.js";

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type TimesheetConfigureBody = Extract<
  HrServiceConfigureBody,
  { readonly settings: HrTimesheetSettings }
>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_ROUTE = "/v1/hr/timesheets/service-control";

export interface RegisterTimesheetRoutesOptions {
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

function queryIntegers(value: unknown, fields: readonly string[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const query = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(query).map(([key, selected]) => [
      key,
      fields.includes(key) && typeof selected === "string" && /^[1-9]\d*$/.test(selected)
        ? Number(selected)
        : selected,
    ]),
  );
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

function timesheetConfigureBody(value: unknown): TimesheetConfigureBody {
  const body = strict(parseHrServiceConfigureBody, value);
  if (
    !("maxDailyMinutes" in body.settings) ||
    !("periodCadence" in body.settings) ||
    !("rejectionNoteRequired" in body.settings)
  ) {
    throw requestContractViolation();
  }
  return body as TimesheetConfigureBody;
}

export function registerTimesheetRoutes({
  authenticate,
  migrationReadPool,
  pool,
  runtimeEnvironment,
  server,
}: RegisterTimesheetRoutesOptions): void {
  for (const schema of [
    hrTimesheetApproveBodySchema,
    hrTimesheetCreateBodySchema,
    hrTimesheetCreateCorrectionBodySchema,
    hrTimesheetDetailQuerySchema,
    hrTimesheetEditDraftBodySchema,
    hrTimesheetAssignedListQuerySchema,
    hrTimesheetListResponseSchema,
    hrTimesheetOwnListQuerySchema,
    hrTimesheetRejectBodySchema,
    hrTimesheetSubmitBodySchema,
    hrTimesheetPathSchema,
    hrTimesheetResponseSchema,
  ]) {
    server.addSchema(schema);
  }
  const attachTimesheetActions = async (request: FastifyRequest, reply: FastifyReply) => {
    const actions = await inspectTimesheetActionAuthority(pool, operationContext(request));
    reply.header("x-esbla-timesheet-actions", JSON.stringify(actions));
  };

  server.post<{ Body: HrTimesheetCreateBody }>(
    "/v1/hr/timesheets",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrTimesheetCreateBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrTimesheetCreateRequestV1#" },
        response: {
          200: { $ref: "HrTimesheetResponseV1#" },
          201: { $ref: "HrTimesheetResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = await createTimesheet(pool, mutationContext(request), {
        ...strict(parseHrTimesheetCreateBody, request.body),
        idempotencyKey: mutationContext(request).correlationId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply
        .code(result.replayed ? 200 : 201)
        .send(parseHrTimesheetResponse(result.timesheet));
    },
  );

  server.patch<{
    Body: HrTimesheetEditDraftBody;
    Params: HrTimesheetPath;
  }>(
    "/v1/hr/timesheets/:timesheetId/draft",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrTimesheetPath, request.params);
          strict(parseHrTimesheetEditDraftBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrTimesheetEditDraftRequestV1#" },
        params: { $ref: "HrTimesheetPathV1#" },
        response: {
          200: { $ref: "HrTimesheetResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await editTimesheetDraft(
        pool,
        context,
        strict(parseHrTimesheetPath, request.params).timesheetId,
        {
          ...strict(parseHrTimesheetEditDraftBody, request.body),
          idempotencyKey: context.correlationId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrTimesheetResponse(result.timesheet));
    },
  );

  server.post<{
    Body: HrTimesheetSubmitBody;
    Params: HrTimesheetPath;
  }>(
    "/v1/hr/timesheets/:timesheetId/submit",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrTimesheetPath, request.params);
          strict(parseHrTimesheetSubmitBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrTimesheetSubmitRequestV1#" },
        params: { $ref: "HrTimesheetPathV1#" },
        response: {
          200: { $ref: "HrTimesheetResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await submitTimesheet(
        pool,
        context,
        strict(parseHrTimesheetPath, request.params).timesheetId,
        {
          ...strict(parseHrTimesheetSubmitBody, request.body),
          idempotencyKey: context.correlationId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrTimesheetResponse(result.timesheet));
    },
  );

  server.post<{
    Body: HrTimesheetCreateCorrectionBody;
    Params: HrTimesheetPath;
  }>(
    "/v1/hr/timesheets/:timesheetId/corrections",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrTimesheetPath, request.params);
          strict(parseHrTimesheetCreateCorrectionBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrTimesheetCreateCorrectionRequestV1#" },
        params: { $ref: "HrTimesheetPathV1#" },
        response: {
          200: { $ref: "HrTimesheetResponseV1#" },
          201: { $ref: "HrTimesheetResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await createTimesheetCorrection(
        pool,
        context,
        strict(parseHrTimesheetPath, request.params).timesheetId,
        {
          ...strict(parseHrTimesheetCreateCorrectionBody, request.body),
          idempotencyKey: context.correlationId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply
        .code(result.replayed ? 200 : 201)
        .send(parseHrTimesheetResponse(result.timesheet));
    },
  );

  server.post<{
    Body: HrTimesheetApproveBody;
    Params: HrTimesheetPath;
  }>(
    "/v1/hr/timesheets/:timesheetId/approve",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrTimesheetPath, request.params);
          strict(parseHrTimesheetApproveBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrTimesheetApproveRequestV1#" },
        params: { $ref: "HrTimesheetPathV1#" },
        response: {
          200: { $ref: "HrTimesheetResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await approveTimesheet(
        pool,
        context,
        strict(parseHrTimesheetPath, request.params).timesheetId,
        {
          ...strict(parseHrTimesheetApproveBody, request.body),
          idempotencyKey: context.correlationId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrTimesheetResponse(result.timesheet));
    },
  );

  server.post<{
    Body: HrTimesheetRejectBody;
    Params: HrTimesheetPath;
  }>(
    "/v1/hr/timesheets/:timesheetId/reject",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrTimesheetPath, request.params);
          strict(parseHrTimesheetRejectBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrTimesheetRejectRequestV1#" },
        params: { $ref: "HrTimesheetPathV1#" },
        response: {
          200: { $ref: "HrTimesheetResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await rejectTimesheet(
        pool,
        context,
        strict(parseHrTimesheetPath, request.params).timesheetId,
        {
          ...strict(parseHrTimesheetRejectBody, request.body),
          idempotencyKey: context.correlationId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrTimesheetResponse(result.timesheet));
    },
  );

  server.get<{ Querystring: HrTimesheetOwnListQuery }>(
    "/v1/hr/timesheets/own",
    {
      preValidation: [
        authenticate,
        async (request) => {
          request.query = strict(
            parseHrTimesheetOwnListQuery,
            queryIntegers(request.query, ["pageSize"]),
          );
        },
        attachTimesheetActions,
      ],
      schema: {
        querystring: { $ref: "HrTimesheetOwnListQueryV1#" },
        response: {
          200: { $ref: "HrTimesheetListResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(200)
        .send(
          parseHrTimesheetListResponse(
            await listOwnTimesheets(pool, operationContext(request), request.query),
          ),
        ),
  );

  server.get<{ Querystring: HrTimesheetAssignedListQuery }>(
    "/v1/hr/timesheets/assigned",
    {
      preValidation: [
        authenticate,
        async (request) => {
          request.query = strict(
            parseHrTimesheetAssignedListQuery,
            queryIntegers(request.query, ["pageSize"]),
          );
        },
        attachTimesheetActions,
      ],
      schema: {
        querystring: { $ref: "HrTimesheetAssignedListQueryV1#" },
        response: {
          200: { $ref: "HrTimesheetListResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(200)
        .send(
          parseHrTimesheetListResponse(
            await listAssignedTimesheets(pool, operationContext(request), request.query),
          ),
        ),
  );

  server.get<{ Params: HrTimesheetPath; Querystring: HrTimesheetDetailQuery }>(
    "/v1/hr/timesheets/by-id/:timesheetId",
    {
      preValidation: [
        authenticate,
        async (request) => {
          strict(parseHrTimesheetPath, request.params);
          request.query = strict(
            parseHrTimesheetDetailQuery,
            queryIntegers(request.query, ["cursorVersion", "pageSize"]),
          );
        },
        attachTimesheetActions,
      ],
      schema: {
        params: { $ref: "HrTimesheetPathV1#" },
        querystring: { $ref: "HrTimesheetDetailQueryV1#" },
        response: {
          200: { $ref: "HrTimesheetResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(200)
        .send(
          parseHrTimesheetResponse(
            await getAuthorizedTimesheetDetail(
              pool,
              operationContext(request),
              strict(parseHrTimesheetPath, request.params).timesheetId,
              request.query,
            ),
          ),
        ),
  );

  server.get<{ Querystring: HrServiceControlQuery }>(
    CONTROL_ROUTE,
    {
      preValidation: [
        authenticate,
        async (request) => {
          strict(parseHrServiceControlQuery, request.query);
        },
        attachTimesheetActions,
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
            (await getTimesheetServiceControl(pool, operationContext(request))).control,
          ),
        ),
  );

  server.post<{ Body: HrServiceActivateBody }>(
    `${CONTROL_ROUTE}/activate`,
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
      const result = await activateTimesheetService(
        pool,
        migrationReadPool,
        mutationContext(request),
        request.body,
        runtimeEnvironment === "production" ? "production" : "non_production",
        workspaceManifest,
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );

  server.post<{ Body: HrServiceDeactivateBody }>(
    `${CONTROL_ROUTE}/deactivate`,
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
      const result = await deactivateTimesheetService(pool, mutationContext(request), request.body);
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );

  server.patch<{ Body: TimesheetConfigureBody }>(
    `${CONTROL_ROUTE}/settings`,
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          timesheetConfigureBody(request.body);
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
      const result = await configureTimesheetService(
        pool,
        mutationContext(request),
        timesheetConfigureBody(request.body),
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );
}
