import Fastify, { type FastifyInstance } from "fastify";

export function createServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/health", async () => ({ status: "ok" }));
  server.get("/ready", async () => ({ status: "ready" }));

  return server;
}
