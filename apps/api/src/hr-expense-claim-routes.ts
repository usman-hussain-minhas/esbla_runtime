import {
  type HrExpenseClaimCreateBody,
  type HrExpenseClaimEditDraftBody,
  type HrExpenseClaimPath,
  type HrExpenseClaimSubmitBody,
  hrExpenseClaimCreateBodySchema,
  hrExpenseClaimEditDraftBodySchema,
  hrExpenseClaimPathSchema,
  hrExpenseClaimResponseSchema,
  hrExpenseClaimSubmitBodySchema,
  parseHrExpenseClaimCreateBody,
  parseHrExpenseClaimEditDraftBody,
  parseHrExpenseClaimPath,
  parseHrExpenseClaimResponse,
  parseHrExpenseClaimSubmitBody,
} from "@esbla/contracts/hr-expense-claim-api";
import {
  type HrExpenseClaimSettings,
  type HrServiceActivateBody,
  type HrServiceConfigureBody,
  type HrServiceControlQuery,
  type HrServiceDeactivateBody,
  parseHrServiceActivateBody,
  parseHrServiceConfigureBody,
  parseHrServiceControl,
  parseHrServiceControlQuery,
  parseHrServiceDeactivateBody,
} from "@esbla/contracts/hr-service-control-api";
import {
  activateExpenseClaimService,
  configureExpenseClaimService,
  createExpenseClaim,
  deactivateExpenseClaimService,
  editExpenseClaimDraft,
  getExpenseClaimServiceControl,
  inspectExpenseClaimServiceControlAuthority,
  submitExpenseClaim,
} from "@esbla/hr";
import type { OperationContext } from "@esbla/platform-core";
import { workspaceManifest } from "@esbla/workspace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AuthError } from "./auth.js";

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type ExpenseClaimConfigureBody = Extract<
  HrServiceConfigureBody,
  { readonly settings: HrExpenseClaimSettings }
>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_ROUTE = "/v1/hr/expense-claims/service-control";

export interface RegisterExpenseClaimRoutesOptions {
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

function expenseClaimConfigureBody(value: unknown): ExpenseClaimConfigureBody {
  const body = strict(parseHrServiceConfigureBody, value);
  if (!("categoryCodes" in body.settings) || !("rejectionNoteRequired" in body.settings)) {
    throw requestContractViolation();
  }
  return body as ExpenseClaimConfigureBody;
}

export function registerExpenseClaimRoutes({
  authenticate,
  migrationReadPool,
  pool,
  runtimeEnvironment,
  server,
}: RegisterExpenseClaimRoutesOptions): void {
  for (const schema of [
    hrExpenseClaimCreateBodySchema,
    hrExpenseClaimEditDraftBodySchema,
    hrExpenseClaimPathSchema,
    hrExpenseClaimResponseSchema,
    hrExpenseClaimSubmitBodySchema,
  ]) {
    server.addSchema(schema);
  }
  const attachExpenseClaimActions = async (request: FastifyRequest, reply: FastifyReply) => {
    const actions = await inspectExpenseClaimServiceControlAuthority(
      pool,
      operationContext(request),
    );
    reply.header("x-esbla-expense-actions", JSON.stringify(actions));
  };

  server.post<{ Body: HrExpenseClaimCreateBody }>(
    "/v1/hr/expense-claims",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrExpenseClaimCreateBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrExpenseCreateRequestV1#" },
        response: {
          200: { $ref: "HrExpenseClaimResponseV1#" },
          201: { $ref: "HrExpenseClaimResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await createExpenseClaim(pool, context, {
        ...strict(parseHrExpenseClaimCreateBody, request.body),
        idempotencyKey: context.correlationId,
      });
      reply.header("idempotent-replayed", String(result.replayed));
      return reply
        .code(result.replayed ? 200 : 201)
        .send(parseHrExpenseClaimResponse(result.expenseClaim));
    },
  );

  server.patch<{
    Body: HrExpenseClaimEditDraftBody;
    Params: HrExpenseClaimPath;
  }>(
    "/v1/hr/expense-claims/:expenseClaimId/draft",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrExpenseClaimPath, request.params);
          strict(parseHrExpenseClaimEditDraftBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrExpenseEditDraftRequestV1#" },
        params: { $ref: "HrExpenseClaimPathV1#" },
        response: {
          200: { $ref: "HrExpenseClaimResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await editExpenseClaimDraft(
        pool,
        context,
        strict(parseHrExpenseClaimPath, request.params).expenseClaimId,
        {
          ...strict(parseHrExpenseClaimEditDraftBody, request.body),
          idempotencyKey: context.correlationId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrExpenseClaimResponse(result.expenseClaim));
    },
  );

  server.post<{
    Body: HrExpenseClaimSubmitBody;
    Params: HrExpenseClaimPath;
  }>(
    "/v1/hr/expense-claims/:expenseClaimId/submit",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseHrExpenseClaimPath, request.params);
          strict(parseHrExpenseClaimSubmitBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "HrExpenseSubmitRequestV1#" },
        params: { $ref: "HrExpenseClaimPathV1#" },
        response: {
          200: { $ref: "HrExpenseClaimResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const context = mutationContext(request);
      const result = await submitExpenseClaim(
        pool,
        context,
        strict(parseHrExpenseClaimPath, request.params).expenseClaimId,
        {
          ...strict(parseHrExpenseClaimSubmitBody, request.body),
          idempotencyKey: context.correlationId,
        },
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrExpenseClaimResponse(result.expenseClaim));
    },
  );

  server.get<{ Querystring: HrServiceControlQuery }>(
    CONTROL_ROUTE,
    {
      preValidation: [
        authenticate,
        async (request) => {
          strict(parseHrServiceControlQuery, request.query);
        },
        attachExpenseClaimActions,
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
            (await getExpenseClaimServiceControl(pool, operationContext(request))).control,
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
      const result = await activateExpenseClaimService(
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
      const result = await deactivateExpenseClaimService(
        pool,
        mutationContext(request),
        request.body,
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );

  server.patch<{ Body: ExpenseClaimConfigureBody }>(
    `${CONTROL_ROUTE}/settings`,
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          expenseClaimConfigureBody(request.body);
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
      const result = await configureExpenseClaimService(
        pool,
        mutationContext(request),
        expenseClaimConfigureBody(request.body),
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return reply.code(200).send(parseHrServiceControl(result.control));
    },
  );
}
