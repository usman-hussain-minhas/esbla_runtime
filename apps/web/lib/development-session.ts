import "server-only";

import {
  type DevelopmentRequestInput,
  prepareDevelopmentRequest,
  readDevelopmentSessionConfig,
  summarizeDevelopmentSession,
} from "./development-session-core";

export function getServerDevelopmentSessionSummary() {
  return summarizeDevelopmentSession(process.env);
}

export async function fetchDevelopmentApi(input: DevelopmentRequestInput): Promise<Response> {
  const request = prepareDevelopmentRequest(readDevelopmentSessionConfig(process.env), input);
  return fetch(request.url, {
    ...(request.body === undefined ? {} : { body: request.body }),
    cache: "no-store",
    headers: request.headers,
    method: request.method,
  });
}
