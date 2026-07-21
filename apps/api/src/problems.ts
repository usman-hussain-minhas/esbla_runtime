import { HrLeaveError, HrWorkforceProfileError } from "@esbla/hr";
import { PlatformError } from "@esbla/platform-core";
import { WorkspaceTaskError } from "@esbla/workspace";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AuthError } from "./auth.js";

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

function statusForError(error: Error): number {
  if ((error as FastifyError).validation) return 400;
  if (error instanceof AuthError) return 401;
  if (error instanceof HrLeaveError) {
    if (error.code === "LEAVE_INPUT_INVALID") return 400;
    if (error.code === "LEAVE_NOT_FOUND") return 404;
    if (error.code === "LEAVE_MANAGER_REQUIRED") return 422;
    if (error.code === "LEAVE_SERVICE_INACTIVE") return 503;
    return 409;
  }
  if (error instanceof HrWorkforceProfileError) {
    if (error.code === "WORKFORCE_PROFILE_INPUT_INVALID") return 400;
    if (error.code === "WORKFORCE_PROFILE_NOT_FOUND") return 404;
    if (error.code === "WORKFORCE_PROFILE_PRINCIPAL_UNAVAILABLE") return 422;
    if (error.code === "WORKFORCE_PROFILE_SERVICE_INACTIVE") return 503;
    return 409;
  }
  if (error instanceof WorkspaceTaskError) {
    if (error.code === "WORKSPACE_TASK_INPUT_INVALID") return 400;
    if (error.code === "WORKSPACE_TASK_NOT_FOUND") return 404;
    if (error.code === "WORKSPACE_TASK_SERVICE_INACTIVE") return 503;
    if (error.code === "WORKSPACE_TASK_VERSION_CONFLICT") return 409;
    return 409;
  }
  if (error instanceof PlatformError) {
    if (error.code === "POLICY_DENIED" || error.code === "ACTOR_NOT_ACTIVE_MEMBER") return 403;
    if (error.code === "INVALID_OPERATION_CONTEXT") return 400;
    if (error.code === "SETTING_INVALID" || error.code === "SETTING_OVERRIDE_NOT_ALLOWED") {
      return 503;
    }
    return 409;
  }
  return 500;
}

function codeForError(error: Error): string {
  if ((error as FastifyError).validation) return "REQUEST_VALIDATION_FAILED";
  if (
    error instanceof AuthError ||
    error instanceof HrLeaveError ||
    error instanceof HrWorkforceProfileError ||
    error instanceof WorkspaceTaskError ||
    error instanceof PlatformError
  ) {
    return error.code;
  }
  return "UNEXPECTED_SERVER_ERROR";
}

export function sendProblem(caught: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const error = caught instanceof Error ? caught : new Error("Unknown server failure");
  const status = statusForError(error);
  const code = codeForError(error);
  const requestId = request.authenticatedRequestId ?? request.id;
  if (status === 500) request.log.error({ err: error }, "unexpected request failure");
  const detail =
    (error as FastifyError).validation !== undefined
      ? "Request did not match the API contract."
      : status === 500
        ? "The server could not complete the request."
        : error.message;
  reply
    .code(status)
    .header("x-request-id", requestId)
    .type("application/problem+json")
    .send({
      code,
      detail,
      instance: request.url,
      requestId,
      status,
      title: STATUS_TITLES[status] ?? "Request Failed",
      type: `urn:esbla:problem:${code.toLowerCase()}`,
    });
}
