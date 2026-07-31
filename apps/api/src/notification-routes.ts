import {
  type MarkAllOwnNotificationsReadBody,
  type MarkOwnNotificationReadBody,
  type PlatformNotificationListQuery,
  type PlatformNotificationPath,
  parseMarkAllOwnNotificationsReadBody,
  parseMarkAllOwnNotificationsReadResponse,
  parseMarkOwnNotificationReadBody,
  parseMarkOwnNotificationReadResponse,
  parseNotificationListQuery,
  parseNotificationPage,
  parsePlatformNotificationPath,
  platformNotificationListQuerySchema,
  platformNotificationMarkAllReadBodySchema,
  platformNotificationMarkAllReadResponseSchema,
  platformNotificationMarkReadBodySchema,
  platformNotificationMarkReadResponseSchema,
  platformNotificationPageSchema,
  platformNotificationPathSchema,
} from "@esbla/contracts";
import { verifyHrNotificationTargets } from "@esbla/hr";
import {
  listOwnNotifications,
  markAllOwnNotificationsRead,
  markOwnNotificationRead,
  type OperationContext,
} from "@esbla/platform-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AuthError } from "./auth.js";

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RegisterNotificationRoutesOptions {
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

function listQuery(value: unknown): PlatformNotificationListQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return strict(parseNotificationListQuery, value);
  }
  const query = value as Readonly<Record<string, unknown>>;
  return strict(parseNotificationListQuery, {
    ...query,
    ...(typeof query.pageSize === "string" && /^[1-9]\d*$/.test(query.pageSize)
      ? { pageSize: Number(query.pageSize) }
      : {}),
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

export function registerNotificationRoutes({
  authenticate,
  pool,
  server,
}: RegisterNotificationRoutesOptions): void {
  for (const schema of [
    platformNotificationListQuerySchema,
    platformNotificationMarkAllReadBodySchema,
    platformNotificationMarkAllReadResponseSchema,
    platformNotificationMarkReadBodySchema,
    platformNotificationMarkReadResponseSchema,
    platformNotificationPageSchema,
    platformNotificationPathSchema,
  ]) {
    server.addSchema(schema);
  }

  server.get<{ Querystring: PlatformNotificationListQuery }>(
    "/v1/platform/notifications",
    {
      preValidation: [
        authenticate,
        async (request) => {
          listQuery(request.query);
        },
      ],
      schema: {
        querystring: { $ref: "PlatformNotificationListQueryV1#" },
        response: {
          200: { $ref: "PlatformNotificationPageV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request) =>
      parseNotificationPage(
        await listOwnNotifications(
          pool,
          operationContext(request),
          listQuery(request.query),
          verifyHrNotificationTargets,
        ),
      ),
  );

  server.post<{
    Body: MarkAllOwnNotificationsReadBody;
  }>(
    "/v1/platform/notifications/mark-all-read",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parseMarkAllOwnNotificationsReadBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "PlatformNotificationMarkAllReadBodyV1#" },
        response: {
          200: { $ref: "PlatformNotificationMarkAllReadResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = parseMarkAllOwnNotificationsReadResponse(
        await markAllOwnNotificationsRead(
          pool,
          mutationContext(request),
          strict(parseMarkAllOwnNotificationsReadBody, request.body),
        ),
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return result;
    },
  );

  server.post<{
    Body: MarkOwnNotificationReadBody;
    Params: PlatformNotificationPath;
  }>(
    "/v1/platform/notifications/:notificationId/read",
    {
      preValidation: [
        authenticate,
        async (request) => {
          mutationContext(request);
          strict(parsePlatformNotificationPath, request.params);
          strict(parseMarkOwnNotificationReadBody, request.body);
        },
      ],
      schema: {
        body: { $ref: "PlatformNotificationMarkReadBodyV1#" },
        params: { $ref: "PlatformNotificationPathV1#" },
        response: {
          200: { $ref: "PlatformNotificationMarkReadResponseV1#" },
          default: { $ref: "ProblemDetails#" },
        },
      },
    },
    async (request, reply) => {
      const result = parseMarkOwnNotificationReadResponse(
        await markOwnNotificationRead(
          pool,
          mutationContext(request),
          strict(parsePlatformNotificationPath, request.params).notificationId,
          strict(parseMarkOwnNotificationReadBody, request.body),
          verifyHrNotificationTargets,
        ),
      );
      reply.header("idempotent-replayed", String(result.replayed));
      return result;
    },
  );
}
