import {
  EmploymentError,
  HrLeaveError,
  HrShiftAssignmentError,
  HrWorkforceProfileError,
} from "@esbla/hr";
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

const MAX_PROBLEM_DETAIL_LENGTH = 256;
const MAX_PROBLEM_INSTANCE_LENGTH = 256;

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
}

function boundedProblemDetail(value: string): string {
  const sanitized = [...value]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return (sanitized || "The request could not be completed.").slice(0, MAX_PROBLEM_DETAIL_LENGTH);
}

function isUnsafeInstanceCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    character === "?" || character === "#" || codePoint === 32 || isControlCharacter(character)
  );
}

function problemInstance(request: FastifyRequest): string {
  const route = request.routeOptions.url;
  if (
    typeof route !== "string" ||
    route.length > MAX_PROBLEM_INSTANCE_LENGTH ||
    !route.startsWith("/") ||
    route.startsWith("//") ||
    [...route].some(isUnsafeInstanceCharacter)
  ) {
    return "/";
  }
  return route;
}

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
  if (error instanceof EmploymentError) {
    if (error.code === "EMPLOYMENT_INPUT_INVALID") return 400;
    if (
      error.code === "EMPLOYMENT_NOT_FOUND" ||
      error.code === "EMPLOYMENT_SERVICE_CONTROL_NOT_FOUND"
    ) {
      return 404;
    }
    if (
      error.code === "EMPLOYMENT_DEPENDENCY_INACTIVE" ||
      error.code === "EMPLOYMENT_SERVICE_INACTIVE"
    ) {
      return 503;
    }
    return 409;
  }
  if (error instanceof HrWorkforceProfileError) {
    if (error.code === "WORKFORCE_INPUT_INVALID") return 400;
    if (
      error.code === "WORKFORCE_PROFILE_NOT_FOUND" ||
      error.code === "WORKFORCE_SERVICE_CONTROL_NOT_FOUND"
    ) {
      return 404;
    }
    if (error.code === "WORKFORCE_PRINCIPAL_INELIGIBLE") return 422;
    if (error.code === "WORKFORCE_SERVICE_INACTIVE") return 503;
    return 409;
  }
  if (error instanceof HrShiftAssignmentError) {
    if (error.code === "SHIFT_INPUT_INVALID") return 400;
    if (error.code === "SHIFT_NOT_FOUND") return 404;
    if (error.code === "SHIFT_DEPENDENCY_INACTIVE" || error.code === "SHIFT_SERVICE_INACTIVE") {
      return 503;
    }
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
    if (error.code === "ACTIVATION_DEPENDENCY_BLOCKED") return 503;
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
    error instanceof EmploymentError ||
    error instanceof HrLeaveError ||
    error instanceof HrShiftAssignmentError ||
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
  const detail = boundedProblemDetail(
    (error as FastifyError).validation !== undefined
      ? "Request did not match the API contract."
      : status === 500
        ? "The server could not complete the request."
        : error.message,
  );
  reply
    .code(status)
    .type("application/problem+json")
    .send({
      code,
      detail,
      instance: problemInstance(request),
      requestId,
      status,
      title: STATUS_TITLES[status] ?? "Request Failed",
      type: `urn:esbla:problem:${code.toLowerCase()}`,
    });
}
